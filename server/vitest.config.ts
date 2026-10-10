import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Each file boots its own server processes on their own ports.
    fileParallelism: false,
  },
});
