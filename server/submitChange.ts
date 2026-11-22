/** Thin native job adapter: a pushed branch goes to ONE separately installed box script. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isGatedProject } from "./projectChanges";
import { projectFolderOf } from "./projectFolders";
import { projectOfThread } from "../src/threads";
import { startServiceJob, readJobs, probeJob, type JobEnv } from "./engine/jobs";
import { killTree } from "./commands/proc";

export type SubmitChangeArgs = { title: string; branch: string };
export const SUBMIT_CHANGE_SCHEMA = { type: "object", additionalProperties: false, required: ["title", "branch"], properties: {
  title: { type: "string", description: "What changed, in a few words." },
  branch: { type: "string", description: "The agent/<name> branch you have already pushed to the configured remote." },
} } as const;

const LOCK_BUSY = 75, LOCK_WAIT_S = 6 * 3600;
export const SHIP_LOCK_BUSY = 75, SHIP_LOCK_WAIT_S = 6 * 3600;
/** The path is fixed in installed source, not tool input or agent-writable project config. */
export function runInstalledShip(repo: string, mode: "--branch", value: string, title: string, slug: string, convId: string, signal: AbortSignal, log: (text: string) => void): Promise<string> {
  if (mode !== "--branch") throw new Error("Only proven branch submission is supported");
  const root = join(homedir(), ".local", "lib", "vault-chat", "simple-ship");
  const entry = join(root, "simple-ship.mjs"), config = join(root, "config.json");
  if (!existsSync(entry) || !existsSync(config)) throw new Error("Simple shipping is not installed. Claude must perform the one-time host installation and configure branch publishing; no old proof fallback was attempted.");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // flock is native host exclusion, not a permit: like ship-request.sh, wait for a ship already running
    // (another lane's) instead of failing at once; 75 = still held after 6 h. No provider credentials inherited.
    // It WAITS for the lock (up to 6 h): another lane or the old watcher shipping is a queue, not a failure
    // (with -n every SubmitChange made while another ship ran failed at once with no output).
    const env = { HOME: homedir(), PATH: process.env.PATH, LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
    const child = spawn("flock", ["-E", String(LOCK_BUSY), "-w", String(LOCK_WAIT_S), join(root, "ship.lock"), process.execPath, entry, config, repo, mode, value, title, slug, convId], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      // Give the installed CLI its native cancellation signal before a bounded force-stop.
      // It owns detached git/bwrap children that are not in flock's process group.
      try { process.kill(-child.pid!, "SIGTERM"); } catch { killTree(child.pid); }
      forceStop = setTimeout(() => killTree(child.pid), 5_000); forceStop.unref();
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { const text = String(data); output += text; log(text); });
    const cleanup = () => { signal.removeEventListener("abort", stop); if (forceStop) clearTimeout(forceStop); };
    child.on("error", e => { cleanup(); reject(e); });
    child.on("close", code => { cleanup(); if (signal.aborted) reject(new Error("Shipping cancelled")); else if (code === LOCK_BUSY) reject(new Error(`Another ship held the ship lock for ${LOCK_WAIT_S / 3600} h; nothing was checked.`)); else if (code === SHIP_LOCK_BUSY) reject(new Error(`Another ship held the ship lock for ${SHIP_LOCK_WAIT_S / 3600} h; submit again.`)); else if (code !== 0) reject(new Error(`Host shipping failed (${code}); inspect the job log. ${output.slice(-1200)}`)); else resolve(output.trim()); });
  });
}
function running(o: { jobs: JobEnv; convId: string }): void {
  if (readJobs(o.jobs).some(j => j.conv === o.convId && j.kind === "service" && probeJob(o.jobs, j).state === "running")) throw new Error("A shipping job is already running in this conversation");
}
/** The installed script's capture of the live data fails whenever anything appends during its copy (any chat turn,
 *  a session's own Ledger write). It fails within seconds, before any gate, so the job itself tries again a little
 *  later, like the old watcher did: no session wakes for it. */
export const CAPTURE_FLAKE = /Fresh stable real-data capture failed/;
export async function shipRetryingCapture(run: () => Promise<string>, o: { signal: AbortSignal; log: (text: string) => void; tries?: number; delayMs?: number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }): Promise<string> {
  const tries = o.tries ?? 40, delayMs = o.delayMs ?? 30_000;
  const sleep = o.sleep ?? ((ms: number, signal: AbortSignal) => new Promise<void>((res, rej) => {
    const stop = () => { clearTimeout(t); rej(new Error("Shipping cancelled")); };
    const t = setTimeout(() => { signal.removeEventListener("abort", stop); res(); }, ms);
    signal.addEventListener("abort", stop, { once: true });
  }));
  for (let n = 1; ; n++) {
    try {
      return await run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (o.signal.aborted || n >= tries || !CAPTURE_FLAKE.test(msg)) throw e;
      o.log(`Live data changed during the real-data capture (try ${n}/${tries}); trying again in ${Math.round(delayMs / 1000)} s.`);
      await sleep(delayMs, o.signal);
    }
  }
}

/** The job's outcome as a ship result (<results>/<name>.result, the watcher's format), so a session's
 *  WaitFor {branch} wakes on it and the box's own resubmit (engine/shipAuto.ts) reads it like any other. */
export function writeShipResult(dir: string, name: string, branch: string, ok: boolean, output: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.result`), `exit=${ok ? 0 : 1}\nbranch=${branch}\nfinished=${new Date().toISOString()}\n${output.trim().slice(-4000)}\n`);
}

export async function submitChangeJob(o: { vault: string; convId: string; /** The conversation's project (a project's thread, or a work session of one): default from the thread id. */ slug?: string | null; byCarl: boolean; jobs: JobEnv; /** Where the outcome is written for WaitFor {branch}; none: not written. */ results?: string; retry?: { tries?: number; delayMs?: number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } }, args: SubmitChangeArgs) {
  const slug = o.slug ?? projectOfThread(o.convId), chosen = slug ? projectFolderOf(o.vault, slug) : null;
  if (!slug || !chosen || "error" in chosen || !isGatedProject(chosen.abs)) throw new Error("SubmitChange requires the current git project's conversation");
  if (!args.title?.trim() || !/^agent\/[a-z0-9][a-z0-9._/-]{0,100}$/.test(args.branch ?? "")) throw new Error("Provide a title and pushed agent branch");
  running(o);
  return startServiceJob(o.jobs, { name: "ship-branch", command: `Check and accept: ${args.title.slice(0, 120)}`, conv: o.convId, byCarl: o.byCarl, timeout: "12h" }, async (signal, log) => {
    const name = `sc-${args.branch.replace(/^agent\//, "").replace(/[^a-z0-9._-]+/g, "-").slice(0, 60)}-${Date.now().toString(36)}`;
    try {
      const out = await shipRetryingCapture(() => runInstalledShip(chosen.abs, "--branch", args.branch, args.title, slug, o.convId, signal, log), { signal, log, ...o.retry });
      if (o.results) writeShipResult(o.results, name, args.branch, true, out);
      return out;
    } catch (e) {
      if (o.results && !signal.aborted) writeShipResult(o.results, name, args.branch, false, e instanceof Error ? e.message : String(e));
      throw e;
    }
  });
}
