// Integration tests with mock server

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { executeDetection, sleep, randomDelay } from "@/lib/detection/detector";
import { EndpointType, CheckStatus } from "@prisma/client";
import type { DetectionJobData } from "@/lib/detection/types";

// Mock fetch for testing
const originalFetch = global.fetch;

describe("Detection Executor", () => {
  describe("executeDetection", () => {
    afterAll(() => {
      global.fetch = originalFetch;
    });

    it("should return SUCCESS for 200 response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "yes" } }] }),
      });

      const job: DetectionJobData = {
        channelId: "test-channel",
        modelId: "test-model",
        modelName: "gpt-4",
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        endpointType: EndpointType.CHAT,
      };

      const result = await executeDetection(job);

      expect(result.status).toBe(CheckStatus.SUCCESS);
      expect(result.statusCode).toBe(200);
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it("should return FAIL for error response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => '{"error": "Unauthorized"}',
      });

      const job: DetectionJobData = {
        channelId: "test-channel",
        modelId: "test-model",
        modelName: "gpt-4",
        baseUrl: "https://api.example.com",
        apiKey: "invalid-key",
        endpointType: EndpointType.CHAT,
      };

      const result = await executeDetection(job);

      expect(result.status).toBe(CheckStatus.FAIL);
      expect(result.statusCode).toBe(401);
      expect(result.errorMsg).toContain("Unauthorized");
    });

    it("should handle network errors gracefully", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const job: DetectionJobData = {
        channelId: "test-channel",
        modelId: "test-model",
        modelName: "gpt-4",
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        endpointType: EndpointType.CHAT,
      };

      const result = await executeDetection(job);

      expect(result.status).toBe(CheckStatus.FAIL);
      expect(result.errorMsg).toBe("Network error");
    });

    it("should use correct endpoint URL for Claude models", async () => {
      let capturedUrl = "";
      global.fetch = vi.fn().mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ content: [{ text: "yes" }] }),
        });
      });

      const job: DetectionJobData = {
        channelId: "test-channel",
        modelId: "test-model",
        modelName: "claude-3-opus",
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        endpointType: EndpointType.CLAUDE,
      };

      await executeDetection(job);

      expect(capturedUrl).toBe("https://api.example.com/v1/messages");
    });
  });

  describe("Delay utilities", () => {
    it("should sleep for specified duration", async () => {
      const start = Date.now();
      await sleep(100);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(95); // Allow some timing variance
      expect(elapsed).toBeLessThan(200);
    });

    it("should generate random delay within range", () => {
      for (let i = 0; i < 100; i++) {
        const delay = randomDelay(3000, 5000);
        expect(delay).toBeGreaterThanOrEqual(3000);
        expect(delay).toBeLessThanOrEqual(5000);
      }
    });
  });
});

describe("Retry Mechanism", () => {
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("should handle intermittent failures (simulated)", async () => {
    let callCount = 0;

    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "yes" } }] }),
      });
    });

    // Note: This test simulates the retry behavior that BullMQ would handle
    // In actual implementation, BullMQ's attempts: 3 configuration handles retries
    const job: DetectionJobData = {
      channelId: "test-channel",
      modelId: "test-model",
      modelName: "gpt-4",
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      endpointType: EndpointType.CHAT,
    };

    // Simulate manual retry logic (BullMQ handles this automatically)
    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      result = await executeDetection(job);
      if (result.status === CheckStatus.SUCCESS) break;
    }

    expect(result?.status).toBe(CheckStatus.SUCCESS);
    expect(callCount).toBe(3);
  });
});
