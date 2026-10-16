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
    // react + KaTeX + the markdown pipeline (the desktop's remark/rehype chain,
    // shared via src/mdPipeline.ts: ~930 kB, ~290 kB gzipped) + the app in
    // one chunk; ElevenLabs is a lazy chunk. (Not split further:
    // phone/preview.mjs inlines the build into one page.)
    chunkSizeWarningLimit: 1000,
  },
  server: { port: 1430, strictPort: true },
});
