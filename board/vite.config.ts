// Placeholder for the installed ship script's fixed board build (board/README.md): nothing of it is served.
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

export default defineConfig({ root: dirname(fileURLToPath(import.meta.url)), build: { outDir: "dist", emptyOutDir: true } });
