// Queue abstraction for detection jobs.
// Uses BullMQ when REDIS_URL is configured, otherwise falls back to in-memory queue.

import { Queue } from "bullmq";
import type { DetectionJobData } from "@/lib/detection/types";
import { getRedisClient, isRedisConfigured } from "@/lib/redis";
import { DETECTION_QUEUE_NAME, DETECTION_STOPPED_KEY, DETECTION_STOPPED_TTL } from "./constants";

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  total: number;
}

type MemoryJobState = "waiting" | "active";

interface MemoryJob {
  id: string;
  data: DetectionJobData;
  state: MemoryJobState;
}

interface MemoryQueueJob {
  id: string;
  data: DetectionJobData;
}

const memoryJobs = new Map<string, MemoryJob>();
const memoryWaitingIds: string[] = [];
const memoryActiveIds = new Set<string>();

let memoryCompletedCount = 0;
let memoryFailedCount = 0;
let memoryStopped = false;

// Queue instance (Redis/BullMQ mode)
let detectionQueue: Queue<DetectionJobData> | null = null;

function getOrCreateRedisQueue(): Queue<DetectionJobData> {
  if (!isRedisConfigured) {
    throw new Error("Redis queue requested but REDIS_URL is not configured");
  }

  if (!detectionQueue) {
    detectionQueue = new Queue<DetectionJobData>(DETECTION_QUEUE_NAME, {
      connection: getRedisClient(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
        removeOnComplete: {
          count: 1000,
          age: 3600,
        },
        removeOnFail: {
          count: 500,
          age: 86400,
        },
      },
    });
  }

  return detectionQueue;
}

function resetMemoryCountersIfIdle(): void {
  if (memoryWaitingIds.length === 0 && memoryActiveIds.size === 0) {
    memoryCompletedCount = 0;
    memoryFailedCount = 0;
  }
}

function createMemoryJob(data: DetectionJobData): string {
  const id = `${data.channelId}-${data.modelId}-${data.endpointType}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const job: MemoryJob = {
    id,
    data,
    state: "waiting",
  };

  memoryJobs.set(id, job);
  memoryWaitingIds.push(id);
  return id;
}

export function isUsingRedisQueue(): boolean {
  return isRedisConfigured;
}

/**
 * Get Redis queue in Redis mode.
 * In memory mode this throws by design (not available).
 */
export function getDetectionQueue(): Queue<DetectionJobData> {
  return getOrCreateRedisQueue();
}

export async function addDetectionJob(data: DetectionJobData): Promise<string> {
  if (!isRedisConfigured) {
    resetMemoryCountersIfIdle();
    return createMemoryJob(data);
  }

  const queue = getOrCreateRedisQueue();
  const job = await queue.add(`detect-${data.modelName}`, data, {
    jobId: `${data.channelId}-${data.modelId}-${data.endpointType}-${Date.now()}`,
  });
  return job.id || "";
}

export async function addDetectionJobsBulk(jobs: DetectionJobData[]): Promise<string[]> {
  if (!isRedisConfigured) {
    resetMemoryCountersIfIdle();
    return jobs.map((job) => createMemoryJob(job));
  }

  const queue = getOrCreateRedisQueue();
  const timestamp = Date.now();
  const bulkJobs = jobs.map((data, index) => ({
    name: `detect-${data.modelName}`,
    data,
    opts: {
      jobId: `${data.channelId}-${data.modelId}-${data.endpointType}-${timestamp}-${index}`,
    },
  }));

  const addedJobs = await queue.addBulk(bulkJobs);
  return addedJobs.map((j) => j.id || "");
}

export function isQueueRunning(stats: Pick<QueueStats, "active" | "waiting" | "delayed">): boolean {
  return stats.active > 0 || stats.waiting > 0 || stats.delayed > 0;
}

export async function getQueueStats(): Promise<QueueStats> {
  if (!isRedisConfigured) {
    return {
      waiting: memoryWaitingIds.length,
      active: memoryActiveIds.size,
      completed: memoryCompletedCount,
      failed: memoryFailedCount,
      delayed: 0,
      total: memoryWaitingIds.length + memoryActiveIds.size,
    };
  }

  const queue = getOrCreateRedisQueue();
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    total: waiting + active + delayed,
  };
}

export async function getTestingModelIds(): Promise<string[]> {
  if (!isRedisConfigured) {
    const modelIds = new Set<string>();
    for (const id of [...memoryWaitingIds, ...Array.from(memoryActiveIds)]) {
      const job = memoryJobs.get(id);
      if (job?.data?.modelId) {
        modelIds.add(job.data.modelId);
      }
    }
    return Array.from(modelIds);
  }

  const queue = getOrCreateRedisQueue();
  const [waitingJobs, activeJobs, delayedJobs] = await Promise.all([
    queue.getJobs(["waiting"], 0, 1000),
    queue.getJobs(["active"], 0, 100),
    queue.getJobs(["delayed"], 0, 1000),
  ]);

  const modelIds = new Set<string>();
  for (const job of [...waitingJobs, ...activeJobs, ...delayedJobs]) {
    if (job.data?.modelId) {
      modelIds.add(job.data.modelId);
    }
  }

  return Array.from(modelIds);
}

export async function getTestingChannelIds(): Promise<Set<string>> {
  if (!isRedisConfigured) {
    const channelIds = new Set<string>();
    for (const id of [...memoryWaitingIds, ...Array.from(memoryActiveIds)]) {
      const job = memoryJobs.get(id);
      if (job?.data?.channelId) {
        channelIds.add(job.data.channelId);
      }
    }
    return channelIds;
  }

  const queue = getOrCreateRedisQueue();
  const [waitingJobs, activeJobs, delayedJobs] = await Promise.all([
    queue.getJobs(["waiting"], 0, 1000),
    queue.getJobs(["active"], 0, 100),
    queue.getJobs(["delayed"], 0, 1000),
  ]);

  const channelIds = new Set<string>();
  for (const job of [...waitingJobs, ...activeJobs, ...delayedJobs]) {
    if (job.data?.channelId) {
      channelIds.add(job.data.channelId);
    }
  }

  return channelIds;
}

export async function clearQueue(): Promise<void> {
  if (!isRedisConfigured) {
    memoryJobs.clear();
    memoryWaitingIds.length = 0;
    memoryActiveIds.clear();
    memoryCompletedCount = 0;
    memoryFailedCount = 0;
    return;
  }

  const queue = getOrCreateRedisQueue();
  await queue.obliterate({ force: true });
}

export async function pauseAndDrainQueue(): Promise<{ cleared: number }> {
  if (!isRedisConfigured) {
    memoryStopped = true;
    const cleared = memoryWaitingIds.length + memoryActiveIds.size;
    for (const id of memoryWaitingIds) {
      memoryJobs.delete(id);
    }
    memoryWaitingIds.length = 0;
    return { cleared };
  }

  const queue = getOrCreateRedisQueue();
  const redis = getRedisClient();

  await redis.set(DETECTION_STOPPED_KEY, "1", "EX", DETECTION_STOPPED_TTL);
  await queue.pause();

  let cleared = 0;

  try {
    const [waiting, delayed, activeJobs] = await Promise.all([
      queue.getWaitingCount(),
      queue.getDelayedCount(),
      queue.getJobs(["active"], 0, 1000),
    ]);

    const activeCount = activeJobs.length;

    const failPromises = activeJobs.map(async (job) => {
      try {
        if (job.token) {
          await job.moveToFailed(new Error("Detection stopped by user"), job.token, true);
        } else {
          await job.remove().catch(() => {});
        }
      } catch {
        // ignore
      }
    });
    await Promise.allSettled(failPromises);

    await queue.drain(true);

    const semaphoreKeys = await redis.keys("detection:semaphore:*");
    if (semaphoreKeys.length > 0) {
      await redis.del(...semaphoreKeys);
    }

    cleared = waiting + delayed + activeCount;
  } finally {
    await queue.resume();
  }

  return { cleared };
}

export async function isDetectionStopped(): Promise<boolean> {
  if (!isRedisConfigured) {
    return memoryStopped;
  }

  const value = await getRedisClient().get(DETECTION_STOPPED_KEY);
  return value === "1";
}

export async function clearStoppedFlag(): Promise<void> {
  if (!isRedisConfigured) {
    memoryStopped = false;
    return;
  }

  await getRedisClient().del(DETECTION_STOPPED_KEY);
}

// -------------------------------
// In-memory worker helper methods
// -------------------------------

export function pullNextMemoryJob(
  canTake?: (job: DetectionJobData) => boolean
): MemoryQueueJob | null {
  if (memoryStopped) return null;

  for (let i = 0; i < memoryWaitingIds.length; i += 1) {
    const id = memoryWaitingIds[i];
    const job = memoryJobs.get(id);
    if (!job || job.state !== "waiting") {
      memoryWaitingIds.splice(i, 1);
      i -= 1;
      continue;
    }

    if (canTake && !canTake(job.data)) {
      continue;
    }

    memoryWaitingIds.splice(i, 1);
    job.state = "active";
    memoryActiveIds.add(id);

    return { id, data: job.data };
  }

  return null;
}

export function completeMemoryJob(jobId: string, success: boolean): void {
  const job = memoryJobs.get(jobId);
  if (!job) return;

  memoryActiveIds.delete(jobId);
  memoryJobs.delete(jobId);

  if (success) {
    memoryCompletedCount += 1;
  } else {
    memoryFailedCount += 1;
  }
}

export function getMemoryActiveCountByChannel(channelId: string): number {
  let count = 0;
  for (const id of memoryActiveIds) {
    const job = memoryJobs.get(id);
    if (job?.data.channelId === channelId) {
      count += 1;
    }
  }
  return count;
}

export function hasPendingMemoryJobs(): boolean {
  return memoryWaitingIds.length > 0 || memoryActiveIds.size > 0;
}

export async function hasPendingJobsForModel(
  modelId: string,
  excludeJobId?: string
): Promise<boolean> {
  if (!isRedisConfigured) {
    const allPendingIds = [...memoryWaitingIds, ...Array.from(memoryActiveIds)];
    return allPendingIds.some((id) => {
      if (excludeJobId && id === excludeJobId) return false;
      const job = memoryJobs.get(id);
      return job?.data.modelId === modelId;
    });
  }

  const queue = getOrCreateRedisQueue();
  const [waitingJobs, activeJobs, delayedJobs] = await Promise.all([
    queue.getJobs(["waiting"], 0, 1000),
    queue.getJobs(["active"], 0, 100),
    queue.getJobs(["delayed"], 0, 1000),
  ]);

  return [...waitingJobs, ...activeJobs, ...delayedJobs].some((job) => {
    if (excludeJobId && String(job.id) === excludeJobId) return false;
    return job.data?.modelId === modelId;
  });
}
