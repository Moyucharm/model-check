// Queue-related constants shared between worker and SSE

// Queue name for BullMQ
export const DETECTION_QUEUE_NAME = "detection-queue";

// Redis pub/sub channel for SSE progress updates
export const PROGRESS_CHANNEL = "detection:progress";

// Redis key for detection stopped flag (TTL: 5 minutes)
export const DETECTION_STOPPED_KEY = "detection:stopped";
export const DETECTION_STOPPED_TTL = 300; // 5 minutes
