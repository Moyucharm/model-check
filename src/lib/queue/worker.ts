// Detection worker for Redis(BullMQ) and in-memory queue modes.

import { Worker, Job } from "bullmq";
import prisma from "@/lib/prisma";
import { createRedisDuplicate, getRedisClient, isRedisConfigured } from "@/lib/redis";
import { executeDetection, sleep, randomDelay } from "@/lib/detection/detector";
import { persistDetectionResult } from "@/lib/detection/model-state";
import type { DetectionJobData, DetectionResult } from "@/lib/detection/types";
import { DETECTION_QUEUE_NAME } from "./constants";
import {
  isDetectionStopped,
  pullNextMemoryJob,
  completeMemoryJob,
  hasPendingMemoryJobs,
  hasPendingJobsForModel,
} from "./queue";
import { publishProgress } from "./progress-bus";

// Worker configuration (from environment variables)
const WORKER_CONCURRENCY = 50;
const SEMAPHORE_POLL_MS = 500;
const SEMAPHORE_TTL = 120;
const CONFIG_CACHE_TTL_MS = 5000;

interface WorkerRuntimeConfig {
  channelConcurrency: number;
  maxGlobalConcurrency: number;
  minDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_WORKER_CONFIG: WorkerRuntimeConfig = {
  channelConcurrency: parseInt(process.env.CHANNEL_CONCURRENCY || "5", 10),
  maxGlobalConcurrency: parseInt(process.env.MAX_GLOBAL_CONCURRENCY || "30", 10),
  minDelayMs: parseInt(process.env.DETECTION_MIN_DELAY_MS || "3000", 10),
  maxDelayMs: parseInt(process.env.DETECTION_MAX_DELAY_MS || "5000", 10),
};

// Persist worker state across HMR (same pattern as prisma.ts)
interface WorkerState {
  worker: Worker<DetectionJobData, DetectionResult> | null;
  memoryWorkerRunning: boolean;
  memoryTickTimer: NodeJS.Timeout | null;
  memoryRunningJobs: Set<string>;
  memoryChannelActiveCounts: Map<string, number>;
  cachedConfig: WorkerRuntimeConfig | null;
  cachedAt: number;
  loadingConfigPromise: Promise<WorkerRuntimeConfig> | null;
}

const globalForWorker = globalThis as unknown as {
  __workerState?: WorkerState;
};

if (!globalForWorker.__workerState) {
  globalForWorker.__workerState = {
    worker: null,
    memoryWorkerRunning: false,
    memoryTickTimer: null,
    memoryRunningJobs: new Set<string>(),
    memoryChannelActiveCounts: new Map<string, number>(),
    cachedConfig: null,
    cachedAt: 0,
    loadingConfigPromise: null,
  };
}

const ws = globalForWorker.__workerState;

// Redis keys
const GLOBAL_SEMAPHORE_KEY = "detection:semaphore:global";

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.floor(value);
  return parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.floor(value);
  return parsed >= 0 ? parsed : fallback;
}

function normalizeConfig(config: Partial<WorkerRuntimeConfig>): WorkerRuntimeConfig {
  const minDelayMs = parseNonNegativeInt(config.minDelayMs, DEFAULT_WORKER_CONFIG.minDelayMs);
  const maxDelayMsRaw = parseNonNegativeInt(config.maxDelayMs, DEFAULT_WORKER_CONFIG.maxDelayMs);
  const maxDelayMs = Math.max(maxDelayMsRaw, minDelayMs);

  return {
    channelConcurrency: parsePositiveInt(config.channelConcurrency, DEFAULT_WORKER_CONFIG.channelConcurrency),
    maxGlobalConcurrency: parsePositiveInt(config.maxGlobalConcurrency, DEFAULT_WORKER_CONFIG.maxGlobalConcurrency),
    minDelayMs,
    maxDelayMs,
  };
}

async function loadWorkerConfig(): Promise<WorkerRuntimeConfig> {
  const now = Date.now();
  if (ws.cachedConfig && now - ws.cachedAt < CONFIG_CACHE_TTL_MS) {
    return ws.cachedConfig;
  }

  if (!ws.loadingConfigPromise) {
    ws.loadingConfigPromise = (async () => {
      try {
        const dbConfig = await prisma.schedulerConfig.findUnique({
          where: { id: "default" },
          select: {
            channelConcurrency: true,
            maxGlobalConcurrency: true,
            minDelayMs: true,
            maxDelayMs: true,
          },
        });

        const resolvedConfig = dbConfig
          ? normalizeConfig(dbConfig)
          : normalizeConfig(DEFAULT_WORKER_CONFIG);

        ws.cachedConfig = resolvedConfig;
        ws.cachedAt = Date.now();
        return resolvedConfig;
      } catch {
        const fallbackConfig = ws.cachedConfig ?? normalizeConfig(DEFAULT_WORKER_CONFIG);
        ws.cachedConfig = fallbackConfig;
        ws.cachedAt = Date.now();
        return fallbackConfig;
      } finally {
        ws.loadingConfigPromise = null;
      }
    })();
  }

  return ws.loadingConfigPromise;
}

export function reloadWorkerConfig(): void {
  ws.cachedConfig = null;
  ws.cachedAt = 0;
}

function channelSemaphoreKey(channelId: string): string {
  return `detection:semaphore:channel:${channelId}`;
}

async function acquireSlots(channelId: string, config: WorkerRuntimeConfig): Promise<void> {
  if (!isRedisConfigured) {
    return;
  }

  const redis = getRedisClient();
  const channelKey = channelSemaphoreKey(channelId);

  while (true) {
    const globalCount = await redis.incr(GLOBAL_SEMAPHORE_KEY);
    if (globalCount > config.maxGlobalConcurrency) {
      await redis.decr(GLOBAL_SEMAPHORE_KEY);
      await sleep(SEMAPHORE_POLL_MS);
      continue;
    }
    await redis.expire(GLOBAL_SEMAPHORE_KEY, SEMAPHORE_TTL);

    const channelCount = await redis.incr(channelKey);
    if (channelCount > config.channelConcurrency) {
      await redis.decr(channelKey);
      await redis.decr(GLOBAL_SEMAPHORE_KEY);
      await sleep(SEMAPHORE_POLL_MS);
      continue;
    }
    await redis.expire(channelKey, SEMAPHORE_TTL);

    return;
  }
}

async function releaseSlots(channelId: string): Promise<void> {
  if (!isRedisConfigured) {
    return;
  }

  const redis = getRedisClient();
  const channelKey = channelSemaphoreKey(channelId);

  const pipeline = redis.pipeline();
  pipeline.decr(channelKey);
  pipeline.decr(GLOBAL_SEMAPHORE_KEY);
  const results = await pipeline.exec();

  const channelVal = (results?.[0]?.[1] as number) ?? 0;
  const globalVal = (results?.[1]?.[1] as number) ?? 0;

  if (channelVal <= 0) {
    await redis.del(channelKey);
  }
  if (globalVal <= 0) {
    await redis.del(GLOBAL_SEMAPHORE_KEY);
  }
}

function buildStoppedResult(data: DetectionJobData): DetectionResult {
  return {
    status: "FAIL",
    latency: 0,
    endpointType: data.endpointType,
    errorMsg: "Detection stopped by user",
  };
}

async function runDetectionPipeline(
  data: DetectionJobData,
  jobId?: string,
  useRedisSemaphore: boolean = false
): Promise<DetectionResult> {
  const runtimeConfig = await loadWorkerConfig();

  if (await isDetectionStopped()) {
    return buildStoppedResult(data);
  }

  if (useRedisSemaphore) {
    await acquireSlots(data.channelId, runtimeConfig);
  }

  try {
    if (await isDetectionStopped()) {
      return buildStoppedResult(data);
    }

    const delay = randomDelay(runtimeConfig.minDelayMs, runtimeConfig.maxDelayMs);
    await sleep(delay);

    const result = await executeDetection(data);
    await persistDetectionResult(data, result);

    const isModelComplete = !(await hasPendingJobsForModel(data.modelId, jobId));

    await publishProgress({
      channelId: data.channelId,
      modelId: data.modelId,
      modelName: data.modelName,
      endpointType: data.endpointType,
      status: result.status,
      latency: result.latency,
      timestamp: Date.now(),
      isModelComplete,
    });

    console.log(`[worker] ${data.modelName}/${data.endpointType} → ${result.status} (${result.latency}ms)`);

    return result;
  } catch (error) {
    const failResult: DetectionResult = {
      status: "FAIL",
      latency: 0,
      endpointType: data.endpointType,
      errorMsg: error instanceof Error ? error.message : "Detection execution failed",
    };

    try {
      await persistDetectionResult(data, failResult);
      const isModelComplete = !(await hasPendingJobsForModel(data.modelId, jobId));
      await publishProgress({
        channelId: data.channelId,
        modelId: data.modelId,
        modelName: data.modelName,
        endpointType: data.endpointType,
        status: failResult.status,
        latency: failResult.latency,
        timestamp: Date.now(),
        isModelComplete,
      });
    } catch {
      // Do not mask original failure
    }

    return failResult;
  } finally {
    if (useRedisSemaphore) {
      await releaseSlots(data.channelId);
    }
  }
}

async function processRedisDetectionJob(
  job: Job<DetectionJobData, DetectionResult>
): Promise<DetectionResult> {
  const jobId = job.id ? String(job.id) : undefined;
  return runDetectionPipeline(job.data, jobId, true);
}

function getMemoryChannelActive(channelId: string): number {
  return ws.memoryChannelActiveCounts.get(channelId) || 0;
}

function increaseMemoryChannelActive(channelId: string): void {
  const current = getMemoryChannelActive(channelId);
  ws.memoryChannelActiveCounts.set(channelId, current + 1);
}

function decreaseMemoryChannelActive(channelId: string): void {
  const current = getMemoryChannelActive(channelId);
  if (current <= 1) {
    ws.memoryChannelActiveCounts.delete(channelId);
    return;
  }
  ws.memoryChannelActiveCounts.set(channelId, current - 1);
}

function scheduleMemoryTick(delayMs: number): void {
  if (!ws.memoryWorkerRunning) return;

  if (ws.memoryTickTimer) {
    clearTimeout(ws.memoryTickTimer);
  }

  ws.memoryTickTimer = setTimeout(() => {
    void processMemoryQueue();
  }, delayMs);
}

async function processMemoryQueue(): Promise<void> {
  if (!ws.memoryWorkerRunning) return;

  const runtimeConfig = await loadWorkerConfig();
  let launchedAnyJob = false;
  let launchedCount = 0;

  while (ws.memoryRunningJobs.size < runtimeConfig.maxGlobalConcurrency) {
    const nextJob = pullNextMemoryJob((job) => {
      const globalCanTake = ws.memoryRunningJobs.size < runtimeConfig.maxGlobalConcurrency;
      const channelCanTake = getMemoryChannelActive(job.channelId) < runtimeConfig.channelConcurrency;
      return globalCanTake && channelCanTake;
    });

    if (!nextJob) {
      break;
    }

    launchedAnyJob = true;
    launchedCount++;
    ws.memoryRunningJobs.add(nextJob.id);
    increaseMemoryChannelActive(nextJob.data.channelId);

    void (async () => {
      let success = false;
      try {
        const result = await runDetectionPipeline(nextJob.data, nextJob.id, false);
        success = result.status === "SUCCESS";
      } catch {
        success = false;
      } finally {
        completeMemoryJob(nextJob.id, success);
        ws.memoryRunningJobs.delete(nextJob.id);
        decreaseMemoryChannelActive(nextJob.data.channelId);

        if (ws.memoryWorkerRunning) {
          scheduleMemoryTick(0);
        }
      }
    })();
  }

  if (!ws.memoryWorkerRunning) {
    return;
  }

  if (launchedCount > 0) {
    console.log(`[worker] launched ${launchedCount} jobs, running=${ws.memoryRunningJobs.size}`);
  }

  const hasWork = hasPendingMemoryJobs() || ws.memoryRunningJobs.size > 0;
  if (hasWork) {
    scheduleMemoryTick(launchedAnyJob ? 50 : 150);
  } else {
    scheduleMemoryTick(500);
  }
}

function startMemoryWorker(): void {
  if (ws.memoryWorkerRunning) {
    return;
  }

  ws.memoryWorkerRunning = true;
  scheduleMemoryTick(0);
}

async function stopMemoryWorker(): Promise<void> {
  ws.memoryWorkerRunning = false;

  if (ws.memoryTickTimer) {
    clearTimeout(ws.memoryTickTimer);
    ws.memoryTickTimer = null;
  }
}

/**
 * Start the detection worker
 */
export function startWorker(): Worker<DetectionJobData, DetectionResult> | null {
  if (isRedisConfigured) {
    if (ws.worker) {
      return ws.worker;
    }

    ws.worker = new Worker<DetectionJobData, DetectionResult>(
      DETECTION_QUEUE_NAME,
      processRedisDetectionJob,
      {
        connection: createRedisDuplicate("redis:worker"),
        concurrency: WORKER_CONCURRENCY,
      }
    );

    ws.worker.on("error", () => {
      // Keep runtime stable; queue retries handle failures.
    });

    return ws.worker;
  }

  startMemoryWorker();
  return null;
}

/**
 * Stop the detection worker
 */
export async function stopWorker(): Promise<void> {
  if (ws.worker) {
    await ws.worker.close();
    ws.worker = null;
  }

  await stopMemoryWorker();
}

/**
 * Get worker status
 */
export function isWorkerRunning(): boolean {
  const redisWorkerRunning = ws.worker !== null && !ws.worker.closing;
  return redisWorkerRunning || ws.memoryWorkerRunning;
}
