import { defineConfig } from "vitest/config";
import path from "path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "node",
    include: [
      "tests/unit/**/*.test.ts",
      "tests/unit/**/*.test.tsx",
      "tests/integration/**/*.test.ts",
    ],
    setupFiles: ["./tests/setup-test-db.ts"],
    // Windows + vitest 4 + @vitejs/plugin-react: the parallel runner races
    // during module resolution across 80+ files, producing "Vitest failed
    // to find the runner" on every file. Both `pool: "threads"` (default)
    // and `pool: "forks"` exhibit the race. The CLI flag
    // --no-file-parallelism works, so we mirror it via fileParallelism:
    // false. Tests run serially per file but each file still runs its
    // suites in parallel internally. ~30-60s vs ~5s walltime trade-off
    // for reliable Windows test execution. Long-term fix tracked in
    // docs/KIDS-FULL-VERIFICATION-2026-05-15.md "side findings".
    fileParallelism: false,
    // tests/integration/** talk to a real Neon Postgres branch over the
    // network. A single case is a dozen sequential round-trips, and Neon
    // adds a multi-second cold start on the first query of a run, so the
    // 5s/10s vitest defaults time out on latency alone — the first real-DB
    // run of this suite lost 6 cases that way, and each timeout left its
    // fixtures half-built so later cases in the same file failed too
    // (e.g. the 10-kid cap test aborting mid-loop, then the next create
    // hitting the cap it had already filled). Unit tests finish in
    // milliseconds and are unaffected by the larger ceiling.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
