#!/bin/sh
set -e

# ========================================
# Docker Entrypoint
# Handles: directory permissions + DB schema initialization
# ========================================

DATA_DIR="/app/data"
DB_FILE="${DATA_DIR}/model-check.db"

# --- 1. Ensure data directory has correct ownership ---
mkdir -p "${DATA_DIR}"
chown nextjs:nodejs "${DATA_DIR}"

# --- 2. Initialize / sync database schema ---
if [ ! -f "${DB_FILE}" ]; then
  echo "[Entrypoint] Database not found, initializing schema..."
  su-exec nextjs npx prisma db push --skip-generate 2>&1 || {
    echo "[Entrypoint] Warning: Schema init failed. App may not work correctly."
  }
else
  echo "[Entrypoint] Database exists, syncing schema..."
  su-exec nextjs npx prisma db push --skip-generate 2>&1 || {
    echo "[Entrypoint] Warning: Schema sync failed. Manual migration may be needed."
  }
fi

# --- 3. Start application as nextjs user ---
echo "[Entrypoint] Starting application..."
exec su-exec nextjs "$@"
