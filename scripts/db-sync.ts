// SQLite schema sync helper.
// Uses Prisma to push schema changes to the local SQLite file.

import "dotenv/config";
import { execSync } from "node:child_process";

function main() {
  try {
    execSync("npx prisma db push", { stdio: "inherit" });
    console.log("Database schema synced successfully.");
  } catch (error) {
    console.error("Database schema sync failed:", error);
    process.exit(1);
  }
}

main();
