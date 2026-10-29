/** Installed proof toolchain. Release assets contain the exact manifests, not a developer's node_modules.
 * npm ci is public-only, credential-free and script-free; its integrity-checked result is cached by lock.
 * No agent-chosen command, npmrc, registry, install hook or host environment is imported. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser } from "./headless";
import type { ChangeHostOptions } from "./changeHost";
import { killTree } from "./commands/proc";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const pending = new Map<string, Promise<{ dependencies: string; dependencyLock: string }>>();
const executable = (name: string, path: string): string => {
  for (const d of path.split(":")) if (d && existsSync(join(d, name))) return realpathSync(join(d, name));
  throw new Error(`Installed proof toolchain needs ${name}; install it on the box before submitting`);
};

export function validatePublicProofLock(manifest: string, lock: string): void {
  const pkg = JSON.parse(manifest), parsed = JSON.parse(lock);
  if (parsed.lockfileVersion !== 3 || !parsed.packages || !parsed.packages[""]) throw new Error("Proof requires an npm v3 lockfile");
  if (pkg.workspaces || Object.values(parsed.packages).some((p: any) => p.link)) throw new Error("Proof dependencies cannot use workspaces or local links");
  for (const [name, p] of Object.entries(parsed.packages) as [string, any][]) {
    if (!name) continue;
    let u: URL;
    try { u = new URL(p.resolved); } catch { throw new Error("Proof dependency must have a public registry URL"); }
    if (u.origin !== "https://registry.npmjs.org" || u.username || u.password || u.search || u.hash || !/^sha512-[A-Za-z0-9+/]+=*$/.test(p.integrity ?? "")) throw new Error("Proof dependencies require public npm registry URLs and SHA-512 integrity");
  }
}

export function provisionProofDependencies(o: { root: string; node: string; npm: string; path: string }, manifest: string, lock: string): Promise<{ dependencies: string; dependencyLock: string }> {
  validatePublicProofLock(manifest, lock);
  const key = hash(manifest + "\0" + lock), target = join(o.root, key);
  const active = pending.get(target);
  if (active) return active;
  const result = (async () => {
    const done = join(target, "complete.json");
    if (existsSync(done)) {
      if (readFileSync(join(target, "package.json"), "utf8") !== manifest || readFileSync(join(target, "package-lock.json"), "utf8") !== lock) throw new Error("Installed proof cache identity changed");
      return { dependencies: join(target, "node_modules"), dependencyLock: join(target, "package-lock.json") };
    }
    mkdirSync(o.root, { recursive: true, mode: 0o700 });
    const tmp = mkdtempSync(join(o.root, "provision-"));
    try {
      writeFileSync(join(tmp, "package.json"), manifest);
      writeFileSync(join(tmp, "package-lock.json"), lock);
      writeFileSync(join(tmp, "npm-user"), ""); writeFileSync(join(tmp, "npm-global"), "");
      mkdirSync(join(tmp, "home"));
      const env = { PATH: o.path, HOME: join(tmp, "home"), LANG: "C.UTF-8", CI: "1", npm_config_cache: join(tmp, "npm-cache"), npm_config_userconfig: join(tmp, "npm-user"), npm_config_globalconfig: join(tmp, "npm-global"), npm_config_registry: "https://registry.npmjs.org", npm_config_ignore_scripts: "true" };
      await new Promise<void>((accept, reject) => {
        const child = spawn(o.node, [o.npm, "ci", "--ignore-scripts", "--include=dev", "--include=optional", "--no-audit", "--no-fund"], { cwd: tmp, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        let output = "", timedOut = false;
        child.stdout.on("data", d => { output += d; }); child.stderr.on("data", d => { output += d; });
        const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, 10 * 60_000);
        child.on("error", e => { clearTimeout(timer); reject(e); });
        child.on("close", code => { clearTimeout(timer); writeFileSync(join(tmp, "provision.log"), output); if (code === 0 && !timedOut) accept(); else reject(new Error(`Public proof dependency provisioning failed (${timedOut ? "timeout" : code}); check network/npm availability. Log: ${join(tmp, "provision.log")}`)); });
      });
      // Required scripts use these actual packages; --ignore-scripts still installs esbuild's platform
      // optional binary. Its use is checked by the real build gate, never an installer hook.
      for (const file of ["typescript/bin/tsc", "vitest/vitest.mjs", "tsx/dist/loader.mjs", "esbuild/bin/esbuild"]) if (!existsSync(join(tmp, "node_modules", file))) throw new Error(`Installed proof dependency missing: ${file}`);
      rmSync(join(tmp, "npm-cache"), { recursive: true, force: true });
      writeFileSync(join(tmp, "complete.json"), JSON.stringify({ key, node: process.version, scripts: false, registry: "https://registry.npmjs.org" }));
      renameSync(tmp, target);
      return { dependencies: join(target, "node_modules"), dependencyLock: join(target, "package-lock.json") };
    } catch (e) {
      // Keep failed full npm logs for diagnosis. No successful marker is written, so retry is explicit.
      throw e;
    }
  })();
  pending.set(target, result);
  void result.finally(() => { if (pending.get(target) === result) pending.delete(target); }).catch(() => {});
  return result;
}

/** Called by native submission and release-health rollback alike. No environment knobs or TOFU config
 * are needed after installing a normal release: manifests arrive inside checksummed release assets. */
export async function installedChangeHostOptions(shell: readonly string[] | null | undefined): Promise<Omit<ChangeHostOptions, "privateRoot" | "signal">> {
  if (!shell?.length || !shell[0]?.includes("bwrap") || shell.at(-1) !== "--") throw new Error("Installed bubblewrap is required for SubmitChange");
  const entry = realpathSync(fileURLToPath(import.meta.url));
  const release = dirname(entry);
  const manifestRoot = existsSync(join(release, "assets", "proof", "package-lock.json")) ? join(release, "assets", "proof") : resolve(release, "..");
  if (!existsSync(join(manifestRoot, "package-lock.json"))) throw new Error("Release is missing its checksummed proof manifests; reinstall the complete server assets");
  const path = [...new Set([dirname(realpathSync(process.execPath)), ...(process.env.PATH ?? "").split(":").filter(Boolean).map(p => { try { return realpathSync(p); } catch { return ""; } }).filter(Boolean)])].join(":");
  const node = realpathSync(process.execPath), npm = executable("npm", path);
  const browser = findBrowser();
  if (!browser) throw new Error("Installed Chromium is required for real UI proof; no acceptance was attempted");
  const root = join(homedir(), ".local", "state", "vault-chat-server", "proof-dependencies");
  const provision = (manifest: string, lock: string) => provisionProofDependencies({ root, node, npm, path }, manifest, lock);
  // Provisioning belongs to the background host job, not the submitting model turn.
  const store = { dependencies: root, dependencyLock: join(manifestRoot, "package-lock.json") };
  return { shell: [...shell], home: homedir(), installedEntry: entry, ...store, node, npm, path, browser: realpathSync(browser), provision };
}
