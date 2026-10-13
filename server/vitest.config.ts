import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const shim = (f: string) => fileURLToPath(new URL(`./shims/${f}`, import.meta.url));

export default defineConfig({
  // The in-process tests (convWire.test.ts) import the engine itself: the same
  // @tauri-apps → node shims the bundle uses (server/build.mjs).
  resolve: {
    alias: {
      "@tauri-apps/api/core": shim("core.ts"),
      "@tauri-apps/api/event": shim("event.ts"),
      "@tauri-apps/api/app": shim("app.ts"),
      "@tauri-apps/api/window": shim("window.ts"),
      "@tauri-apps/api/webviewWindow": shim("window.ts"),
      "@tauri-apps/plugin-dialog": shim("plugins.ts"),
      "@tauri-apps/plugin-opener": shim("plugins.ts"),
      "@tauri-apps/plugin-process": shim("plugins.ts"),
      "@tauri-apps/plugin-updater": shim("plugins.ts"),
      "@tauri-apps/plugin-autostart": shim("plugins.ts"),
    },
  },
  test: {
    include: ["server/test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Each file boots its own server processes on their own ports.
    fileParallelism: false,
  },
});
