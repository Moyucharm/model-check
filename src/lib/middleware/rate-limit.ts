// In-memory rate limiter for login brute-force protection

interface RateLimitEntry {
  count: number;
  firstAttempt: number;
  blockedUntil: number;
}

const store = new Map<string, RateLimitEntry>();

// Periodically clean up expired entries (every 10 minutes)
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.blockedUntil && now - entry.firstAttempt > WINDOW_MS) {
        store.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  // Allow the process to exit without waiting for this timer
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

/** Time window for counting attempts (ms) */
const WINDOW_MS = 60 * 1000; // 1 minute

/** Max attempts within the window before blocking */
const MAX_ATTEMPTS = 5;

/** Progressive block durations (seconds): 30s → 60s → 300s */
const BLOCK_DURATIONS_SEC = [30, 60, 300];

/**
 * Extract client IP from the request.
 * Supports common reverse-proxy headers.
 */
function getClientIp(request: Request): string {
  const headers = request.headers;
  // Standard proxy headers (pick the first real IP)
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return headers.get("x-real-ip") ?? "unknown";
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the block expires (0 when allowed) */
  retryAfterSec: number;
  /** Remaining attempts in the current window */
  remaining: number;
}

/**
 * Check rate limit for login attempts.
 * Call `recordFailure` after a failed login to increment the counter.
 */
export function checkRateLimit(request: Request): RateLimitResult {
  ensureCleanup();

  const ip = getClientIp(request);
  const key = `login:${ip}`;
  const now = Date.now();
  const entry = store.get(key);

  // No previous record → allow
  if (!entry) {
    return { allowed: true, retryAfterSec: 0, remaining: MAX_ATTEMPTS };
  }

  // Currently blocked?
  if (entry.blockedUntil > now) {
    const retryAfterSec = Math.ceil((entry.blockedUntil - now) / 1000);
    return { allowed: false, retryAfterSec, remaining: 0 };
  }

  // Window expired → reset
  if (now - entry.firstAttempt > WINDOW_MS) {
    store.delete(key);
    return { allowed: true, retryAfterSec: 0, remaining: MAX_ATTEMPTS };
  }

  // Within window but under limit
  if (entry.count < MAX_ATTEMPTS) {
    return { allowed: true, retryAfterSec: 0, remaining: MAX_ATTEMPTS - entry.count };
  }

  // Exceeded – should not normally reach here (block is set in recordFailure),
  // but handle defensively
  return { allowed: false, retryAfterSec: 1, remaining: 0 };
}

/**
 * Record a failed login attempt.
 * Automatically blocks the IP when the threshold is exceeded.
 */
export function recordFailure(request: Request): void {
  const ip = getClientIp(request);
  const key = `login:${ip}`;
  const now = Date.now();
  let entry = store.get(key);

  if (!entry || now - entry.firstAttempt > WINDOW_MS) {
    entry = { count: 1, firstAttempt: now, blockedUntil: 0 };
    store.set(key, entry);
    return;
  }

  entry.count += 1;

  if (entry.count >= MAX_ATTEMPTS) {
    // Progressive block: each time the limit is hit, pick the next duration
    const blockIndex = Math.min(
      Math.floor(entry.count / MAX_ATTEMPTS) - 1,
      BLOCK_DURATIONS_SEC.length - 1
    );
    const blockMs = BLOCK_DURATIONS_SEC[blockIndex] * 1000;
    entry.blockedUntil = now + blockMs;
  }

  store.set(key, entry);
}
