import { defineConfig } from "vitest/config";

// CONTEXT's own tests: no server build, no processes — a temp vault and a fake model.
export default defineConfig({
  test: {
    include: ["server/context/test/**/*.test.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
