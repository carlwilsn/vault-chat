// The phone app: `npm run build:phone` → phone/dist (served by the box at
// /phone, hashed assets under /phone/assets/). `npm run dev:phone` serves it
// on :1430 with ?mock=1 for the built-in fixture box.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  base: "/phone/",
  plugins: [react()],
  // The repo's postcss config runs Tailwind for the desktop; the phone has no
  // Tailwind classes, so its CSS goes through untouched.
  css: { postcss: { plugins: [] } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // KaTeX fonts stay files (cached), not data: URIs.
    assetsInlineLimit: 0,
    // react + KaTeX + the app in one chunk; ElevenLabs is a lazy chunk.
    chunkSizeWarningLimit: 700,
  },
  server: { port: 1430, strictPort: true },
});
