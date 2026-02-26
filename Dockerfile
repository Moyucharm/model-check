# ========================================
# Stage 1: Dependencies
# ========================================
# https://github.com/Moyucharm/model-check
# Prisma 7 requires Node.js 22.12.0+ or 20.19.0+
FROM docker.m.daocloud.io/library/node:22-alpine AS deps
WORKDIR /app

# Install dependencies for native module compilation
RUN apk add --no-cache libc6-compat python3 make g++

# Copy package files
COPY package.json package-lock.json* ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# Install dependencies (allow better-sqlite3 native compilation)
RUN npm ci --legacy-peer-deps --ignore-scripts \
    && npm rebuild better-sqlite3

# ========================================
# Stage 2: Builder
# ========================================
FROM docker.m.daocloud.io/library/node:22-alpine AS builder
WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Set dummy DATABASE_URL for Prisma generate (no actual connection needed)
ENV DATABASE_URL="file:/tmp/model-check.db"

# Generate Prisma client with index.ts
RUN npm run db:generate

# Build application
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN npm run build

# ========================================
# Stage 3: Runner (Production)
# ========================================
FROM docker.m.daocloud.io/library/node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy necessary files from builder
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/package.json ./package.json

# Copy standalone build (includes bundled dependencies)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy Prisma adapter runtime (required for Prisma v7 adapter pattern)
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder /app/node_modules/bindings ./node_modules/bindings
COPY --from=builder /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
COPY --from=builder /app/node_modules/node-addon-api ./node_modules/node-addon-api
COPY --from=builder /app/node_modules/prebuild-install ./node_modules/prebuild-install
COPY --from=builder /app/node_modules/dotenv ./node_modules/dotenv

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/status || exit 1

CMD ["node", "server.js"]
