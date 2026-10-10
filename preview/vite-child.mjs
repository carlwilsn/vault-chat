// One Vite dev server for one tree (before or after). Spawned by serve.mjs with
// cwd = the tree, so Tailwind's content globs and postcss resolve exactly as
// in that tree's own `npm run dev`. The tree's vite.config is NOT used
// (configFile:false): both sides run the same plain config, React + the
// preview plugin, with the tree's own installed vite and react plugin.
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import { previewPlugin } from "./plugin.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const tree = resolve(args.tree ?? process.cwd());
const port = Number(args.port ?? 1520);
const side = args.side ?? "before";
const label = args.label ?? side;
const harness = resolve(fileURLToPath(new URL("..", import.meta.url)));

const req = createRequire(resolve(tree, "package.json"));
const load = (m) => import(pathToFileURL(req.resolve(m)).href);
const vite = await load("vite");
const reactMod = await load("@vitejs/plugin-react");
const react = reactMod.default ?? reactMod;

const server = await vite.createServer({
  configFile: false,
  root: tree,
  clearScreen: false,
  logLevel: "warn",
  plugins: [react(), previewPlugin({ side, tree, label })],
  server: {
    port,
    strictPort: true,
    host: "127.0.0.1",
    // A worktree may share another checkout's node_modules through a junction;
    // Vite serves it by its real path, so allow that too.
    fs: { allow: [tree, harness, ...(existsSync(resolve(tree, "node_modules")) ? [realpathSync(resolve(tree, "node_modules"))] : [])] },
    watch: { ignored: ["**/src-tauri/target/**", "**/preview/.cache/**", "**/preview/out/**", "**/node_modules/**"] },
  },
  optimizeDeps: { entries: ["index.html"] },
});
await server.listen();
console.log(`[preview:${side}] ${label} → http://127.0.0.1:${port}/  (tree ${tree})`);
