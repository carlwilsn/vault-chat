// The work list: Carl's open asks, ONE list for the whole box, kept as history (reports/19-stateless, folding in
// reports/20-design-review). Every change to an ask is a record appended to <state>/work/work.jsonl and never
// rewritten; the current list is the fold of those records, so the past stays readable. The state of a piece of
// work lives here and in git, not in a long chat: a fresh short session gets one entry and the event that woke it,
// does the next step, writes the entry (and its handoff note) and ends. Waiting is the box's: an entry's `wait`
// (server/engine/waiters.ts) names what it waits on, and the box starts the fresh session when that holds.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LedgerStatus = "open" | "working" | "waiting" | "question" | "blocked" | "done" | "dropped";
export const STATUSES: readonly LedgerStatus[] = ["open", "working", "waiting", "question", "blocked", "done", "dropped"];
export const CLOSED: readonly LedgerStatus[] = ["done", "dropped"];

/** What an ask waits on: a kind (waiters.ts) and its arguments, a deadline, and the brief for the next session. */
export type LedgerWait = {
  kind: string;
  args: Record<string, string>;
  since: number;
  until: number;
  brief: string;
  checkedAt?: number;
};

export type LedgerEntry = {
  id: string;
  /** Carl's words, as he asked. */
  words: string;
  /** Where he asked: the vault (its path) and the chat. Final outcomes are told there. */
  origin?: { vault: string; conv: string };
  /** The project it is work in (a fresh session is a chat of that project). */
  project?: string;
  /** Who works on it now: a session (conversation id) or a worker. */
  owner?: string;
  branch?: string;
  /** Its own checkout (a git project's work happens in a worktree that outlives sessions). */
  worktree?: string;
  /** The ship request it has in flight (ship-requests/<ship>.req): cancel takes it back while not taken. */
  ship?: string;
  status: LedgerStatus;
  next?: string;
  last?: string;
  /** At most ~20 lines from the session that ended: what it learned and checked. The next one starts from it. */
  handoff?: string;
  question?: { text: string; options?: string[] };
  answer?: string;
  links?: string[];
  wait?: LedgerWait;
  /** The session holding it and until when (a lease the box reaps when it runs out). */
  lease?: { conv: string; until: number };
  /** How many times the box has had to restart a stalled ask. */
  reaps?: number;
  /** How many failed ship results the box dealt with by itself (resubmitted a flake, rebased onto a moved main). */
  autoShips?: number;
  sessions?: string[];
  /** Events already taken up, by id: each is handled once. */
  handled?: string[];
  createdAt: number;
  updatedAt: number;
};

export type LedgerPatch = { [K in Exclude<keyof LedgerEntry, "id" | "createdAt" | "updatedAt">]?: LedgerEntry[K] | null };
type Record_ = { at: number; id: string; set: LedgerPatch; by?: string };

/** The box's one work list (VC_WORK_FILE, else <state>/work/work.jsonl). */
export function workFile(): string {
  if (process.env.VC_WORK_FILE) return process.env.VC_WORK_FILE;
  const state = process.env.VC_STATE_DIR ?? join(homedir(), ".local", "state", "vault-chat-server");
  return join(state, "work", "work.jsonl");
}

let cache: { file: string; size: number; mtime: number; list: Map<string, LedgerEntry> } | null = null;

/** Every ask, folded from its records (newest state of each). */
export function readLedger(file = workFile()): LedgerEntry[] {
  let st: { size: number; mtimeMs: number };
  try {
    st = statSync(file);
  } catch {
    return [];
  }
  if (cache && cache.file === file && cache.size === st.size && cache.mtime === st.mtimeMs) return [...cache.list.values()].map((e) => ({ ...e }));
  const list = new Map<string, LedgerEntry>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let r: Record_;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r || typeof r.id !== "string" || !r.set) continue;
    const e = list.get(r.id) ?? ({ id: r.id, words: "", status: "open", createdAt: r.at, updatedAt: r.at } as LedgerEntry);
    for (const [k, v] of Object.entries(r.set)) {
      if (v === null || v === undefined) delete (e as Record<string, unknown>)[k];
      else (e as Record<string, unknown>)[k] = v;
    }
    e.updatedAt = r.at;
    list.set(r.id, e);
  }
  cache = { file, size: st.size, mtime: st.mtimeMs, list };
  return [...list.values()].map((e) => ({ ...e }));
}

export function getAsk(id: string, file = workFile()): LedgerEntry | null {
  return readLedger(file).find((e) => e.id === id) ?? null;
}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** A new id from the words: short and readable ("fix-the-updater"), unique in the list. */
export function newAskId(words: string, have: LedgerEntry[]): string {
  const base = slug(words.split(/\s+/).slice(0, 5).join(" ")) || "ask";
  let id = base;
  for (let n = 2; have.some((e) => e.id === id); n++) id = `${base}-${n}`;
  return id;
}

/** Make or change one ask: one record appended. Returns the ask as it is now, or an error line. */
export function upsertAsk(id: string | undefined, patch: LedgerPatch, o: { file?: string; now?: number; by?: string } = {}): { entry: LedgerEntry; created: boolean } | { error: string } {
  const file = o.file ?? workFile();
  const now = o.now ?? Date.now();
  const all = readLedger(file);
  const prev = id ? all.find((e) => e.id === id) ?? null : null;
  if (!prev && !clip(patch.words, 1)) return { error: id ? `No ask "${id}" in the work list; give words to make it.` : "Give words (Carl's ask) to make an entry, or the id of one." };
  if (patch.status != null && !STATUSES.includes(patch.status)) return { error: `status is one of ${STATUSES.join(", ")} (not "${patch.status}").` };
  const set: LedgerPatch = {};
  for (const [k, v] of Object.entries(patch) as [keyof LedgerPatch, unknown][]) {
    if (v === undefined) continue;
    if (v === null) (set as Record<string, unknown>)[k] = null;
    else if (k === "words" || k === "next" || k === "last" || k === "answer") (set as Record<string, unknown>)[k] = clip(v, 800);
    else if (k === "handoff") (set as Record<string, unknown>)[k] = String(v).split("\n").slice(0, 24).join("\n").slice(0, 3000);
    else if (k === "owner" || k === "branch" || k === "ship" || k === "project") (set as Record<string, unknown>)[k] = clip(v, 200);
    else if (k === "links") (set as Record<string, unknown>)[k] = (Array.isArray(v) ? v : [v]).map((x) => clip(x, 300)).filter(Boolean).slice(-12);
    else if (k === "sessions" || k === "handled") (set as Record<string, unknown>)[k] = (v as string[]).slice(-20);
    else (set as Record<string, unknown>)[k] = v;
  }
  if (set.wait) set.status ??= "waiting";
  const status = (set.status ?? prev?.status) as LedgerStatus | undefined;
  if (status && CLOSED.includes(status)) (set.wait = null), (set.lease = null);
  if (status && status !== "question" && prev?.question) set.question = null;
  const newId = prev ? prev.id : id && /^[\w.-]{1,60}$/.test(id) && !all.some((e) => e.id === id) ? id : newAskId(String(patch.words), all);
  if (!prev) set.status ??= "open";
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ at: now, id: newId, set, ...(o.by ? { by: o.by } : {}) }) + "\n");
  const entry = getAsk(newId, file)!;
  return { entry, created: !prev };
}

/** One entry as the few lines a session reads. */
export function askText(e: LedgerEntry): string {
  const w = e.wait;
  return [
    `Ask ${e.id} [${e.status}]: ${e.words}`,
    e.project || e.owner || e.branch ? `Project: ${e.project ?? "-"}; owner: ${e.owner ?? "-"}; branch: ${e.branch ?? "-"}${e.worktree ? `; worktree: ${e.worktree}` : ""}` : "",
    e.ship ? `Ship request in flight: ${e.ship}` : "",
    e.next ? `Next: ${e.next}` : "",
    e.last ? `Last result: ${e.last}` : "",
    e.question ? `Question to Carl: ${e.question.text}${e.question.options?.length ? ` (options: ${e.question.options.join(" / ")})` : ""}` : "",
    e.answer ? `Carl's answer: ${e.answer}` : "",
    e.handoff ? `Handoff from the last session:\n${e.handoff}` : "",
    e.links?.length ? `Links: ${e.links.join(", ")}` : "",
    w ? `Waiting on ${w.kind} ${Object.values(w.args).join(" ")} until ${new Date(w.until).toISOString()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The open asks, one block each; closed ones as a line. */
export function ledgerText(list: LedgerEntry[]): string {
  if (!list.length) return "The work list is empty.";
  const open = list.filter((e) => !CLOSED.includes(e.status));
  const closed = list.filter((e) => CLOSED.includes(e.status) && Date.now() - e.updatedAt < 3 * 86_400_000);
  return [...open.map(askText), closed.length ? `Closed lately: ${closed.map((e) => `${e.id} (${e.status})`).join(", ")}` : ""].filter(Boolean).join("\n\n") || "No open asks.";
}

/** The `branch=` line of a ship result. */
export function resultBranch(body: string): string | null {
  return /^branch=(\S+)/m.exec(body)?.[1] ?? null;
}

/** A ship result by name: its text and time, or null. */
export function readShipResult(dir: string, name: string): { body: string; at: number } | null {
  const f = join(dir, `${name.replace(/\.(req|result)$/, "")}.result`);
  if (!existsSync(f)) return null;
  try {
    return { body: readFileSync(f, "utf8"), at: statSync(f).mtimeMs };
  } catch {
    return null;
  }
}

/** The brief a fresh work session starts from: the entry and the event, nothing else. */
export function wakeBrief(e: LedgerEntry, event: string, brief = e.wait?.brief): string {
  return [
    "[A fresh work session, started by the box for one ask in Carl's work list. You have no earlier conversation: the entry and the event below are the whole state; git and the files are the rest.]",
    askText(e),
    brief ? `What to do when this lands: ${brief}` : "",
    `Event:\n${event.slice(0, 4000)}`,
    [
      "Do the next step now, yourself, in this session: no background Agent workers, no Monitor, no sleep or poll loops, no AskUser.",
      `- Keep the entry current: Ledger {action: "set", id: "${e.id}", next, last, handoff} (handoff: at most ~20 lines of what you learned and checked, for the next session). Commit work in progress before you end.`,
      "- To wait (a ship result, the core build, Carl's laptop, a CI run): WaitFor with a brief for the next session, then end your turn.",
      "- Accepted is not done: after a ship is accepted, WaitFor {laptop: <commit>} and set done only when it is on Carl's laptop (if the wait times out with the laptop away, set done with last \"accepted; lands when your laptop is back\").",
      "- A decision only Carl can make: set status question with question {text, options}; his answer starts a new session. Something you cannot get past: status blocked with last saying why.",
      "- Finished: status done with last saying the outcome in one or two plain lines; the box tells Carl. Do not post into his chat.",
      "- Then end your turn with one line.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}
