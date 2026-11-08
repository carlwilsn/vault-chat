import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { inlinedKatexCss } from "./katexCssGen.mjs";

/** Timing-sensitive files: they pass alone and race under parallel load. */
const SERIAL = ["server/test/updaterHttpDeadline.test.ts"];

const shim = (f: string) => fileURLToPath(new URL(`./shims/${f}`, import.meta.url));

export default defineConfig({
  // As the bundle (build.mjs): `?url` asset imports are empty, and `pdfjs-dist`
  // is the node build (voice.test.ts imports src/tools through the voice agent).
  plugins: [
    {
      name: "vc-bundle-compat",
      enforce: "pre",
      resolveId(id: string) {
        if (id.endsWith("?url")) return "\0vc-url";
        if (id === "pdfjs-dist") return shim("pdfjs.ts");
        if (id === "vc:katex-css") return "\0vc-katex";
        return null;
      },
      load(id: string) {
        if (id === "\0vc-katex") return `export default ${JSON.stringify(inlinedKatexCss(fileURLToPath(new URL("..", import.meta.url))))};`;
        return id === "\0vc-url" ? "export default '';" : null;
      },
    },
  ],
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
    // Long enough for the slowest turn-driven test on a loaded box, and no
    // longer: a wedged test should still say so inside a gate run.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Each file runs in its own process and boots its own servers on free ports, so files run in
    // parallel. The few whose assertions race the clock run afterwards, one at a time, on a quiet
    // machine.
    //
    // THREE, not six. Each worker boots a real server and the real Claude Code
    // CLI, and some drive a real browser; six of those is more than this box
    // has. Measured on the ship host's own gate run of main 7f2f775c: a load
    // average of 178 with ~1,375 processes, the journal reporting memory
    // pressure and the whole machine stalling for 42s and then 89s at a time
    // ("time jump detected, probably wake from sleep") — and the gate run died
    // mid-suite. In its baseline, 14 turn-driven tests across convlogServer,
    // claudeBackend, attachments and crossSurfaceNativeAPI timed out while
    // passing locally, so the gate was comparing two red runs. Starving the
    // suite to make it finish sooner cost more than it saved.
    maxWorkers: 3,
    projects: [
      { extends: true, test: { name: "parallel", include: ["server/test/**/*.test.ts"], exclude: [...SERIAL, "**/node_modules/**"], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: "serial", include: SERIAL, poolOptions: { forks: { singleFork: true } }, sequence: { groupOrder: 1 } } },
    ],
  },
});
