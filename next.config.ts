import type { NextConfig } from "next";
import { readFileSync } from "fs";

const isWindows = process.platform === "win32";
const forceStandalone = process.env.NEXT_STANDALONE === "true";
const disableStandalone = process.env.NEXT_STANDALONE === "false";

// Read version from package.json at build time
const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

const nextConfig: NextConfig = {
  // Disable x-powered-by header for security
  poweredByHeader: false,
  // Avoid Windows traced-file copy warnings by default.
  ...(forceStandalone || (!isWindows && !disableStandalone)
    ? { output: "standalone" as const }
    : {}),
  // Inject build-time environment variables
  env: {
    APP_VERSION: pkg.version,
  },
};

export default nextConfig;
