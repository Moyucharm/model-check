// Scheduler API - Manage cron jobs and maintenance tasks

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import {
  startAllCrons,
  stopAllCrons,
  getCronStatus,
  cleanupOldLogs,
  startDetectionCron,
  startCleanupCron,
} from "@/lib/scheduler";

// GET /api/scheduler - Get scheduler status
export async function GET() {
  try {
    const status = getCronStatus();
    return NextResponse.json(status);
  } catch (error) {
    console.error("[API] Scheduler status error:", error);
    return NextResponse.json(
      { error: "Failed to get scheduler status", code: "STATUS_ERROR" },
      { status: 500 }
    );
  }
}

// POST /api/scheduler - Control scheduler
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json().catch(() => ({}));
    const { action } = body;

    switch (action) {
      case "start":
        startAllCrons();
        return NextResponse.json({
          success: true,
          message: "All cron jobs started",
          status: getCronStatus(),
        });

      case "stop":
        stopAllCrons();
        return NextResponse.json({
          success: true,
          message: "All cron jobs stopped",
          status: getCronStatus(),
        });

      case "start-detection":
        startDetectionCron();
        return NextResponse.json({
          success: true,
          message: "Detection cron started",
          status: getCronStatus(),
        });

      case "start-cleanup":
        startCleanupCron();
        return NextResponse.json({
          success: true,
          message: "Cleanup cron started",
          status: getCronStatus(),
        });

      case "cleanup-now":
        const result = await cleanupOldLogs();
        return NextResponse.json({
          success: true,
          message: `Cleanup complete: ${result.deleted} logs removed`,
          deleted: result.deleted,
        });

      default:
        return NextResponse.json(
          {
            error: "Invalid action. Use: start, stop, start-detection, start-cleanup, cleanup-now",
            code: "INVALID_ACTION",
          },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error("[API] Scheduler control error:", error);
    return NextResponse.json(
      { error: "Failed to control scheduler", code: "SCHEDULER_ERROR" },
      { status: 500 }
    );
  }
}
