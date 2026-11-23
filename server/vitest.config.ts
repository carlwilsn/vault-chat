import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { appCss } from "./appCssGen.mjs";
import { pageLinkHostJs } from "./pageLinkHostGen.mjs";

/** Timing-sensitive files: they pass alone and race under parallel load. */
const SERIAL = ["server/test/updaterHttpDeadline.test.ts", "server/test/pdfTyping.test.ts"];

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
        if (id === "vc:app-css") return "\0vc-app-css";
        if (id === "vc:page-link-host") return "\0vc-page-link-host";
        return null;
      },
      async load(id: string) {
        if (id === "\0vc-page-link-host") return `export default ${JSON.stringify(await pageLinkHostJs(fileURLToPath(new URL("..", import.meta.url))))};`;
        if (id === "\0vc-app-css") return `export default ${JSON.stringify(await appCss(fileURLToPath(new URL("..", import.meta.url))))};`;
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
    // parallel. The few whose assertions race the clock run afterwards, one file at a time, on a quiet
    // machine (updaterHttpDeadline's own cases run side by side there: each owns its temp dir, ports
    // and processes).
    //
    // Six. Measured 2026-11-23 on a quiet box, main 8d3bd22a, the ship's own sandbox, 2 runs each, all
    // 1185 tests green every run: 3 workers 336/334 s, 4: 280/280 s, 6: 234/229 s, 12: 184/184 s
    // (report 30-ship-time). 12 shipped first (f9b9931e); then a 12-worker gate run lost convlogServer's
    // "steer intent and queue both wait for native follow-ups" (the queued message not yet in the feed:
    // a timing race that also failed 3 times in ~440 earlier 3-worker runs), so, by the rule that the
    // count comes down when anything flakes, six. The earlier overload at 6 (gate run of main 7f2f775c:
    // load average 178, ~1,375 processes) did not recur in these runs.
    maxWorkers: 6,
    projects: [
      { extends: true, test: { name: "parallel", include: ["server/test/**/*.test.ts"], exclude: [...SERIAL, "**/node_modules/**"], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: "serial", include: SERIAL, poolOptions: { forks: { singleFork: true } }, sequence: { groupOrder: 1 } } },
    ],
  },
});
