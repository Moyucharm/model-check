import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL?.trim() || "";

export const isRedisConfigured = REDIS_URL.length > 0;

const globalForRedis = globalThis as unknown as {
  redisClient?: Redis;
};

function attachErrorHandler(client: Redis, label: string): void {
  client.on("error", (error) => {
    if (process.env.NODE_ENV === "development") {
      console.error(`[${label}]`, error);
    }
  });
}

function createRedisClient(): Redis {
  if (!isRedisConfigured) {
    throw new Error("Redis is not configured. Set REDIS_URL to enable Redis-backed queue.");
  }

  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
      if (times > 10) return null;
      return Math.min(times * 500, 5000);
    },
  });

  attachErrorHandler(client, "redis");
  return client;
}

export function getRedisClient(): Redis {
  if (!globalForRedis.redisClient) {
    globalForRedis.redisClient = createRedisClient();
  }
  return globalForRedis.redisClient;
}

export function createRedisDuplicate(label: string): Redis {
  const duplicate = getRedisClient().duplicate();
  attachErrorHandler(duplicate, label);
  return duplicate;
}
