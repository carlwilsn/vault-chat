// Claude Code, fetched for the laptop app (moved out of the native shell, src-tauri/src/claude_cli.rs).
//
// Carl's setup is: install vault-chat, sign in, pick a vault. So the laptop must not need Claude Code installed first.
// When nothing is found, the pinned CLI for this platform is fetched: the same build the box runs, from the npm package
// the SDK itself pins, checked against the integrity hash the registry publishes for that exact version. It is ~350 MB
// unpacked, so it is fetched once into the app's own state dir rather than carried inside every installer.
//
// This runs in the server bundle the app carries (or the newer one in its server slot, local_server.rs), started by the
// shell as `node vault-chat-server.mjs fetch-claude-cli <stateDir>`: the shell only launches it and relays its lines,
// so how the CLI is found, fetched and checked changes with the server, never an installer. It writes one JSON object
// per line on stdout: {"progress":[done,total]} while downloading, then {"ok":{"cli","version"}} or {"error":"..."}.
//
// Where it lands is where everything already looks: <state>/claude/bin/claude is the first place the sign-in driver
// tries (claude_login.rs) and the app hands the same path to every server it starts (VC_CLAUDE_BIN).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** The CLI the SDK pins. Kept in step with package.json's @anthropic-ai/claude-agent-sdk by a test. */
export const CLI_VERSION = "0.3.321";
export const REGISTRY = "https://registry.npmjs.org";

/** The npm package holding the native CLI for a platform (Node's names), or null where Anthropic publishes none. */
export function packageFor(platform: string, arch: string): string | null {
  const ok = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
  const s = `${platform}-${arch}`;
  return ok.includes(s) ? `@anthropic-ai/claude-agent-sdk-${s}` : null;
}

export const exeName = (platform: string = process.platform) => (platform === "win32" ? "claude.exe" : "claude");
/** Where the app keeps the CLI it fetched. */
export const cliPath = (stateDir: string, platform: string = process.platform) => join(stateDir, "claude", "bin", exeName(platform));

/** `<cli> --version` → what it printed, or null if it did not run. */
export function probeCli(cli: string): string | null {
  try {
    const r = spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const text = (r.stdout ?? "").trim();
    return r.status === 0 && text ? text : null;
  } catch {
    return null;
  }
}

/** Claude Code this machine already has, wherever an installer left it (the box's pinned copy, ~/.local/bin, PATH). */
function alreadyHere(env: NodeJS.ProcessEnv): { cli: string; version: string } | null {
  const home = env.HOME || env.USERPROFILE || "";
  const exe = exeName();
  const look = home
    ? [join(home, ".local", "state", "vault-chat-server", "claude", "bin", exe), join(home, ".local", "state", "vault-chat-server", "claude", "cli", exe), join(home, ".local", "bin", exe)]
    : [];
  look.push(exe);
  for (const p of look) {
    const v = probeCli(p);
    if (v) return { cli: p, version: v };
  }
  return null;
}

/** base64(sha512(file)), in the form npm publishes it. */
export async function integrityOf(path: string): Promise<string> {
  const h = createHash("sha512");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return `sha512-${h.digest("base64")}`;
}

export type FetchDeps = {
  fetch: typeof fetch;
  /** Unpack a .tgz into a folder (tar is on every machine this runs on: Windows has bsdtar since Windows 10). */
  untar: (tgz: string, into: string) => string | null;
  probe: (cli: string) => string | null;
  platform: string;
  arch: string;
  env: NodeJS.ProcessEnv;
};

const realDeps = (): FetchDeps => ({
  fetch: globalThis.fetch,
  untar: (tgz, into) => {
    const r = spawnSync("tar", ["-xzf", tgz, "-C", into], { stdio: "ignore", windowsHide: true });
    return r.error ? `unpacking Claude Code (is tar there?): ${r.error.message}` : r.status === 0 ? null : `unpacking Claude Code failed (exit ${r.status})`;
  },
  probe: probeCli,
  platform: process.platform,
  arch: process.arch,
  env: process.env,
});

/**
 * Fetch the pinned CLI for this machine and put it where everything looks. Nothing is replaced until the new binary
 * has answered `--version` here: a truncated download or a binary for another machine must not become the thing every
 * turn runs on.
 */
export async function fetchClaudeCli(stateDir: string, progress: (done: number, total: number) => void, d: FetchDeps = realDeps()): Promise<{ cli: string; version: string }> {
  const own = cliPath(stateDir, d.platform);
  const have = d.probe(own);
  if (have) return { cli: own, version: have };
  // A machine that already has Claude Code keeps using it rather than spending 350 MB to end up where it already was.
  const here = d.probe === probeCli ? alreadyHere(d.env) : null;
  if (here) return here;
  const pkg = packageFor(d.platform, d.arch);
  if (!pkg) throw new Error(`Anthropic publishes no Claude Code for ${d.platform}-${d.arch}`);

  const meta = await d.fetch(`${REGISTRY}/${pkg}/${CLI_VERSION}`, { signal: AbortSignal.timeout(60_000) }).catch((e) => {
    throw new Error(`asking npm for ${pkg}: ${(e as Error).message}`);
  });
  if (!meta.ok) throw new Error(`npm has no ${pkg}@${CLI_VERSION} (${meta.status})`);
  const body = (await meta.json().catch(() => null)) as { dist?: { tarball?: string; integrity?: string } } | null;
  const tarball = body?.dist?.tarball ?? "";
  const integrity = body?.dist?.integrity ?? "";
  if (!tarball || !integrity.startsWith("sha512-")) throw new Error(`npm gave no verifiable download for ${pkg}@${CLI_VERSION}`);

  const dir = join(stateDir, "claude");
  mkdirSync(join(dir, "bin"), { recursive: true });
  const download = join(dir, "incoming.tgz");
  rmSync(download, { force: true });
  const res = await d.fetch(tarball, { signal: AbortSignal.timeout(20 * 60_000) }).catch((e) => {
    throw new Error(`downloading Claude Code: ${(e as Error).message}`);
  });
  if (!res.ok || !res.body) throw new Error(`downloading Claude Code: ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0) || 0;
  let done = 0;
  const out = createWriteStream(download);
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      done += chunk.length;
      progress(done, total);
    }
  } catch (e) {
    out.destroy();
    rmSync(download, { force: true });
    throw new Error(`downloading Claude Code: ${(e as Error).message}`);
  }
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));

  if ((await integrityOf(download)) !== integrity) {
    rmSync(download, { force: true });
    throw new Error("the download did not match what npm published for this version");
  }
  const unpack = join(dir, "incoming");
  rmSync(unpack, { recursive: true, force: true });
  mkdirSync(unpack, { recursive: true });
  const untarError = d.untar(download, unpack);
  if (untarError) throw new Error(untarError);
  // npm tarballs put everything under package/, and the binary carries the platform's own name there.
  const unpacked = join(unpack, "package", exeName(d.platform));
  if (!existsSync(unpacked) || !statSync(unpacked).isFile()) throw new Error(`the download held no ${exeName(d.platform)}`);
  if (d.platform !== "win32") chmodSync(unpacked, 0o755);
  const version = d.probe(unpacked);
  if (!version) throw new Error("the downloaded Claude Code would not run here");
  rmSync(own, { force: true });
  renameSync(unpacked, own);
  rmSync(unpack, { recursive: true, force: true });
  rmSync(download, { force: true });
  return { cli: own, version };
}

/** `vault-chat-server.mjs fetch-claude-cli <stateDir>`: the shell's claude_cli_ensure runs this and relays its lines. */
export async function fetchClaudeCliMain(args: string[]): Promise<number> {
  const say = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
  const stateDir = args[0];
  if (!stateDir) {
    say({ error: "fetch-claude-cli: give the app's state directory" });
    return 2;
  }
  let last = 0;
  try {
    const r = await fetchClaudeCli(stateDir, (done, total) => {
      // At most every 1 MB: the shell turns each line into an event for the sign-in's progress bar.
      if (done - last >= 1 << 20 || done === total) {
        last = done;
        say({ progress: [done, total] });
      }
    });
    say({ ok: r });
    return 0;
  } catch (e) {
    say({ error: (e as Error).message });
    return 1;
  }
}
