import Redis from "ioredis";

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

function attachErrorHandler(client: Redis, label = "Redis") {
  client.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
      console.error(`[${label}] Connection refused - is Redis running?`);
    } else {
      console.error(`[${label}] Error:`, err.message);
    }
  });
}

function createRedisClient() {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
      if (times > 10) {
        console.error("[Redis] Max reconnection attempts reached, stopping retry");
        return null;
      }
      const delay = Math.min(times * 500, 5000);
      console.warn(`[Redis] Reconnecting in ${delay}ms (attempt ${times})...`);
      return delay;
    },
  });

  attachErrorHandler(client);
  client.on("connect", () => {
    console.log("[Redis] Connected");
  });

  // 覆盖 duplicate，让复制出的连接也带 error 监听
  const originalDuplicate = client.duplicate.bind(client);
  client.duplicate = (...args: Parameters<typeof client.duplicate>) => {
    const dup = originalDuplicate(...args);
    attachErrorHandler(dup, "Redis:dup");
    return dup;
  };

  return client;
}

export const redis = globalForRedis.redis ?? createRedisClient();

if (process.env.NODE_ENV !== "production") globalForRedis.redis = redis;

export default redis;
