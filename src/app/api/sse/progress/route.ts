// GET /api/sse/progress - Server-Sent Events for detection progress

import { NextRequest } from "next/server";
import Redis from "ioredis";
import { PROGRESS_CHANNEL } from "@/lib/queue/worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();

  // Create a new Redis subscriber connection
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const subscriber = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });

  let isConnected = true;
  let isCleanedUp = false;
  let heartbeatInterval: NodeJS.Timeout | null = null;

  // Unified cleanup function to prevent double cleanup
  const cleanup = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    isConnected = false;

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    // Use disconnect() instead of quit() - it's synchronous and doesn't throw on closed connections
    try {
      subscriber.disconnect(false);
    } catch {
      // Ignore errors on already closed connections
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      // Connect to Redis
      try {
        await subscriber.connect();
      } catch (error) {
        console.error("[SSE] Redis connection failed:", error);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", message: "Redis connection failed" })}\n\n`)
        );
        controller.close();
        return;
      }

      // Send initial connection message
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "connected", timestamp: Date.now() })}\n\n`)
      );

      // Subscribe to progress channel
      await subscriber.subscribe(PROGRESS_CHANNEL);

      // Handle incoming messages
      subscriber.on("message", (channel, message) => {
        if (!isConnected) return;

        try {
          const data = JSON.parse(message);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "progress", ...data })}\n\n`)
          );
        } catch (error) {
          console.error("[SSE] Failed to parse message:", error);
        }
      });

      // Handle Redis errors - suppress EPIPE/closed connection errors during cleanup
      subscriber.on("error", (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (isCleanedUp || code === "EPIPE" || error.message?.includes("Connection is closed")) {
          return;
        }
        console.error("[SSE] Redis error:", error);
        if (isConnected) {
          try {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "error", message: "Redis connection error" })}\n\n`
              )
            );
          } catch {
            // Controller might be closed
          }
        }
      });

      // Handle Redis connection close
      subscriber.on("close", () => {
        cleanup();
      });

      // Keep connection alive with heartbeat
      heartbeatInterval = setInterval(() => {
        if (isConnected && !isCleanedUp) {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "heartbeat", timestamp: Date.now() })}\n\n`)
            );
          } catch {
            // Controller might be closed, trigger cleanup
            cleanup();
          }
        }
      }, 30000); // Every 30 seconds

      // Cleanup on abort
      request.signal.addEventListener("abort", cleanup);
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    },
  });
}
