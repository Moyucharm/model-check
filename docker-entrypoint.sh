#!/bin/sh
set -e

# ========================================
# Docker Entrypoint
# Handles: directory permissions + DB schema initialization
# ========================================

DATA_DIR="/app/data"
DB_FILE="${DATA_DIR}/model-check.db"
PRISMA_CLI_JS="/app/node_modules/prisma/build/index.js"

run_prisma_db_push() {
  if [ -f "${PRISMA_CLI_JS}" ]; then
    su-exec nextjs node "${PRISMA_CLI_JS}" db push --skip-generate
    return $?
  fi

  echo "[Entrypoint] Error: Prisma CLI not found in image."
  return 1
}

# --- 1. Ensure data directory has correct ownership ---
mkdir -p "${DATA_DIR}"
chown nextjs:nodejs "${DATA_DIR}"

# --- 2. Initialize / sync database schema ---
if [ ! -f "${DB_FILE}" ]; then
  echo "[Entrypoint] Database not found, initializing schema..."
  run_prisma_db_push 2>&1 || {
    echo "[Entrypoint] Warning: Schema init failed. App may not work correctly."
  }
else
  echo "[Entrypoint] Database exists, syncing schema..."
  run_prisma_db_push 2>&1 || {
    echo "[Entrypoint] Warning: Schema sync failed. Manual migration may be needed."
  }
fi

# --- 3. Start application as nextjs user ---
echo "[Entrypoint] Starting application..."
exec su-exec nextjs "$@"
