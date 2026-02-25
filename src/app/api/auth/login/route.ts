// POST /api/auth/login - Admin login

import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/auth";
import { checkRateLimit, recordFailure } from "@/lib/middleware/rate-limit";

export async function POST(request: NextRequest) {
  try {
    // Rate-limit check (brute-force protection)
    const limit = checkRateLimit(request);
    if (!limit.allowed) {
      return NextResponse.json(
        {
          error: `Too many login attempts. Try again in ${limit.retryAfterSec}s`,
          code: "RATE_LIMITED",
          retryAfter: limit.retryAfterSec,
        },
        {
          status: 429,
          headers: { "Retry-After": String(limit.retryAfterSec) },
        }
      );
    }

    const body = await request.json();
    const { password } = body;

    if (!password || typeof password !== "string") {
      return NextResponse.json(
        { error: "Password is required", code: "MISSING_PASSWORD" },
        { status: 400 }
      );
    }

    const token = await authenticateAdmin(password);

    if (!token) {
      // Record failure for rate-limiting
      recordFailure(request);
      return NextResponse.json(
        { error: "Invalid password", code: "INVALID_PASSWORD" },
        { status: 401 }
      );
    }

    return NextResponse.json({
      success: true,
      token,
      expiresIn: "7d",
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Internal server error", code: "SERVER_ERROR" },
      { status: 500 }
    );
  }
}
