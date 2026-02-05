// Test API for Redis pub/sub debugging
// GET: Subscribe and wait for a message
// POST: Publish a test message

import { NextRequest, NextResponse } from "next/server";
import Redis from "ioredis";

const TEST_CHANNEL = "test:pubsub";

// POST /api/test-pubsub - Publish a test message
export async function POST(request: NextRequest) {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const publisher = new Redis(redisUrl);

  try {
    const body = await request.json().catch(() => ({}));
    const message = body.message || `Test message at ${new Date().toISOString()}`;

    const result = await publisher.publish(TEST_CHANNEL, JSON.stringify({ message, timestamp: Date.now() }));

    await publisher.quit();

    return NextResponse.json({
      success: true,
      channel: TEST_CHANNEL,
      message,
      subscriberCount: result,
    });
  } catch (error) {
    await publisher.quit().catch(() => {});
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// GET /api/test-pubsub - SSE to test subscription
export async function GET() {
  const encoder = new TextEncoder();
  let subscriber: Redis | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "connected", channel: TEST_CHANNEL })}\n\n`)
      );

      try {
        const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
        subscriber = new Redis(redisUrl);

        subscriber.on("message", (channel, message) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "message", channel, data: JSON.parse(message) })}\n\n`)
          );
        });

        await subscriber.subscribe(TEST_CHANNEL);

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "subscribed", channel: TEST_CHANNEL })}\n\n`)
        );
      } catch (error) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", message: String(error) })}\n\n`)
        );
      }
    },
    cancel() {
      if (subscriber) {
        subscriber.unsubscribe().catch(() => {});
        subscriber.quit().catch(() => {});
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
