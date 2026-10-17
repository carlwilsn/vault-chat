// The whiteboard: `npm run build:board` → board/dist (served by the box at
// /board, hashed assets under /board/assets/). `npm run dev:board` serves it on
// :1431; point it at a box with the dev proxy below (VC_BOX=http://127.0.0.1:7420).
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import tailwind from "tailwindcss";
import autoprefixer from "autoprefixer";

const root = dirname(fileURLToPath(import.meta.url));
const box = process.env.VC_BOX || "http://127.0.0.1:7420";

export default defineConfig({
  root,
  base: "/board/",
  // The chrome is Tailwind (board/tailwind.config.js: the desktop's config as a preset).
  css: { postcss: { plugins: [tailwind({ config: join(root, "tailwind.config.js") }), autoprefixer()] } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", assetsInlineLimit: 0 },
  // node_modules may be a link to another checkout: pdf.js's worker is served from there.
  server: { port: 1431, strictPort: true, fs: { allow: [join(root, ".."), realpathSync(join(root, "..", "node_modules"))] }, proxy: { "/api": box, "/poll": box, "/apple-touch-icon.png": box } },
});
