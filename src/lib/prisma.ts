import { PrismaClient } from "@/generated/prisma";
import * as BetterSqliteAdapter from "@prisma/adapter-better-sqlite3";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

type BetterSqliteCtor = new (
  options: { url: string },
  config?: { timestampFormat?: "iso8601" | "unixepoch-ms" }
) => unknown;

const adapterCtorCandidate =
  (BetterSqliteAdapter as Record<string, unknown>).PrismaBetterSqlite3 ??
  (BetterSqliteAdapter as Record<string, unknown>).PrismaBetterSQLite3;

if (typeof adapterCtorCandidate !== "function") {
  throw new Error(
    "Failed to load SQLite Prisma adapter from @prisma/adapter-better-sqlite3."
  );
}

const sqliteUrl = process.env.DATABASE_URL || "file:./data/model-check.db";
const sqliteAdapter = new (adapterCtorCandidate as BetterSqliteCtor)(
  { url: sqliteUrl },
  { timestampFormat: "iso8601" }
);

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    adapter: sqliteAdapter,
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
