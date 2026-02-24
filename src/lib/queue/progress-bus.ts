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

const emitter = new EventEmitter();
emitter.setMaxListeners(1000);

const SOURCE_ID = `proc-${process.pid}-${Math.random().toString(36).slice(2)}`;

let subscriber: Redis | null = null;
let subscriberInitPromise: Promise<void> | null = null;

function emitProgress(event: DetectionProgressEvent): void {
  emitter.emit("progress", event);
}

async function ensureRedisSubscription(): Promise<void> {
  if (!isRedisConfigured) return;
  if (subscriber) return;
  if (subscriberInitPromise) return subscriberInitPromise;

  subscriberInitPromise = (async () => {
    const sub = createRedisDuplicate("redis:progress-sub");
    sub.on("message", (channel, message) => {
      if (channel !== PROGRESS_CHANNEL) return;
      try {
        const payload = JSON.parse(message) as ProgressPayload;
        if (payload._source === SOURCE_ID) return;
        const { _source, ...event } = payload;
        emitProgress(event);
      } catch {
        // ignore malformed payload
      }
    });
    await sub.subscribe(PROGRESS_CHANNEL);
    subscriber = sub;
  })()
    .finally(() => {
      subscriberInitPromise = null;
    });

  return subscriberInitPromise;
}

export function subscribeProgress(
  listener: (event: DetectionProgressEvent) => void
): () => void {
  if (isRedisConfigured) {
    void ensureRedisSubscription();
  }
  emitter.on("progress", listener);
  return () => {
    emitter.off("progress", listener);
  };
}

export async function publishProgress(event: DetectionProgressEvent): Promise<void> {
  emitProgress(event);

  if (!isRedisConfigured) return;

  const payload: ProgressPayload = {
    ...event,
    _source: SOURCE_ID,
  };

  try {
    await getRedisClient().publish(PROGRESS_CHANNEL, JSON.stringify(payload));
  } catch {
    // redis publish failure should not break detection flow
  }
}
