// Channel models API - Sync models from /v1/models endpoint

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import { syncChannelModels } from "@/lib/queue/service";

// POST /api/channel/[id]/sync - Sync models from channel
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;

    const result = await syncChannelModels(id);

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to sync models";
    return NextResponse.json(
      { error: message, code: "SYNC_ERROR" },
      { status: 500 }
    );
  }
}
