import { EventEmitter } from "node:events";
import type Redis from "ioredis";
import { createRedisDuplicate, getRedisClient, isRedisConfigured } from "@/lib/redis";
import { PROGRESS_CHANNEL } from "./constants";

export interface DetectionProgressEvent {
  channelId: string;
  modelId: string;
  modelName: string;
  endpointType: string;
  status: "SUCCESS" | "FAIL";
  latency: number;
  timestamp: number;
  isModelComplete: boolean;
}

interface ProgressPayload extends DetectionProgressEvent {
  _source?: string;
}

// Persist EventEmitter across HMR (same pattern as prisma.ts)
interface ProgressBusState {
  emitter: EventEmitter;
  sourceId: string;
  subscriber: Redis | null;
  subscriberInitPromise: Promise<void> | null;
}

const globalForProgressBus = globalThis as unknown as {
  __progressBusState?: ProgressBusState;
};

if (!globalForProgressBus.__progressBusState) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(1000);

  globalForProgressBus.__progressBusState = {
    emitter,
    sourceId: `proc-${process.pid}-${Math.random().toString(36).slice(2)}`,
    subscriber: null,
    subscriberInitPromise: null,
  };
}

const pbs = globalForProgressBus.__progressBusState;

function emitProgress(event: DetectionProgressEvent): void {
  pbs.emitter.emit("progress", event);
}

async function ensureRedisSubscription(): Promise<void> {
  if (!isRedisConfigured) return;
  if (pbs.subscriber) return;
  if (pbs.subscriberInitPromise) return pbs.subscriberInitPromise;

  pbs.subscriberInitPromise = (async () => {
    const sub = createRedisDuplicate("redis:progress-sub");
    sub.on("message", (channel, message) => {
      if (channel !== PROGRESS_CHANNEL) return;
      try {
        const payload = JSON.parse(message) as ProgressPayload;
        if (payload._source === pbs.sourceId) return;
        const { _source, ...event } = payload;
        emitProgress(event);
      } catch {
        // ignore malformed payload
      }
    });
    await sub.subscribe(PROGRESS_CHANNEL);
    pbs.subscriber = sub;
  })()
    .finally(() => {
      pbs.subscriberInitPromise = null;
    });

  return pbs.subscriberInitPromise;
}

export function subscribeProgress(
  listener: (event: DetectionProgressEvent) => void
): () => void {
  if (isRedisConfigured) {
    void ensureRedisSubscription();
  }
  pbs.emitter.on("progress", listener);
  return () => {
    pbs.emitter.off("progress", listener);
  };
}

export async function publishProgress(event: DetectionProgressEvent): Promise<void> {
  emitProgress(event);

  if (!isRedisConfigured) return;

  const payload: ProgressPayload = {
    ...event,
    _source: pbs.sourceId,
  };

  try {
    await getRedisClient().publish(PROGRESS_CHANNEL, JSON.stringify(payload));
  } catch {
    // redis publish failure should not break detection flow
  }
}
