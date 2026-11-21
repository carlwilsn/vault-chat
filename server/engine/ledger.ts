// The work ledger: Carl's open asks, one small machine-owned file per vault
// (<vault>/.vault-chat/local/ledger.json, machine-local like wakes.json). The
// state of a piece of work lives here and in git, not in a long chat: a fresh
// short session gets one entry and the event that woke it, does the next step,
// updates the entry and ends (reports/19-stateless). Waiting is the box's: an
// entry's `wait` names what it waits on (a ship result, a GitHub run), and the
// engine's wake tick starts that fresh session when it lands.
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renameRetry } from "../atomic";

export type LedgerStatus = "open" | "waiting" | "blocked" | "done" | "dropped";

export type LedgerWait = {
  /** A ship request's name (ship-results/<name>.result), or any result whose `branch=` line is `branch`. */
  ship?: string;
  branch?: string;
  /** A GitHub Actions run: id and owner/repo. */
  githubRun?: string;
  repo?: string;
  /** Set when the wait was made; a result older than this is not the one waited for. */
  since: number;
  /** Past this the wait fires anyway, as a timeout. */
  until: number;
  /** What the fresh session should do with the event (its brief). */
  brief: string;
  /** GitHub: when it was last asked (the tick asks at most every GH_EVERY_MS). */
  checkedAt?: number;
};

export type LedgerEntry = {
  id: string;
  /** Carl's words, as he asked. */
  words: string;
  /** Who works on it (a worker, a session) and its branch. */
  owner?: string;
  branch?: string;
  status: LedgerStatus;
  /** The next step, in a line. */
  next?: string;
  /** The last result, in a line. */
  last?: string;
  links?: string[];
  /** The chat Carl asked in: final outcomes are told there. */
  conv?: string;
  wait?: LedgerWait;
  /** The fresh sessions that worked on it (conversation ids), newest last. */
  sessions?: string[];
  createdAt: number;
  updatedAt: number;
};

const CLOSED: LedgerStatus[] = ["done", "dropped"];
/** A closed entry is dropped from the file this long after its last change: the file stays small. */
const KEEP_CLOSED_MS = 3 * 86_400_000;
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function ledgerPath(vault: string): string {
  return join(vault, ".vault-chat", "local", "ledger.json");
}

export function readLedger(vault: string): LedgerEntry[] {
  try {
    const v = JSON.parse(readFileSync(ledgerPath(vault), "utf8"));
    const list = Array.isArray(v) ? v : Array.isArray(v?.asks) ? v.asks : [];
    return list.filter((e: any) => e && typeof e.id === "string" && typeof e.words === "string");
  } catch {
    return [];
  }
}

export function writeLedger(vault: string, list: LedgerEntry[], now = Date.now()): void {
  const keep = list.filter((e) => !CLOSED.includes(e.status) || now - e.updatedAt < KEEP_CLOSED_MS);
  const p = ledgerPath(vault);
  mkdirSync(join(vault, ".vault-chat", "local"), { recursive: true });
  writeFileSync(p + ".tmp", JSON.stringify({ asks: keep }, null, 1));
  renameRetry(p + ".tmp", p);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** A new id from the words: short and readable ("fix-the-updater"), unique in the file. */
export function newAskId(words: string, have: LedgerEntry[]): string {
  const base = slug(words.split(/\s+/).slice(0, 5).join(" ")) || "ask";
  let id = base;
  for (let n = 2; have.some((e) => e.id === id); n++) id = `${base}-${n}`;
  return id;
}

export type LedgerPatch = Partial<Pick<LedgerEntry, "words" | "owner" | "branch" | "status" | "next" | "last" | "links" | "conv" | "sessions">> & { wait?: LedgerWait | null };

/** Create or change one entry (by id; a new one needs words). Returns it, or an error line. */
export function upsertAsk(vault: string, id: string | undefined, patch: LedgerPatch, now = Date.now()): { entry: LedgerEntry; created: boolean } | { error: string } {
  const all = readLedger(vault);
  const i = id ? all.findIndex((e) => e.id === id) : -1;
  if (i < 0 && !clip(patch.words, 1)) return { error: id ? `No ask "${id}" in the ledger; give words to make it.` : "Give words (Carl's ask) to make an entry, or the id of one." };
  const prev = i >= 0 ? all[i]! : null;
  const e: LedgerEntry = prev
    ? { ...prev }
    : { id: id && /^[\w.-]{1,60}$/.test(id) ? id : newAskId(String(patch.words), all), words: "", status: "open", createdAt: now, updatedAt: now };
  if (patch.words !== undefined) e.words = clip(patch.words, 600);
  for (const k of ["owner", "branch", "next", "last", "conv"] as const) if (patch[k] !== undefined) e[k] = clip(patch[k], k === "last" || k === "next" ? 600 : 160) || undefined;
  if (patch.status !== undefined) {
    if (!["open", "waiting", "blocked", "done", "dropped"].includes(patch.status)) return { error: `status is one of open, waiting, blocked, done, dropped (not "${patch.status}").` };
    e.status = patch.status;
  }
  if (patch.links !== undefined) e.links = (Array.isArray(patch.links) ? patch.links : [patch.links]).map((x) => clip(x, 300)).filter(Boolean).slice(-12);
  if (patch.sessions !== undefined) e.sessions = patch.sessions.slice(-10);
  if (patch.wait === null) delete e.wait;
  else if (patch.wait) (e.wait = patch.wait), (e.status = "waiting");
  if (CLOSED.includes(e.status)) delete e.wait;
  e.updatedAt = now;
  if (i >= 0) all[i] = e;
  else all.push(e);
  writeLedger(vault, all, now);
  return { entry: e, created: i < 0 };
}

export function getAsk(vault: string, id: string): LedgerEntry | null {
  return readLedger(vault).find((e) => e.id === id) ?? null;
}

/** One entry as the few lines a session reads. */
export function askText(e: LedgerEntry): string {
  const w = e.wait;
  const waits = w
    ? [w.ship ? `ship result ${w.ship}` : "", w.branch ? `a ship result for branch ${w.branch}` : "", w.githubRun ? `GitHub run ${w.githubRun}${w.repo ? ` (${w.repo})` : ""}` : ""].filter(Boolean).join(" or ")
    : "";
  return [
    `Ask ${e.id} [${e.status}]: ${e.words}`,
    e.owner || e.branch ? `Owner: ${e.owner ?? "-"}; branch: ${e.branch ?? "-"}` : "",
    e.next ? `Next: ${e.next}` : "",
    e.last ? `Last result: ${e.last}` : "",
    e.links?.length ? `Links: ${e.links.join(", ")}` : "",
    w ? `Waiting on ${waits} until ${new Date(w.until).toISOString()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The ledger's open entries, one block each (closed ones as a single line). */
export function ledgerText(list: LedgerEntry[]): string {
  if (!list.length) return "The ledger is empty.";
  const open = list.filter((e) => !CLOSED.includes(e.status));
  const closed = list.filter((e) => CLOSED.includes(e.status));
  return [...open.map(askText), closed.length ? `Closed lately: ${closed.map((e) => `${e.id} (${e.status})`).join(", ")}` : ""].filter(Boolean).join("\n\n");
}

/** The `branch=` line of a ship result. */
export function resultBranch(body: string): string | null {
  return /^branch=(\S+)/m.exec(body)?.[1] ?? null;
}

/** Does this ship result (file name without .result, its text, its time) end this entry's wait? */
export function shipMatches(w: LedgerWait | undefined, name: string, body: string, at: number): boolean {
  if (!w || at < w.since - 1000) return false;
  const base = name.replace(/\.result$/, "");
  if (w.ship && (w.ship === base || w.ship.replace(/\.req$/, "") === base)) return true;
  const b = resultBranch(body);
  return !!(w.branch && b && (b === w.branch || b === `agent/${w.branch}` || `agent/${b}` === w.branch));
}

/** A ship result waited on by name, already there (it landed before the tick saw it): its text and time. */
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
export function wakeBrief(e: LedgerEntry, event: string): string {
  return [
    "[A fresh work session, started by the box for one ask in Carl's work ledger. You have no earlier conversation: the entry and the event below are the whole state; git and the files are the rest.]",
    askText(e),
    e.wait?.brief ? `What to do when this lands: ${e.wait.brief}` : "",
    `Event:\n${event.slice(0, 4000)}`,
    [
      "Do the next step now, small and direct. Then:",
      `- Ledger {action: "set", id: "${e.id}", next, last, status} with what you did and what comes next (the ledger, not this chat, carries the work).`,
      "- If there is something to wait for (a ship result, a CI run), use WaitFor with a brief for the next session and end your turn: never sleep, poll or Monitor.",
      "- When the ask is finished, or needs Carl, set status done or blocked with `last` saying the outcome in one or two plain lines: the box tells Carl. Do not post into his chat.",
      "- Then end your turn with one line.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}
