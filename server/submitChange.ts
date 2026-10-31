/** Thin native job adapter: a pushed branch goes to ONE separately installed box script. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { isGatedProject } from "./projectChanges";
import { projectFolderOf } from "./projectFolders";
import { projectOfThread } from "../src/threads";
import { startServiceJob, readJobs, probeJob, type PiJobEnv } from "./engine/pi/jobs";
import { acceptedChanges, type AcceptedChange } from "./changeShipping";
import { killTree } from "./commands/proc";

export type SubmitChangeArgs = { title: string; branch: string };
export const SUBMIT_CHANGE_SCHEMA = { type: "object", additionalProperties: false, required: ["title", "branch"], properties: {
  title: { type: "string", description: "What changed, in a few words." },
  branch: { type: "string", description: "The agent/<name> branch you have already pushed to the configured remote." },
} } as const;

/** The path is fixed in installed source, not tool input or agent-writable project config. */
export function runInstalledShip(repo: string, mode: "--branch" | "--rollback", value: string, title: string, slug: string, convId: string, signal: AbortSignal, log: (text: string) => void): Promise<string> {
  const root = join(homedir(), ".local", "lib", "vault-chat", "simple-ship");
  const entry = join(root, "simple-ship.mjs"), config = join(root, "config.json");
  if (!existsSync(entry) || !existsSync(config)) throw new Error("Simple shipping is not installed. Claude must perform the one-time host installation and configure branch publishing; no old proof fallback was attempted.");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // flock is native host exclusion, not a permit. This child never inherits provider credentials.
    const env = { HOME: homedir(), PATH: process.env.PATH, LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
    const child = spawn("flock", ["-n", join(root, "ship.lock"), process.execPath, entry, config, repo, mode, value, title, slug, convId], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const stop = () => killTree(child.pid);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { const text = String(data); output += text; log(text); });
    const cleanup = () => signal.removeEventListener("abort", stop);
    child.on("error", e => { cleanup(); reject(e); });
    child.on("close", code => { cleanup(); if (signal.aborted) reject(new Error("Shipping cancelled")); else if (code !== 0) reject(new Error(`Host shipping failed (${code}); inspect the job log. ${output.slice(-1200)}`)); else resolve(output.trim()); });
  });
}
function running(o: { jobs: PiJobEnv; convId: string }): void {
  if (readJobs(o.jobs).some(j => j.conv === o.convId && j.kind === "service" && probeJob(o.jobs, j).state === "running")) throw new Error("A shipping job is already running in this conversation");
}
export async function submitChangeJob(o: { vault: string; convId: string; byCarl: boolean; jobs: PiJobEnv }, args: SubmitChangeArgs) {
  const slug = projectOfThread(o.convId), chosen = slug ? projectFolderOf(o.vault, slug) : null;
  if (!slug || !chosen || "error" in chosen || !isGatedProject(chosen.abs)) throw new Error("SubmitChange requires the current git project's conversation");
  if (!args.title?.trim() || !/^agent\/[a-z0-9][a-z0-9._/-]{0,100}$/.test(args.branch ?? "")) throw new Error("Provide a title and pushed agent branch");
  running(o);
  return startServiceJob(o.jobs, { name: "ship-branch", command: `Check and accept: ${args.title.slice(0, 120)}`, conv: o.convId, byCarl: o.byCarl, timeout: "12h" }, (signal, log) => runInstalledShip(chosen.abs, "--branch", args.branch, args.title, slug, o.convId, signal, log));
}
export async function requestRollback(o: { vault: string; accepted: AcceptedChange; reason: string; jobs: PiJobEnv; byCarl?: boolean }) {
  const changes = await acceptedChanges(o.accepted.review.folder), accepted = changes.find(c => c.id === o.accepted.id);
  if (!accepted?.acceptedAt || accepted.rollbackOf) throw new Error("Original accepted change required; a failed revert needs attention");
  if (changes.some(c => c.rollbackOf === accepted.id)) return { text: "Source rollback already accepted; release/device health pending." };
  const marker = `Source rollback ${accepted.id}`;
  const prior = [...readJobs(o.jobs)].reverse().find(j => j.kind === "service" && j.command === marker);
  if (prior) {
    if (probeJob(o.jobs, prior).state === "running") return { job: prior, text: `Source rollback already running: ${prior.id}` };
    throw new Error(`Source rollback did not accept; inspect job ${prior.id}. Needs attention, not automatic retries.`);
  }
  return startServiceJob(o.jobs, { name: "source-rollback", command: marker, conv: accepted.review.convId, byCarl: !!o.byCarl, timeout: "12h" }, (signal, log) => {
    log(o.reason);
    return runInstalledShip(accepted.review.folder, "--rollback", accepted.id, `Roll back: ${accepted.review.title}`, accepted.review.slug, accepted.review.convId, signal, log);
  });
}
