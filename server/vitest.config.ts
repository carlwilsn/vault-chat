import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { inlinedKatexCss } from "./katexCssGen.mjs";

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
    include: ["server/test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Each file boots its own server processes on their own ports.
    fileParallelism: false,
  },
});
