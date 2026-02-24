import "dotenv/config";
import prisma from "../src/lib/prisma";
import { getRedisClient, isRedisConfigured } from "../src/lib/redis";

async function testConnections() {
  console.log("Testing database and Redis connections...\n");

  try {
    console.log("Database:");
    await prisma.$connect();
    const channelCount = await prisma.channel.count();
    console.log("  OK");
    console.log(`  channels: ${channelCount}\n`);

    if (isRedisConfigured) {
      console.log("Redis:");
      const redis = getRedisClient();
      await redis.ping();
      await redis.set("test_key", "test_value", "EX", 10);
      const value = await redis.get("test_key");
      console.log(`  ${value === "test_value" ? "OK" : "FAIL"}\n`);
      await redis.quit();
    } else {
      console.log("Redis:\n  SKIPPED (REDIS_URL not configured)\n");
    }

    console.log("Connection checks finished.");
  } catch (error) {
    console.error("Connection test failed:", error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void testConnections();
