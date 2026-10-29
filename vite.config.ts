import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const host = process.env.TAURI_DEV_HOST;
// Pin the actual built checkout, including CI's version commit. Never infer it
// from the box's current revision or a release-health challenge at runtime.
let appRevision = "unknown";
try {
  const options = { cwd: new URL(".", import.meta.url), encoding: "utf8" as const, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
  // Cargo metadata may rewrite Cargo.lock's package version before Vite runs.
  // Pin the actual frontend inputs and native source/config, not generated build outputs.
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal", "--", "src", "src-tauri/src", "src-tauri/defaults", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json", "tsconfig.node.json", "index.html", "tailwind.config.js", "postcss.config.js"], options).trim();
  if (!dirty) appRevision = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
} catch { /* dirty checkout / source archive: release health remains pending */ }

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  // The app's version on every app-log line (src/debugLog.ts).
  define: { __APP_REVISION__: JSON.stringify(appRevision), __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version) },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
