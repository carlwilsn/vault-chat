// Prepare, NEVER install/restart/promote. Claude performs the one-time installation in docs/simple-ship.md.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
const out = process.argv[2];
if (!out || !out.startsWith("/")) throw new Error("Pass a NEW absolute staging directory");
const pin = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Commit the batch before preparing an installation");
mkdirSync(out, { mode: 0o700 });
await build({ entryPoints: ["server/simpleShipHost.ts"], outfile: join(out, "simple-ship.mjs"), bundle: true, platform: "node", format: "esm", target: "node22" });
writeFileSync(join(out, "source-pin.txt"), pin + "\n");
for (const name of ["package.json", "package-lock.json"]) writeFileSync(join(out, name), readFileSync(name));
const paths = (process.env.PATH ?? "").split(":").filter(Boolean);
const find = name => {
  for (const dir of paths) if (existsSync(join(dir, name))) return realpathSync(join(dir, name));
  throw new Error(`Missing installed executable: ${name}`);
};
const npm = find("npm");
// npm is a JS entry invoked by node, but child npm commands need the package's REAL bin directory.
const npmBin = npm.includes("/lib/node_modules/npm/") ? npm.split("/lib/node_modules/npm/")[0] + "/bin" : dirname(npm);
if (!existsSync(join(npmBin, "npm"))) throw new Error("Missing real npm executable bin directory");
const root = join(homedir(), ".local/lib/vault-chat/simple-ship");
const bwrap = readdirSync("/nix/store").filter(s => /-bubblewrap-[0-9]/.test(s)).map(s => join("/nix/store", s, "bin/bwrap")).find(existsSync);
if (!bwrap) throw new Error("Installed bubblewrap is required");
const config = { repo: "/home/carlwilsn/vc/projects/vault-chat", remote: "origin", workRoot: join(homedir(), ".local/state/vault-chat-server/simple-ship"), dependencies: join(root, "dependencies/node_modules"), pi: process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0"), node: realpathSync(process.execPath), npm, bash: realpathSync("/run/current-system/sw/bin/bash"), bwrap, path: [...new Set([npmBin, dirname(realpathSync(process.execPath)), ...paths.map(p => { try { return realpathSync(p); } catch { return ""; } }).filter(p => p.startsWith("/nix/store/"))])].join(":") };
if (!existsSync(join(config.pi, "node_modules/@earendil-works/pi-coding-agent/package.json"))) throw new Error("Installed pi SDK 1.1.0 is required");
writeFileSync(join(out, "config.example.json"), JSON.stringify(config, null, 2) + "\n");
console.log(`Prepared ${pin} in ${resolve(out)}. Not installed, accepted, or Shipped.`);
