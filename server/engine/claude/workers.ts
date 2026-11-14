// What an Agent-tool worker (a Claude Code background subagent) is doing, read from EVIDENCE: its own
// transcript (<config>/projects/<cwd>/<session>/subagents/agent-<id>.jsonl) and what this process saw of its
// task notices. The agent asks (JobList / JobStatus) and gets a state it can trust: a stop notice alone is not
// proof (a worker marked stopped by a restart had already shipped), and a "completed" notice can be interim.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** A worker quiet this long while it should be working is idle: flagged to the chat and in the list. */
export const IDLE_MS = 10 * 60_000;
/** A task this process never saw start, not complete, and quiet this long, died with an earlier process. */
const ORPHAN_MS = 60_000;

export type WorkerState = "running" | "waiting-tool" | "waiting-background" | "idle" | "finished" | "failed" | "stopped" | "interrupted";

/** What the transcript says, with no judgement. */
export type TranscriptFacts = {
  startedAt: number;
  /** The newest entry's time (the file's mtime when no entry has one). */
  lastAt: number;
  toolCalls: number;
  lastTool: { name: string; at: number; brief: string } | null;
  /** A tool call made and not answered yet. */
  pending: { name: string; at: number; brief: string } | null;
  /** Files it wrote or edited (Write, Edit, NotebookEdit), newest last. */
  files: string[];
  /** The last thing it said, in words. */
  lastSaid: string;
  /** Its last message is a finished reply: the model stopped (end_turn) with no tool call open. */
  endedClean: boolean;
};

/** What this process saw of the task: its notices, in order; null for a task it never saw start. */
export type TaskView = { status: "running" | "interim" | "completed" | "failed" | "stopped"; at: number; reason?: string } | null;

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** One line of what a tool call is about: its command, path or pattern. */
function brief(name: string, input: any): string {
  const v = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.query ?? input?.description ?? input?.url ?? "";
  return clip(typeof v === "string" ? v : "", 100);
}

/** Facts from a transcript's text. Never throws: a torn last line (the file is being written) is skipped. */
export function transcriptFacts(raw: string, mtimeMs: number): TranscriptFacts {
  const f: TranscriptFacts = { startedAt: 0, lastAt: 0, toolCalls: 0, lastTool: null, pending: null, files: [], lastSaid: "", endedClean: false };
  const open = new Map<string, { name: string; at: number; brief: string }>();
  let last: "model" | "tool" | "other" = "other";
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(e?.timestamp ?? "") || 0;
    if (at) {
      if (!f.startedAt) f.startedAt = at;
      if (at > f.lastAt) f.lastAt = at;
    }
    const content = Array.isArray(e?.message?.content) ? e.message.content : [];
    if (e?.type === "assistant") {
      let called = false;
      for (const b of content) {
        if (b?.type === "tool_use") {
          called = true;
          f.toolCalls += 1;
          const t = { name: String(b.name ?? ""), at, brief: brief(String(b.name ?? ""), b.input) };
          f.lastTool = t;
          open.set(String(b.id ?? ""), t);
          const p = b.input?.file_path ?? b.input?.notebook_path;
          if (/^(Write|Edit|NotebookEdit)$/.test(t.name) && typeof p === "string") f.files = [...f.files.filter((x) => x !== p), p];
        } else if (b?.type === "text" && String(b.text ?? "").trim()) f.lastSaid = clip(String(b.text), 400);
      }
      last = !called && e.message?.stop_reason === "end_turn" ? "model" : "other";
    } else if (e?.type === "user") {
      let answered = false;
      for (const b of content) if (b?.type === "tool_result") (answered = true), open.delete(String(b.tool_use_id ?? ""));
      last = answered ? "tool" : "other";
    }
  }
  if (!f.lastAt) f.lastAt = mtimeMs;
  if (!f.startedAt) f.startedAt = f.lastAt;
  // A file touched after its last entry (a write the entry has not caught up with) counts as activity.
  if (mtimeMs > f.lastAt) f.lastAt = mtimeMs;
  f.pending = [...open.values()].pop() ?? null;
  f.endedClean = last === "model" && !f.pending;
  return f;
}

/**
 * The state, from the evidence. Order matters:
 *  - a failed notice is a failure;
 *  - a transcript that ends in a finished reply means finished, whatever a stop notice said (it can only have
 *    stopped after reporting), unless the notice is interim (it reported to its parent and waits on its own children);
 *  - a worker this process never saw start, with an unfinished transcript, belongs to a process that is gone: interrupted.
 */
export function deriveState(f: TranscriptFacts, task: TaskView, now: number, idleMs = IDLE_MS): WorkerState {
  if (task?.status === "failed") return "failed";
  if (task?.status === "interim") return now - f.lastAt >= idleMs ? "idle" : "waiting-background";
  if (f.endedClean || task?.status === "completed") return "finished";
  if (task?.status === "stopped") return task.reason === "worker_restart" ? "interrupted" : "stopped";
  const quiet = now - f.lastAt;
  if (!task) return quiet >= ORPHAN_MS ? "interrupted" : "running";
  if (quiet >= idleMs) return "idle";
  return f.pending ? "waiting-tool" : "running";
}

export type WorkerRow = { id: string; title: string; state: WorkerState; facts: TranscriptFacts; note?: string };

const age = (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

/** The state in words, with its evidence. */
export function stateText(r: WorkerRow, now: number): string {
  const f = r.facts;
  const quiet = age(now - f.lastAt);
  switch (r.state) {
    case "running":
      return `running (last activity ${quiet} ago${f.lastTool ? `, last tool ${f.lastTool.name}` : ", thinking"})`;
    case "waiting-tool":
      return `waiting on tool ${f.pending?.name ?? "?"} for ${age(now - (f.pending?.at || f.lastAt))}`;
    case "waiting-background":
      return `waiting on its own background work (an interim notice, not finished; quiet ${quiet})`;
    case "idle":
      return `IDLE for ${quiet}${f.pending ? ` (stuck on tool ${f.pending.name})` : ""}: stalled or waiting on something that never came`;
    case "finished":
      return `finished ${quiet} ago${r.note ? ` (${r.note})` : ""}`;
    case "failed":
      return `FAILED ${quiet} ago`;
    case "stopped":
      return `stopped ${quiet} ago`;
    case "interrupted":
      return `INTERRUPTED (its process is gone, e.g. a server restart; quiet ${quiet}; its transcript does not end in a report)`;
  }
}

const open = (s: WorkerState) => s !== "finished" && s !== "failed" && s !== "stopped";

/** JobList's lines: one per worker, newest first. */
export function formatWorkers(rows: WorkerRow[], now: number): string {
  return [...rows]
    .sort((a, b) => b.facts.lastAt - a.facts.lastAt)
    .map((r) => {
      const f = r.facts;
      const bits = [`${f.toolCalls} tool call(s)`, `started ${age(now - f.startedAt)} ago`, f.lastTool ? `last: ${f.lastTool.name} ${f.lastTool.brief} (${age(now - f.lastTool.at)} ago)` : ""].filter(Boolean);
      const resume = r.state === "interrupted" || r.state === "idle" ? `\n    resume: SendMessage {to: "${r.id}", message: "Continue where you stopped."}` : "";
      return `- ${r.id} "${r.title}": ${stateText(r, now)}; ${bits.join("; ")}${resume}`;
    })
    .join("\n");
}

/** JobStatus for one worker: the progress line on demand, without waiting for it to finish. */
export function formatWorker(r: WorkerRow, now: number): string {
  const f = r.facts;
  const lines = [
    `Agent worker ${r.id} ("${r.title}"): ${stateText(r, now)}.`,
    `Started ${age(now - f.startedAt)} ago; ${f.toolCalls} tool call(s); last activity ${age(now - f.lastAt)} ago.`,
    f.lastTool ? `Last tool call: ${f.lastTool.name} ${f.lastTool.brief} (${age(now - f.lastTool.at)} ago).` : "",
    f.files.length ? `Files written: ${f.files.slice(-8).join(", ")}.` : "",
    f.lastSaid ? `Its latest words: ${f.lastSaid}` : "",
    r.state === "interrupted" || r.state === "idle" ? `To resume it: SendMessage {to: "${r.id}", message: "Continue where you stopped."} (it keeps its context).` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** The subagents/ directories of a session, in any project folder of the config dir (the folder name encodes a cwd). */
export function subagentDirs(configDir: string, sessionId: string): string[] {
  const root = join(configDir, "projects");
  if (!sessionId || !existsSync(root)) return [];
  try {
    return readdirSync(root).map((p) => join(root, p, sessionId, "subagents")).filter((d) => existsSync(d));
  } catch {
    return [];
  }
}

/** Every worker transcript of a session as rows. `task(id)`: what this process saw of that task. */
export function readWorkers(configDir: string, sessionId: string, task: (id: string) => TaskView, now = Date.now()): WorkerRow[] {
  const rows: WorkerRow[] = [];
  for (const dir of subagentDirs(configDir, sessionId)) {
    for (const name of readdirSync(dir)) {
      const m = /^agent-(.+)\.jsonl$/.exec(name);
      if (!m) continue;
      const file = join(dir, name);
      try {
        const facts = transcriptFacts(readFileSync(file, "utf8"), statSync(file).mtimeMs);
        let title = "";
        try {
          title = String(JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")).description ?? "");
        } catch {
          /* no meta */
        }
        const t = task(m[1]!);
        const state = deriveState(facts, t, now);
        const note = state === "finished" && t?.status === "stopped" ? `marked stopped${t.reason === "worker_restart" ? " by a restart" : ""}, but its transcript ends in a finished report` : undefined;
        rows.push({ id: m[1]!, title: title || m[1]!, state, facts, ...(note ? { note } : {}) });
      } catch {
        /* a file that vanished or tore: skip it */
      }
    }
  }
  return rows;
}

/** The rows JobList shows by default: everything not over, and what finished in the last few hours. */
export function recentRows(rows: WorkerRow[], now: number, all = false): WorkerRow[] {
  return rows.filter((r) => all || open(r.state) || now - r.facts.lastAt < 3 * 3_600_000).sort((a, b) => b.facts.lastAt - a.facts.lastAt).slice(0, 40);
}

export const workerIsOpen = open;
