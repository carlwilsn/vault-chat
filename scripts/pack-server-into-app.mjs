// Builds the vault-chat server bundle and puts it where the desktop app ships it.
//
// With no box, the app runs that server itself on loopback
// (src-tauri/src/local_server.rs) — so a packaged app has to carry it, or a
// fresh install can only say "connect a box instead". The bundle goes beside
// the Node runtime download-node.mjs fetches, in src-tauri/binaries/, which the
// bundle ships as a resource (tauri.conf.json).
//
// Runs from the Tauri prebuild hook, so every build of the app carries the
// server built from the same commit.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const built = resolve(repoRoot, "dist-server", "vault-chat-server.mjs");
const outDir = resolve(repoRoot, "src-tauri", "binaries");
const out = resolve(outDir, "vault-chat-server.mjs");

// The same build the box's release gets (phone and board apps included), so a
// laptop with no box can serve its phone too, and so a build here never leaves
// dist-server holding a leaner bundle than the release pipeline expects.
const r = spawnSync("npm", ["run", "build:server"], { cwd: repoRoot, stdio: "inherit", shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);
if (!existsSync(built)) {
  console.error(`pack-server-into-app: server/build.mjs left no bundle at ${built}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
copyFileSync(built, out);
console.log(`server bundle at ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
