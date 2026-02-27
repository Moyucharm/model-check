#!/bin/sh
set -e

# ========================================
# Docker Entrypoint
# Handles: directory permissions + DB schema initialization
# ========================================

DATA_DIR="/app/data"
DB_FILE="${DATA_DIR}/model-check.db"
PRISMA_CLI_JS="/app/node_modules/prisma/build/index.js"
APP_USER="nextjs"
APP_GROUP="nodejs"
RUN_AS="${APP_USER}"

log() {
  echo "[Entrypoint] $*"
}

run_as_app_user() {
  if [ -n "${RUN_AS}" ]; then
    su-exec "${RUN_AS}" "$@"
  else
    "$@"
  fi
}

run_prisma_db_push() {
  if [ -f "${PRISMA_CLI_JS}" ]; then
    run_as_app_user node "${PRISMA_CLI_JS}" db push
    return $?
  fi

  log "Error: Prisma CLI not found in image."
  return 1
}

# --- 1. Ensure data directory has correct ownership ---
mkdir -p "${DATA_DIR}" || {
  log "Error: Failed to create ${DATA_DIR}"
  exit 1
}

# Best-effort chown: bind mounts (rootless/NFS) may not allow it.
if chown "${APP_USER}:${APP_GROUP}" "${DATA_DIR}" 2>/dev/null; then
  :
else
  log "Warning: chown ${DATA_DIR} failed (continuing)."
fi

# If the non-root user still can't write, fall back to root to keep the container usable.
if su-exec "${APP_USER}" sh -c "test -w '${DATA_DIR}'"; then
  RUN_AS="${APP_USER}"
else
  log "Warning: ${DATA_DIR} is not writable for ${APP_USER}; running as root."
  RUN_AS=""
fi

# --- 2. Initialize / sync database schema ---
if [ ! -f "${DB_FILE}" ]; then
  log "Database not found, initializing schema..."
  run_prisma_db_push 2>&1 || {
    log "Warning: Schema init failed. App may not work correctly."
  }
else
  log "Database exists, syncing schema..."
  run_prisma_db_push 2>&1 || {
    log "Warning: Schema sync failed. Manual migration may be needed."
  }
fi

# --- 3. Start application as nextjs user ---
log "Starting application..."
if [ -n "${RUN_AS}" ]; then
  exec su-exec "${RUN_AS}" "$@"
else
  exec "$@"
fi
