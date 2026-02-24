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

let cachedConfig: WorkerRuntimeConfig | null = null;
let cachedAt = 0;
let loadingConfigPromise: Promise<WorkerRuntimeConfig> | null = null;

// Redis keys
const GLOBAL_SEMAPHORE_KEY = "detection:semaphore:global";

// Worker instances
let worker: Worker<DetectionJobData, DetectionResult> | null = null;
let memoryWorkerRunning = false;
let memoryTickTimer: NodeJS.Timeout | null = null;
const memoryRunningJobs = new Set<string>();
const memoryChannelActiveCounts = new Map<string, number>();

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
  if (cachedConfig && now - cachedAt < CONFIG_CACHE_TTL_MS) {
    return cachedConfig;
  }

  if (!loadingConfigPromise) {
    loadingConfigPromise = (async () => {
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

        cachedConfig = resolvedConfig;
        cachedAt = Date.now();
        return resolvedConfig;
      } catch {
        const fallbackConfig = cachedConfig ?? normalizeConfig(DEFAULT_WORKER_CONFIG);
        cachedConfig = fallbackConfig;
        cachedAt = Date.now();
        return fallbackConfig;
      } finally {
        loadingConfigPromise = null;
      }
    })();
  }

  return loadingConfigPromise;
}

export function reloadWorkerConfig(): void {
  cachedConfig = null;
  cachedAt = 0;
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
  return memoryChannelActiveCounts.get(channelId) || 0;
}

function increaseMemoryChannelActive(channelId: string): void {
  const current = getMemoryChannelActive(channelId);
  memoryChannelActiveCounts.set(channelId, current + 1);
}

function decreaseMemoryChannelActive(channelId: string): void {
  const current = getMemoryChannelActive(channelId);
  if (current <= 1) {
    memoryChannelActiveCounts.delete(channelId);
    return;
  }
  memoryChannelActiveCounts.set(channelId, current - 1);
}

function scheduleMemoryTick(delayMs: number): void {
  if (!memoryWorkerRunning) return;

  if (memoryTickTimer) {
    clearTimeout(memoryTickTimer);
  }

  memoryTickTimer = setTimeout(() => {
    void processMemoryQueue();
  }, delayMs);
}

async function processMemoryQueue(): Promise<void> {
  if (!memoryWorkerRunning) return;

  const runtimeConfig = await loadWorkerConfig();
  let launchedAnyJob = false;

  while (memoryRunningJobs.size < runtimeConfig.maxGlobalConcurrency) {
    const nextJob = pullNextMemoryJob((job) => {
      const globalCanTake = memoryRunningJobs.size < runtimeConfig.maxGlobalConcurrency;
      const channelCanTake = getMemoryChannelActive(job.channelId) < runtimeConfig.channelConcurrency;
      return globalCanTake && channelCanTake;
    });

    if (!nextJob) {
      break;
    }

    launchedAnyJob = true;
    memoryRunningJobs.add(nextJob.id);
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
        memoryRunningJobs.delete(nextJob.id);
        decreaseMemoryChannelActive(nextJob.data.channelId);

        if (memoryWorkerRunning) {
          scheduleMemoryTick(0);
        }
      }
    })();
  }

  if (!memoryWorkerRunning) {
    return;
  }

  const hasWork = hasPendingMemoryJobs() || memoryRunningJobs.size > 0;
  if (hasWork) {
    scheduleMemoryTick(launchedAnyJob ? 50 : 150);
  } else {
    scheduleMemoryTick(500);
  }
}

function startMemoryWorker(): void {
  if (memoryWorkerRunning) {
    return;
  }

  memoryWorkerRunning = true;
  scheduleMemoryTick(0);
}

async function stopMemoryWorker(): Promise<void> {
  memoryWorkerRunning = false;

  if (memoryTickTimer) {
    clearTimeout(memoryTickTimer);
    memoryTickTimer = null;
  }
}

/**
 * Start the detection worker
 */
export function startWorker(): Worker<DetectionJobData, DetectionResult> | null {
  if (isRedisConfigured) {
    if (worker) {
      return worker;
    }

    worker = new Worker<DetectionJobData, DetectionResult>(
      DETECTION_QUEUE_NAME,
      processRedisDetectionJob,
      {
        connection: createRedisDuplicate("redis:worker"),
        concurrency: WORKER_CONCURRENCY,
      }
    );

    worker.on("error", () => {
      // Keep runtime stable; queue retries handle failures.
    });

    return worker;
  }

  startMemoryWorker();
  return null;
}

/**
 * Stop the detection worker
 */
export async function stopWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }

  await stopMemoryWorker();
}

/**
 * Get worker status
 */
export function isWorkerRunning(): boolean {
  const redisWorkerRunning = worker !== null && !worker.closing;
  return redisWorkerRunning || memoryWorkerRunning;
}
