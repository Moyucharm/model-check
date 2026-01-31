// BullMQ Worker for processing detection jobs

import { Worker, Job } from "bullmq";
import redis from "@/lib/redis";
import prisma from "@/lib/prisma";
import { executeDetection, sleep, randomDelay } from "@/lib/detection/detector";
import type { DetectionJobData, DetectionResult } from "@/lib/detection/types";
import { DETECTION_QUEUE_NAME } from "./queue";

// Worker configuration (from environment variables)
const WORKER_CONCURRENCY = 50; // BullMQ worker pool size (should be >= MAX_GLOBAL_CONCURRENCY)
const CHANNEL_CONCURRENCY = parseInt(process.env.CHANNEL_CONCURRENCY || "5", 10);
const MAX_GLOBAL_CONCURRENCY = parseInt(process.env.MAX_GLOBAL_CONCURRENCY || "30", 10);
const MIN_DELAY_MS = parseInt(process.env.DETECTION_MIN_DELAY_MS || "3000", 10);
const MAX_DELAY_MS = parseInt(process.env.DETECTION_MAX_DELAY_MS || "5000", 10);
const SEMAPHORE_POLL_MS = 500; // Poll interval when waiting for slot
const SEMAPHORE_TTL = 120; // TTL in seconds for semaphore keys (auto-cleanup)

// Redis pub/sub channel for SSE progress updates
export const PROGRESS_CHANNEL = "detection:progress";

// Redis keys
const GLOBAL_SEMAPHORE_KEY = "detection:semaphore:global";

// Worker instance
let worker: Worker<DetectionJobData, DetectionResult> | null = null;

/**
 * Redis-based semaphore for concurrency control
 */
function channelSemaphoreKey(channelId: string): string {
  return `detection:semaphore:channel:${channelId}`;
}

async function acquireSlots(channelId: string): Promise<void> {
  const channelKey = channelSemaphoreKey(channelId);

  // Must acquire both global and channel slots
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Try global slot first
    const globalCount = await redis.incr(GLOBAL_SEMAPHORE_KEY);
    if (globalCount > MAX_GLOBAL_CONCURRENCY) {
      await redis.decr(GLOBAL_SEMAPHORE_KEY);
      await sleep(SEMAPHORE_POLL_MS);
      continue;
    }
    await redis.expire(GLOBAL_SEMAPHORE_KEY, SEMAPHORE_TTL);

    // Try channel slot
    const channelCount = await redis.incr(channelKey);
    if (channelCount > CHANNEL_CONCURRENCY) {
      // Release channel slot and global slot, then wait
      await redis.decr(channelKey);
      await redis.decr(GLOBAL_SEMAPHORE_KEY);
      await sleep(SEMAPHORE_POLL_MS);
      continue;
    }
    await redis.expire(channelKey, SEMAPHORE_TTL);

    // Got both slots
    return;
  }
}

async function releaseSlots(channelId: string): Promise<void> {
  const channelKey = channelSemaphoreKey(channelId);

  // Release both slots
  const [channelVal, globalVal] = await Promise.all([
    redis.decr(channelKey),
    redis.decr(GLOBAL_SEMAPHORE_KEY),
  ]);

  // Clean up if counters reach 0
  if (channelVal <= 0) await redis.del(channelKey);
  if (globalVal <= 0) await redis.del(GLOBAL_SEMAPHORE_KEY);
}

/**
 * Process a single detection job
 */
async function processDetectionJob(
  job: Job<DetectionJobData, DetectionResult>
): Promise<DetectionResult> {
  const { data } = job;

  // Acquire concurrency slots (both global and per-channel)
  await acquireSlots(data.channelId);

  try {
    console.log(`[Worker] Processing job ${job.id}: ${data.modelName} (${data.endpointType})`);

    // Anti-blocking delay (3-5 seconds random)
    const delay = randomDelay(MIN_DELAY_MS, MAX_DELAY_MS);
    console.log(`[Worker] Waiting ${delay}ms before detection...`);
    await sleep(delay);

    // Execute the actual detection
    const result = await executeDetection(data);

    console.log(
      `[Worker] Detection complete for ${data.modelName} (${data.endpointType}): ${result.status} (${result.latency}ms)`
    );

    // Use transaction to atomically update model status and create log
    await prisma.$transaction(async (tx) => {
      // Get current model within transaction for atomic read-modify-write
      const currentModel = await tx.model.findUnique({
        where: { id: data.modelId },
        select: { detectedEndpoints: true },
      });

      // Update detectedEndpoints based on result
      let detectedEndpoints = (currentModel?.detectedEndpoints as string[]) || [];

      if (result.status === "SUCCESS") {
        // Add endpoint to detectedEndpoints if not already present
        if (!detectedEndpoints.includes(data.endpointType)) {
          detectedEndpoints = [...detectedEndpoints, data.endpointType];
        }
      } else {
        // Remove endpoint from detectedEndpoints on failure
        detectedEndpoints = detectedEndpoints.filter((ep) => ep !== data.endpointType);
      }

      // Update model status in database
      await tx.model.update({
        where: { id: data.modelId },
        data: {
          lastStatus: result.status === "SUCCESS",
          lastLatency: result.latency,
          lastCheckedAt: new Date(),
          detectedEndpoints,
        },
      });

      // Create check log entry
      await tx.checkLog.create({
        data: {
          modelId: data.modelId,
          endpointType: result.endpointType,
          status: result.status,
          latency: result.latency,
          statusCode: result.statusCode,
          errorMsg: result.errorMsg,
          responseContent: result.responseContent,
        },
      });
    });

    // Publish progress update for SSE
    const progressData = {
      channelId: data.channelId,
      modelId: data.modelId,
      modelName: data.modelName,
      endpointType: data.endpointType,
      status: result.status,
      latency: result.latency,
      timestamp: Date.now(),
    };

    await redis.publish(PROGRESS_CHANNEL, JSON.stringify(progressData));

    return result;
  } finally {
    // Always release slots, even on error
    await releaseSlots(data.channelId);
  }
}

/**
 * Start the detection worker
 */
export function startWorker(): Worker<DetectionJobData, DetectionResult> {
  if (worker) {
    console.log("[Worker] Worker already running");
    return worker;
  }

  worker = new Worker<DetectionJobData, DetectionResult>(
    DETECTION_QUEUE_NAME,
    processDetectionJob,
    {
      connection: redis.duplicate(),
      concurrency: WORKER_CONCURRENCY,
    }
  );

  // Event handlers
  worker.on("completed", (job, result) => {
    console.log(`[Worker] Job ${job.id} completed: ${result.status}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[Worker] Job ${job?.id} failed:`, error.message);
  });

  worker.on("error", (error) => {
    console.error("[Worker] Worker error:", error);
  });

  worker.on("stalled", (jobId) => {
    console.warn(`[Worker] Job ${jobId} stalled`);
  });

  console.log(`[Worker] Started - global max: ${MAX_GLOBAL_CONCURRENCY}, per-channel: ${CHANNEL_CONCURRENCY}`);

  return worker;
}

/**
 * Stop the detection worker
 */
export async function stopWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    console.log("[Worker] Stopped");
  }
}

/**
 * Get worker status
 */
export function isWorkerRunning(): boolean {
  return worker !== null && !worker.closing;
}
