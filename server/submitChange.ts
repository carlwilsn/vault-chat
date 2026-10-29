/** Native SubmitChange: the installed host, not pi, runs proof via the existing job lifecycle. */
import { join } from "node:path";
import { cloneDirOf, isGatedProject } from "./projectChanges";
import { projectFolderOf } from "./projectFolders";
import { projectOfThread } from "../src/threads";
import { readConv } from "./engine/convs";
import { startServiceJob, readJobs, probeJob, type PiJobEnv } from "./engine/pi/jobs";
import { pinChange, proveAndAcceptChange, type ChangeHostOptions, type SubmitCheck } from "./changeHost";
import type { AskCheck } from "./changeProof";

export type SubmitChangeArgs = SubmitCheck & { title: string };
/** No source SHA, request text, folder, shell, command, URL, test result, permit or proof path in tool input. */
export const SUBMIT_CHANGE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["title", "assessment", "evidence", "surface", "ui"], properties: {
    title: { type: "string", description: "What changed, in a few words." },
    assessment: { type: "string", description: "Your explicit self-check against Carl's last request; an agent judgment, not machine proof of intent." },
    evidence: { type: "array", items: { type: "string" }, minItems: 1, description: "Implementation locations and observable behavior satisfying the request." },
    surface: { type: "string", enum: ["phone", "board", "desktop"] },
    ui: { type: "object", additionalProperties: false, required: ["steps"], properties: {
      steps: { type: "array", items: { type: "object" }, description: "Existing RecordUI browser steps: actual input and waitFor assertions. No run/goto. Host supplies the candidate URL." },
      seconds: { type: "number" }, mobile: { type: "boolean" }, width: { type: "number" }, height: { type: "number" },
    } },
  },
} as const;

/** Called by the installed engine for its current project conversation, never from an arbitrary path route.
 * Capture the last real user message once, before async work; model prose cannot replace the original ask.
 */
export async function submitChangeJob(o: { vault: string; convId: string; byCarl: boolean; jobs: PiJobEnv; host: Omit<ChangeHostOptions, "privateRoot" | "signal"> }, args: SubmitChangeArgs): Promise<{ text: string; job?: import("./engine/pi/jobs").JobRec }> {
  const slug = projectOfThread(o.convId);
  const chosen = slug ? projectFolderOf(o.vault, slug) : null;
  if (!slug || !chosen || "error" in chosen || !isGatedProject(chosen.abs)) throw new Error("SubmitChange is only for the current git project's own conversation");
  if (readJobs(o.jobs).some(j => j.conv === o.convId && j.kind === "service" && probeJob(o.jobs, j).state === "running")) throw new Error("A host proof task already belongs to this conversation; inspect its existing job, do not submit twice");
  if (typeof args.title !== "string" || !args.title.trim() || typeof args.assessment !== "string" || !args.assessment.trim() || !Array.isArray(args.evidence) || !args.evidence.length || args.evidence.some(s => typeof s !== "string" || !s.trim())) throw new Error("SubmitChange needs a title and explicit ask self-check with evidence");
  const lastUser = async () => {
    const conv = await readConv(o.vault, o.convId);
    return conv ? [...conv.messages].reverse().find(m => m.role === "user" && !m.system && !m.hidden) : undefined;
  };
  const user = await lastUser();
  if (!user?.mid || !user.content?.trim()) throw new Error("No existing last user request to bind this submission to");
  const ask: AskCheck = { requestId: user.mid, requestText: user.content, assessment: args.assessment, evidence: [...args.evidence] };
  const requestId = user.mid;
  const title = args.title.trim().slice(0, 120);
  if (readJobs(o.jobs).some(j => j.conv === o.convId && j.kind === "service" && probeJob(o.jobs, j).state === "running")) throw new Error("A host proof task already started while resolving the request; inspect that existing job");
  const check = structuredClone(args);
  return startServiceJob(o.jobs, { name: "submit-change", command: `Prove and accept: ${title}`, conv: o.convId, byCarl: o.byCarl, timeout: "12h" }, async (signal, log) => {
    const current = await lastUser();
    if (current?.mid !== requestId) throw new Error("Carl's request changed before proof started; resubmit with a fresh self-check");
    const pinned = await pinChange({ vault: o.vault, convId: o.convId, slug, folder: chosen.abs, clone: cloneDirOf(o.vault, slug), title });
    log(`Pinned baseline ${pinned.source.base}, candidate ${pinned.source.head}. Seven gates on each, then candidate-backed RecordUI.`);
    const result = await proveAndAcceptChange({ ...o.host, privateRoot: join(o.vault, ".vault-chat", "local", "change-proof"), signal, onProgress: log }, pinned, ask, check, async () => {
      signal.throwIfAborted();
      if ((await lastUser())?.mid !== requestId) throw new Error("Carl's last request changed during proof; no acceptance, resubmit after reviewing the new ask");
    });
    log(`Full host evidence: ${result.proofDir}`);
    if (!result.accepted) throw new Error(result.text);
    return result.text;
  });
}

/** Same installed host pipeline for card clicks and deterministic negative release health. No agent turn,
 * no extra model call, no shell action from the client. Journal rollbackOf is the restart/idempotency key. */
export async function requestRollback(o: { vault: string; accepted: import("./changeShipping").AcceptedChange; reason: string; jobs: PiJobEnv; host: Omit<ChangeHostOptions, "privateRoot" | "signal">; byCarl?: boolean }): Promise<{ text: string; job?: import("./engine/pi/jobs").JobRec }> {
  const { acceptedChanges } = await import("./changeShipping");
  const { prepareSourceRollback, ROLLBACK_CHECK } = await import("./sourceRollback");
  const accepted = (await acceptedChanges(o.accepted.review.folder)).find(c => c.id === o.accepted.id);
  if (!accepted) throw new Error("Source rollback requires an existing accepted change identity");
  if (accepted.rollbackOf) throw new Error("A revert release failed: needs attention, not an automatic revert of its revert");
  const existing = (await acceptedChanges(accepted.review.folder)).find(c => c.rollbackOf === accepted.id);
  if (existing) return { text: `Source rollback already accepted: ${existing.id}. Laptop sync/CI/device recovery remains pending.` };
  const marker = `Source rollback ${accepted.id}`;
  // Synchronous registry check/start after all awaits: concurrent clicks/health observations reuse ONE job.
  const prior = [...readJobs(o.jobs)].reverse().find(j => j.kind === "service" && j.command === marker);
  if (prior) {
    const observed = probeJob(o.jobs, prior);
    if (observed.state === "running") return { job: prior, text: `Source rollback already running: ${prior.id}` };
    if (observed.state !== "gone") throw new Error(`Source rollback proof ${observed.state} without acceptance; needs attention, not another automatic retry. Job: ${prior.id}`);
    // A service restart lost the live permit/task. Re-run from the durable accepted identity, never
    // replay a JSON permit or assume the old process completed. Accepted rollbackOf was checked above.
  }
  return startServiceJob(o.jobs, { name: "source-rollback", command: marker, conv: accepted.review.convId, byCarl: !!o.byCarl, timeout: "12h" }, async (signal, log) => {
    const root = join(o.vault, ".vault-chat", "local", "change-proof");
    signal.throwIfAborted();
    const recovery = await prepareSourceRollback({ vault: o.vault, accepted, privateRoot: root });
    try {
      log(`Recovery request: ${o.reason}\nRevert only ${accepted.source.base}..${accepted.source.head}; preserve later work.`);
      const ask: AskCheck = { requestId: `rollback:${accepted.id}`, requestText: o.reason, assessment: ROLLBACK_CHECK.assessment, evidence: [...ROLLBACK_CHECK.evidence] };
      const result = await proveAndAcceptChange({ ...o.host, privateRoot: root, signal, onProgress: log }, recovery.pinned, ask, ROLLBACK_CHECK, async () => {
        signal.throwIfAborted();
        // Acceptance's repo mutex is already held here. Journal dedupe is checked again there by
        // projectChanges, avoiding a nested lock and a second acceptance after a crash/race.
      }, accepted.id);
      log(`Full recovery evidence: ${result.proofDir}`);
      if (!result.accepted) throw new Error(result.text);
      return result.text;
    } finally { recovery.close(); }
  });
}
