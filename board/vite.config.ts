// The whiteboard: `npm run build:board` → board/dist (served by the box at
// /board, hashed assets under /board/assets/). `npm run dev:board` serves it on
// :1431; point it at a box with the dev proxy below (VC_BOX=http://127.0.0.1:7420).
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const box = process.env.VC_BOX || "http://127.0.0.1:7420";

export default defineConfig({
  root,
  base: "/board/",
  css: { postcss: { plugins: [] } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", assetsInlineLimit: 0 },
  server: { port: 1431, strictPort: true, proxy: { "/api": box, "/apple-touch-icon.png": box } },
});
