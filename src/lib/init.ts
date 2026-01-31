// Application initialization - Start worker and scheduler

import { startWorker, isWorkerRunning } from "@/lib/queue/worker";
import { startAllCrons, getCronStatus } from "@/lib/scheduler";

let initialized = false;

/**
 * Initialize background services
 * Should be called once on application startup
 */
export function initializeServices(): void {
  if (initialized) {
    console.log("[Init] Services already initialized");
    return;
  }

  console.log("[Init] Starting background services...");

  // Start worker
  if (!isWorkerRunning()) {
    startWorker();
    console.log("[Init] Worker started");
  }

  // Start cron jobs
  startAllCrons();
  console.log("[Init] Cron jobs started");

  initialized = true;

  // Log status
  const cronStatus = getCronStatus();
  console.log("[Init] Services initialized:", {
    worker: isWorkerRunning(),
    cron: cronStatus,
  });
}

/**
 * Check if services are initialized
 */
export function isInitialized(): boolean {
  return initialized;
}
