// Vitest config for scripts/perf/*.perf.ts — run only through the .mjs beside each one, never by `npm test`.
import { defineConfig } from "vitest/config";
import path from "path";

const root = path.resolve(__dirname, "../..");

export default defineConfig({
  root,
  test: {
    globals: true,
    environment: "node",
    include: ["scripts/perf/**/*.perf.ts"],
    // The same guard the integration tests use: it refuses the production database.
    setupFiles: ["./tests/setup-test-db.ts"],
    fileParallelism: false,
    testTimeout: 40 * 60_000,
    hookTimeout: 40 * 60_000,
    server: { deps: { inline: ["next-auth", "@auth/core"] } },
  },
  resolve: { alias: { "@": root } },
});
