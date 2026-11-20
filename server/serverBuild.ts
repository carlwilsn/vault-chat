// The box's accepted server build, offered to the laptop's server slot (src-tauri/src/local_server.rs).
//
// The box runs the server build the ship gate accepted (server/deploy/vault-chat-update.sh promotes it into
// versions/<rev>). It offers that same file to the laptop app, which keeps it in its versioned server slot: the app's
// own server (a machine with no box, or the box out of reach) and the server-side tools the shell runs
// (fetch-claude-cli) then come from the box's newest accepted build instead of the installer's. No installer, no
// GitHub release.
//
//   GET /api/v2/server-build        {version, sha256, rev, size}: the build this box runs (version: first 8 hex of sha256)
//   GET /api/v2/server-build/file   its bytes
//
// `vault-chat-server.mjs fill-server-slot <stateDir>` (run by the laptop shell's server_tool, the box address and token
// on stdin as {"url","token"}) asks the box, and when its build is not the slot's current one nor marked bad there,
// downloads it beside the slot, checks the sha256, and points current.json at it. One JSON line out: {"ok":{...}} or
// {"error":"..."}.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_REV } from "./config";

export type ServerBuild = { version: string; sha256: string; rev: string; size: number };

/** The file this server runs from (the bundle; in development, dist-server's). */
export function ownBundle(): string | null {
  const here = process.argv[1] && /vault-chat-server\.mjs$/.test(process.argv[1]) ? process.argv[1] : (() => { try { return fileURLToPath(import.meta.url); } catch { return null; } })();
  return here && /vault-chat-server\.mjs$/.test(here) && existsSync(here) ? here : null;
}

let cached: { path: string; mtime: number; build: ServerBuild } | null = null;
export function serverBuild(path = ownBundle()): ServerBuild | null {
  if (!path) return null;
  const st = statSync(path);
  if (cached && cached.path === path && cached.mtime === st.mtimeMs) return cached.build;
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  const build = { version: sha256.slice(0, 8), sha256, rev: SERVER_REV, size: st.size };
  cached = { path, mtime: st.mtimeMs, build };
  return build;
}

/** GET /api/v2/server-build[/file]. */
export function serverBuildRoute(sub: string, path = ownBundle()): { status: number; json?: unknown; bytes?: Buffer } {
  const b = path ? serverBuild(path) : null;
  if (!b || !path) return { status: 404, json: { error: "this server runs from no bundle file" } };
  if (sub === "" || sub === "/") return { status: 200, json: b };
  if (sub === "/file") return { status: 200, bytes: readFileSync(path) };
  return { status: 404, json: { error: "no such thing" } };
}

type Slots = { current: { version: string; sha256: string } | null; bad: string[] };
function readSlots(dir: string): Slots {
  const read = (f: string) => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; } };
  const c = read("current.json");
  const bad = read("bad.json");
  return { current: c && typeof c.version === "string" && typeof c.sha256 === "string" ? c : null, bad: Array.isArray(bad) ? bad.filter((x: unknown) => typeof x === "string") : [] };
}

/** Bring the box's build into the slot dir (stateDir/server-slots). Returns what the slot holds now. */
export async function fillServerSlot(stateDir: string, box: { url: string; token?: string | null }, f: typeof fetch = globalThis.fetch): Promise<{ version: string; changed: boolean }> {
  const base = box.url.replace(/\/+$/, "");
  const headers: Record<string, string> = box.token ? { "x-vault-token": box.token } : {};
  const r = await f(`${base}/api/v2/server-build`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`the box answered ${r.status} for its server build`);
  const b = (await r.json()) as Partial<ServerBuild>;
  if (typeof b.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.sha256) || b.version !== b.sha256.slice(0, 8)) throw new Error("the box named no server build");
  const dir = join(stateDir, "server-slots");
  const s = readSlots(dir);
  if (s.current?.version === b.version) return { version: b.version, changed: false };
  if (s.bad.includes(b.version)) throw new Error(`${b.version} failed here before: not taken`);
  const file = await f(`${base}/api/v2/server-build/file`, { headers, signal: AbortSignal.timeout(10 * 60_000) });
  if (!file.ok) throw new Error(`the box answered ${file.status} for its server build's file`);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== b.sha256) throw new Error("the server build did not match its hash: not taken");
  const vdir = join(dir, b.version);
  mkdirSync(vdir, { recursive: true });
  writeFileSync(join(vdir, "vault-chat-server.mjs.tmp"), bytes);
  renameSync(join(vdir, "vault-chat-server.mjs.tmp"), join(vdir, "vault-chat-server.mjs"));
  writeFileSync(join(dir, "current.json.tmp"), JSON.stringify({ version: b.version, sha256: b.sha256, rev: b.rev ?? null }));
  renameSync(join(dir, "current.json.tmp"), join(dir, "current.json"));
  // The one before stays (the shell falls back to the installer's own, not to it); older ones go.
  if (s.current && s.current.version !== b.version) {
    for (const v of readdirSafe(dir)) if (/^[0-9a-f]{8}$/.test(v) && v !== b.version && v !== s.current.version) rmSync(join(dir, v), { recursive: true, force: true });
  }
  return { version: b.version, changed: true };
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** `vault-chat-server.mjs fill-server-slot <stateDir>`, {"url","token"} on stdin. */
export async function fillServerSlotMain(args: string[]): Promise<number> {
  const say = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
  try {
    if (!args[0]) throw new Error("fill-server-slot: give the app's state directory");
    const box = JSON.parse((await stdinText()) || "{}") as { url?: string; token?: string | null };
    if (!box.url || !/^https?:\/\//.test(box.url)) throw new Error("fill-server-slot: no box address on stdin");
    say({ ok: await fillServerSlot(args[0], { url: box.url, token: box.token ?? null }) });
    return 0;
  } catch (e) {
    say({ error: (e as Error).message });
    return 1;
  }
}
