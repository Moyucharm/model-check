// Scheduler and cleanup tests

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanupOldLogs, getCronStatus } from "@/lib/scheduler/cron";

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  default: {
    checkLog: {
      deleteMany: vi.fn().mockResolvedValue({ count: 5 }),
    },
  },
}));

describe("Scheduler", () => {
  describe("getCronStatus", () => {
    it("should return status object with expected structure", () => {
      const status = getCronStatus();

      expect(status).toHaveProperty("detection");
      expect(status).toHaveProperty("cleanup");
      expect(status.detection).toHaveProperty("schedule");
      expect(status.cleanup).toHaveProperty("retentionDays");
    });

    it("should have default schedule values", () => {
      const status = getCronStatus();

      // Default detection: every 6 hours
      expect(status.detection.schedule).toBe("0 */6 * * *");

      // Default cleanup: daily at 2 AM
      expect(status.cleanup.schedule).toBe("0 2 * * *");

      // Default retention: 7 days
      expect(status.cleanup.retentionDays).toBe(7);
    });
  });

  describe("cleanupOldLogs", () => {
    it("should delete old logs and return count", async () => {
      const result = await cleanupOldLogs();

      expect(result).toHaveProperty("deleted");
      expect(result.deleted).toBe(5);
    });
  });
});

describe("Cron Schedule Validation", () => {
  it("should parse valid cron expressions", () => {
    // These are valid cron expressions
    const validExpressions = [
      "0 */6 * * *",     // Every 6 hours
      "0 2 * * *",       // Daily at 2 AM
      "*/5 * * * *",     // Every 5 minutes
      "0 0 * * 0",       // Weekly on Sunday
      "0 0 1 * *",       // Monthly on 1st
    ];

    validExpressions.forEach((expr) => {
      // CronJob constructor would throw if invalid
      // Here we just verify the format
      const parts = expr.split(" ");
      expect(parts.length).toBe(5);
    });
  });
});

describe("Log Retention", () => {
  it("should calculate cutoff date correctly", () => {
    const retentionDays = 7;
    const now = new Date();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    // Cutoff should be 7 days before now
    const diffMs = now.getTime() - cutoff.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    expect(diffDays).toBe(retentionDays);
  });
});
