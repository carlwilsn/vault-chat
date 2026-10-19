// One shared context stream per vault: what Carl has been doing, across every
// surface (the editor, Ctrl+K, Ctrl+L, image captures, voice, chat), so each
// of them can answer "the thing I just circled", "what I asked by voice",
// "undo the Ctrl+K edit I just made".
//
// This file is the pure part, shared by the laptop (src/activity.ts) and the
// box (server/activity.ts): the entry shape, the caps and redaction applied on
// write, and the "you" layer every surface reads (buildYouLayer). No I/O here.
//
// Where it lives: <vault>/.vault-chat/local/activity.jsonl (one JSON entry per
// line; rotated to activity.1.jsonl past LOG_MAX_BYTES). `.vault-chat/local/`
// is machine-local: never committed, never synced, never in Carl's folders.
// The log is the box's (the laptop posts to it).

export type ActivityKind = "focus" | "edit" | "ask" | "capture" | "voice" | "chat";
export const ACTIVITY_KINDS: readonly ActivityKind[] = ["focus", "edit", "ask", "capture", "voice", "chat"];

/** Where an entry came from (the surface Carl used). */
export type ActivityModality = "editor" | "ctrl-k" | "ctrl-l" | "capture" | "voice" | "chat";
const MODALITIES: readonly ActivityModality[] = ["editor", "ctrl-k", "ctrl-l", "capture", "voice", "chat"];
const DEFAULT_MODALITY: Record<ActivityKind, ActivityModality> = {
  focus: "editor",
  edit: "ctrl-k",
  ask: "ctrl-l",
  capture: "capture",
  voice: "voice",
  chat: "chat",
};

/** The device Carl was on. */
export type Device = "laptop" | "phone" | "board";
export const DEVICES: readonly Device[] = ["laptop", "phone", "board"];
/** Surfaces only the laptop has. */
const LAPTOP_ONLY: ReadonlySet<ActivityModality> = new Set(["editor", "ctrl-k", "ctrl-l", "capture"]);

export type ActivityEntry = {
  ts: number;
  kind: ActivityKind;
  modality: ActivityModality;
  /** One line: what happened. */
  text: string;
  /** A little more (an edit's diff summary, an answer's gist). */
  detail?: string;
  /** Vault-relative file the entry is about. */
  path?: string;
  /** Where in it: "page 3", "L12-L18", "selection". */
  where?: string;
  /** A project slug, when known. */
  project?: string;
  /** A conversation the entry points at (chat pointers, what was said by voice in it). */
  convId?: string;
  /** A stored image (vault-relative, under .vault-chat/local/captures/), never inline data. */
  image?: string;
  /** Ctrl+K: whether Carl kept the edit. */
  outcome?: "accepted" | "rejected";
  /** The device it happened on (the laptop for the editor, Ctrl+K, Ctrl+L and captures). */
  device?: Device;
};

export const ACTIVITY_DIR = ".vault-chat/local";
export const ACTIVITY_LOG = `${ACTIVITY_DIR}/activity.jsonl`;
export const ACTIVITY_LOG_OLD = `${ACTIVITY_DIR}/activity.1.jsonl`;
export const CAPTURES_DIR = `${ACTIVITY_DIR}/captures`;
/** Rotate the log past this (the old half is kept as activity.1.jsonl). */
export const LOG_MAX_BYTES = 256 * 1024;
/** No single line over this. */
export const ENTRY_MAX_BYTES = 2048;
export const CAPS = { text: 300, detail: 600, path: 240, where: 80, project: 64, convId: 80, image: 200 } as const;
/** A capture older than this is not "the image" a request refers to. */
export const DEFAULT_WINDOW_MS = 30 * 60_000;

// ---------------------------------------------------------------- redaction

// Key-like strings: never written. Provider keys, tokens, private keys,
// "password: x" style assignments, and long opaque blobs (mixed letters and
// digits, 32+ chars, no spaces) — a hash or a key, either way not context.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(sk|pk|rk)-(or-|ant-|proj-|live-|test-)?[A-Za-z0-9_-]{12,}/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(api[_-]?key|apikey|secret|password|passwd|passphrase|token|auth)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
];
const OPAQUE = /[A-Za-z0-9+_=]{32,}/g;

export function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, a, b) => {
      // Keep the name of an assignment ("password: [redacted]"), drop the value.
      if (typeof a === "string" && typeof b === "string" && /[:=]/.test(b)) return `${a}${b}[redacted]`;
      return "[redacted]";
    });
  }
  out = out.replace(OPAQUE, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? "[redacted]" : m));
  return out;
}

// ---------------------------------------------------------------- sanitize

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Collapse whitespace, redact, clip to `n` chars. */
export function clean(v: unknown, n: number, oneLine = true): string {
  let t = str(v);
  if (oneLine) t = t.replace(/\s+/g, " ");
  t = redactSecrets(t.trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** A structured field (a path, an id): one line, clipped, not rewritten. */
const field = (v: unknown, n: number) => str(v).replace(/\s+/g, " ").trim().slice(0, n);

/**
 * A raw entry (from a client, from voice) → a safe one, or null. Unknown
 * fields are dropped, strings are capped and redacted, `ts` is `now` (the
 * writer's clock, so one log has one clock).
 */
export function sanitizeEntry(raw: unknown, now: number): ActivityEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind as ActivityKind;
  if (!ACTIVITY_KINDS.includes(kind)) return null;
  const text = clean(r.text, CAPS.text);
  if (!text) return null;
  const modality = MODALITIES.includes(r.modality as ActivityModality) ? (r.modality as ActivityModality) : DEFAULT_MODALITY[kind];
  const e: ActivityEntry = { ts: now, kind, modality, text };
  const detail = clean(r.detail, CAPS.detail);
  if (detail) e.detail = detail;
  const path = field(r.path, CAPS.path).replace(/\\/g, "/");
  if (path) e.path = path;
  const where = clean(r.where, CAPS.where);
  if (where) e.where = where;
  const project = field(r.project, CAPS.project);
  if (project && /^[a-z0-9-]+$/.test(project)) e.project = project;
  const convId = field(r.convId, CAPS.convId);
  if (convId && /^[A-Za-z0-9._:-]+$/.test(convId)) e.convId = convId;
  const image = field(r.image, CAPS.image).replace(/\\/g, "/");
  if (image && image.startsWith(`${CAPTURES_DIR}/`) && !image.includes("..")) e.image = image;
  if (r.outcome === "accepted" || r.outcome === "rejected") e.outcome = r.outcome;
  if (DEVICES.includes(r.device as Device)) e.device = r.device as Device;
  else if (LAPTOP_ONLY.has(modality)) e.device = "laptop";
  // A last guard on the line's size (the caps above keep it far under).
  let line = JSON.stringify(e);
  if (line.length > ENTRY_MAX_BYTES && e.detail) {
    delete e.detail;
    line = JSON.stringify(e);
  }
  return line.length > ENTRY_MAX_BYTES ? null : e;
}

/** The log's text → entries (bad lines skipped). */
export function parseLog(text: string): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const e = JSON.parse(l);
      if (e && typeof e.ts === "number" && ACTIVITY_KINDS.includes(e.kind) && typeof e.text === "string") out.push(e);
    } catch {
      /* a torn line */
    }
  }
  return out;
}

// ---------------------------------------------------------------- the "you" layer

// What Carl just did, across every surface, for every conversation: where he
// is (focus, selection, device), the last board, his captures and pasted
// images, notes he changed, his own messages in OTHER chats (one-line
// pointers: never a reply, never a draft) and what he did on the other
// surfaces (Ctrl+K, Ctrl+L, voice). Conversation content does not bleed: a
// chat is named and pointed at; the agent reads it on request (ReadConversation).
//
// One builder, every reader: pi's turns and Ctrl+K / Ctrl+L side threads get it
// through the vault-chat pi extension's before_agent_start (written into pi's
// session as a `vc-you` custom message, so it is in pi's record and its
// compaction), and voice calls the same server function (server/activity.ts youLayer).

/** The newest board, as the layer shows it (server/activity.ts reads it from boards/). */
export type BoardSnap = { slug: string; name: string; updated: number; strokes: number; items: { kind: string; label: string }[]; overview: string | null };
/** A note's latest state (server/activity.ts reads .vault-chat/notes.jsonl). */
export type NoteSnap = { id: string; ts: number; created: boolean; status: string; text: string };
export type YouSources = { entries: ActivityEntry[]; board?: BoardSnap | null; notes?: NoteSnap[] };
/** The conversations' titles, for the pointers (an entry carries the title it had when it was written). */
export type YouOptions = {
  now: number;
  /** What this reader saw already: the `until` of its last layer. Only what is newer is given. */
  since?: number | null;
  /** The reader's own conversation: its own messages and pasted images are in its thread already. */
  convId?: string | null;
  windowMs?: number;
  maxChars?: number;
};
export type YouLayer = { text: string; until: number; items: number };

/** The window shown in detail; "the last thing he did" is shown whatever its age (to a reader that has not seen it). */
export const YOU_WINDOW_MS = 45 * 60_000;
/** The layer's budget (~1.25k tokens at ~4 characters a token). */
export const YOU_MAX_CHARS = 5000;
/** A pointer quotes this much of Carl's message. */
export const POINTER_CHARS = 120;
/** What a chat pointer stores of Carl's message (the pointer shows POINTER_CHARS of it). */
export const GIST_MAX = 200;
const LINE_MAX = 320;
const MAX_IMAGES = 4;
const MAX_NOTES = 4;
const MAX_CHATS = 6;
/** A selection is "current" while it is this fresh. */
const SELECTION_FRESH_MS = 10 * 60_000;

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m <= 0) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ${m % 60} min ago`;
  return `${Math.round(m / 1440)} days ago`;
}

const SURFACE: Record<ActivityModality, string> = {
  editor: "Editor",
  "ctrl-k": "Ctrl+K edit",
  "ctrl-l": "Ctrl+L ask",
  capture: "Image capture",
  voice: "Voice",
  chat: "Chat",
};

const clip = (l: string, n = LINE_MAX) => (l.length > n ? `${l.slice(0, n - 1)}…` : l);
const isSelection = (e: ActivityEntry) => e.kind === "focus" && /^selected "/.test(e.text);
const isVoiceReply = (e: ActivityEntry) => e.kind === "voice" && e.text.startsWith("Voice replied:");
const isPasted = (e: ActivityEntry) => e.kind === "capture" && e.modality === "chat";

/** "[Physics hw4 chat, 2 min ago] Carl: …first 120 chars…" — Carl's own words, never a reply. */
export function chatPointer(e: ActivityEntry, now: number): string {
  const title = (e.text || "untitled").replace(/^Chat "(.*)"$/, "$1");
  // (An older entry also held the reply: `Carl: "…" → Agent: "…"`. Only Carl's side is shown.)
  const said = (e.detail ?? "").replace(/^Carl: "([\s\S]*?)"(?: → [\s\S]*)?$/, "$1");
  const quote = said.length > POINTER_CHARS ? `${said.slice(0, POINTER_CHARS - 1)}…` : said;
  return `[${title} chat, ${ago(now - e.ts)}] Carl: ${quote}${e.convId ? ` (id ${e.convId})` : ""}`;
}

/** One entry of the other surfaces (Ctrl+K, Ctrl+L, voice), one line. */
function otherLine(e: ActivityEntry, now: number): string {
  const loc = e.path ? ` · ${e.path}${e.where ? ` (${e.where})` : ""}` : e.where ? ` · ${e.where}` : "";
  // A voice line points at the chat it was said in (ReadConversation reads it there).
  const where = e.kind === "voice" && e.convId ? ` (in chat ${e.convId})` : "";
  const bits = [`[${ago(now - e.ts)}] ${SURFACE[e.modality] ?? e.modality}${loc}${where}: ${e.text}`];
  if (e.outcome) bits.push(`(${e.outcome})`);
  if (e.detail) bits.push(`— ${e.detail}`);
  return clip(bits.join(" "));
}

function imageLine(e: ActivityEntry, now: number): string {
  if (isPasted(e)) return clip(`[${ago(now - e.ts)}] ${e.text}: ${e.path ?? "?"}`);
  const from = e.path ? ` of ${e.path}${e.where ? ` (${e.where})` : ""}` : "";
  return clip(`[${ago(now - e.ts)}] capture${from}${e.text && e.text !== "captured" ? ` — ${e.text}` : ""}${e.image ? `: ${e.image}` : " (no image stored)"}`);
}

function noteLine(n: NoteSnap, now: number): string {
  const what = n.status === "cleared" ? "cleared a note" : n.status === "resolved" ? "resolved a note" : n.created ? "new note" : "changed a note";
  const t = n.text.replace(/\s+/g, " ").trim();
  return clip(`[${ago(now - n.ts)}] ${what} (${n.id}): "${t.length > 160 ? `${t.slice(0, 159)}…` : t}"`);
}

function boardLine(b: BoardSnap, now: number): string {
  const items = b.items.length
    ? `${b.items.length} item${b.items.length === 1 ? "" : "s"}: ${b.items.slice(0, 8).map((i) => (i.label ? `${i.label} (${i.kind})` : i.kind)).join(", ")}${b.items.length > 8 ? ", …" : ""}`
    : "no items";
  const look = b.overview ? ` To see it, read ${b.overview}` : "";
  return clip(`Board: "${b.name}" (boards/${b.slug}/), saved ${ago(now - b.updated)} — ${items}; ${b.strokes} ink stroke${b.strokes === 1 ? "" : "s"}.${look}`, 600);
}

/**
 * The layer for one reader: what is new since `since` (everything, for a new
 * conversation), the last `windowMs` in detail, plus the last thing Carl did
 * even when it is older. Deduped (a later view of a file replaces the earlier;
 * a repeated entry counts once) and within `maxChars`: the oldest of the
 * other surfaces go first, then the oldest pointers, images and notes.
 * `until` is what the reader has now seen (its next `since`). "" when nothing is new.
 */
export function buildYouLayer(src: YouSources, o: YouOptions): YouLayer {
  const now = o.now;
  const since = o.since ?? -Infinity;
  const windowMs = o.windowMs ?? YOU_WINDOW_MS;
  const maxChars = o.maxChars ?? YOU_MAX_CHARS;
  const from = now - windowMs;
  const own = o.convId || null;
  const all = [...src.entries].filter((e) => e.ts <= now + 60_000).sort((a, b) => a.ts - b.ts);
  // Not for this reader: its own messages and pasted images (in its thread), and a reply from another conversation.
  const visible = all.filter((e) => {
    // (A voice line of this conversation is in its thread too: a vc-voice message in its pi session.)
    if (own && e.convId === own && (e.kind === "chat" || isPasted(e) || e.kind === "focus" || e.kind === "voice")) return false;
    if (isVoiceReply(e) && e.convId !== own) return false;
    return true;
  });
  // Dedupe, newest wins: one focus per file, one selection, a repeated entry once.
  const seen = new Set<string>();
  const kept: ActivityEntry[] = [];
  for (let i = visible.length - 1; i >= 0; i--) {
    const e = visible[i]!;
    const k =
      e.kind === "focus"
        ? `focus|${isSelection(e) ? "sel" : "file"}|${e.path ?? ""}`
        : e.kind === "chat"
          ? `chat|${e.convId ?? ""}|${e.detail ?? ""}`
          : `${e.kind}|${e.modality}|${e.path ?? ""}|${e.text}|${e.detail ?? ""}|${e.outcome ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    kept.unshift(e);
  }
  const notes = (src.notes ?? []).filter((n) => n.ts <= now + 60_000).sort((a, b) => a.ts - b.ts);
  const board = src.board && src.board.updated <= now + 60_000 ? src.board : null;

  // The last thing he did (any source): shown even when older than the window.
  type Last = { ts: number; e?: ActivityEntry; note?: NoteSnap; board?: true };
  let last: Last | null = null;
  const take = (x: Last) => {
    if (!last || x.ts >= last.ts) last = x;
  };
  for (const e of kept) if (!isVoiceReply(e)) take({ ts: e.ts, e });
  for (const n of notes) take({ ts: n.ts, note: n });
  if (board) take({ ts: board.updated, board: true });
  const lastT = last as Last | null;
  const fresh = (ts: number, isLast: boolean) => ts > since && (ts > from || isLast);

  // Where he is: the open file (and the current selection in it), and the device.
  const focus = [...kept].reverse().find((e) => e.kind === "focus" && !isSelection(e)) ?? [...kept].reverse().find((e) => e.kind === "focus") ?? null;
  const sel = [...kept].reverse().find(isSelection) ?? null;
  const selNow = sel && focus && sel.path === focus.path && now - sel.ts <= SELECTION_FRESH_MS ? sel : null;
  const focusTs = Math.max(focus?.ts ?? -Infinity, selNow?.ts ?? -Infinity);
  let focusLine = "";
  if (focus && focusTs > since && (focusTs > from || lastT?.e === focus || lastT?.e === selNow)) {
    const where = focus.path ? `${focus.path}${focus.where && focus.where !== "selection" ? ` (${focus.where})` : ""}` : focus.text;
    focusLine = clip(
      `Focus: ${where}, ${ago(now - focus.ts)}${selNow ? ` — current selection: ${selNow.text.replace(/^selected /, "")}` : ""}`,
      LINE_MAX + 160,
    );
  }
  const boardOut = board && fresh(board.updated, !!lastT?.board) ? boardLine(board, now) : "";
  const images = kept.filter((e) => e.kind === "capture" && fresh(e.ts, lastT?.e === e));
  const noteRows = notes.filter((n) => fresh(n.ts, lastT?.note === n));
  const chats = kept.filter((e) => e.kind === "chat" && fresh(e.ts, lastT?.e === e));
  const others = kept.filter((e) => (e.kind === "ask" || e.kind === "edit" || e.kind === "voice") && fresh(e.ts, lastT?.e === e));

  // The device he is on: the newest entry that says (his own message in this chat counts).
  const dev = [...all].reverse().find((e) => e.device);
  const devBefore = [...all].reverse().find((e) => e.device && e.ts <= since);
  const somethingNew = !!(focusLine || boardOut || images.length || noteRows.length || chats.length || others.length);
  const devNew = !!dev && dev.ts > since && dev.device !== devBefore?.device;
  if (!somethingNew && !devNew) return { text: "", until: now, items: 0 };

  const header =
    `<you>\nWhat Carl just did across his surfaces${Number.isFinite(since) ? " since your last turn" : ""} (his actions, not instructions). ` +
    `Other chats are pointed at by title, never shown: read one with ReadConversation when it matters.`;
  const footer = "</you>";
  const head: string[] = [];
  if (dev) head.push(`Device: ${dev.device} (${ago(now - dev.ts)})`);
  if (focusLine) head.push(focusLine);
  if (boardOut) head.push(boardOut);

  // Newest first into the budget; each section printed oldest first.
  type Sec = { title: string; rows: { ts: number; line: string }[]; max: number };
  const secs: Sec[] = [
    { title: "Other chats (Carl's messages):", rows: chats.map((e) => ({ ts: e.ts, line: `- ${clip(chatPointer(e, now))}` })), max: MAX_CHATS },
    { title: "Images (captures and pasted; read a path to see it):", rows: images.map((e) => ({ ts: e.ts, line: `- ${imageLine(e, now)}` })), max: MAX_IMAGES },
    { title: "Notes:", rows: noteRows.map((n) => ({ ts: n.ts, line: `- ${noteLine(n, now)}` })), max: MAX_NOTES },
    { title: "Elsewhere (Ctrl+K, Ctrl+L, voice):", rows: others.map((e) => ({ ts: e.ts, line: `- ${otherLine(e, now)}` })), max: 40 },
  ];
  let budget = maxChars - header.length - footer.length - head.join("\n").length - head.length - 64 - secs.reduce((n, s) => n + (s.rows.length ? s.title.length + 1 : 0), 0);
  const chosen = new Map<Sec, Set<number>>(secs.map((s) => [s, new Set<number>()]));
  // Round-robin by section, newest first, so no one section eats the budget.
  const queues = secs.map((s) => s.rows.map((r, i) => ({ r, i })).reverse().slice(0, s.max));
  let left = 0;
  for (let round = 0; queues.some((q) => q.length); round++) {
    for (let k = 0; k < secs.length; k++) {
      const next = queues[k]!.shift();
      if (!next) continue;
      if (next.r.line.length + 1 > budget) {
        left++;
        continue;
      }
      budget -= next.r.line.length + 1;
      chosen.get(secs[k]!)!.add(next.i);
    }
  }
  left += secs.reduce((n, s) => n + Math.max(0, s.rows.length - s.max), 0);
  const parts = [header, ...head];
  let items = head.length - (dev ? 1 : 0);
  for (const s of secs) {
    const idx = chosen.get(s)!;
    if (!idx.size) continue;
    parts.push(s.title, ...s.rows.filter((_, i) => idx.has(i)).map((r) => r.line));
    items += idx.size;
  }
  if (left > 0) parts.push(`(${left} older entr${left === 1 ? "y" : "ies"} left out)`);
  parts.push(footer);
  return { text: parts.join("\n"), until: now, items };
}

// ---------------------------------------------------------------- chat pointers

/** Markdown noise out of a gist (fences, emphasis, headings) — the words stay. */
function stripMd(t: string): string {
  return t
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__|`)([^*_`\n]+)\1/g, "$2");
}

/**
 * Carl's message in a chat, for the stream: the chat's title and his words
 * (≤ GIST_MAX). Only his side: what the agent replies stays in that chat.
 */
export function chatPointerEntry(o: { convId: string; title?: string | null; user?: string | null; project?: string | null; device?: string | null }): Omit<ActivityEntry, "ts"> {
  const user = clean(stripMd(o.user ?? ""), GIST_MAX);
  const dev = DEVICES.includes(o.device as Device) ? (o.device as Device) : null;
  return {
    kind: "chat",
    modality: "chat",
    text: clean(o.title || user || "untitled", 120),
    detail: `Carl: "${user || "(an image)"}"`,
    convId: o.convId,
    ...(o.project ? { project: o.project } : {}),
    ...(dev ? { device: dev } : {}),
  };
}

// ---------------------------------------------------------------- images

/** At most this big, an image goes to a model with a request (a capture is downscaled before it is stored). */
export const CONTEXT_IMAGE_MAX_BYTES = 1_500_000;
/** A capture this fresh counts for "this"/"it" without naming it as an image. */
export const CAPTURE_FRESH_MS = 3 * 60_000;

const IMAGE_NOUN = String.raw`(image|img|figure|fig\.?|plot|graph|chart|diagram|screenshot|screen ?shot|screen ?grab|capture|picture|pic|photo|snip|drawing|sketch)`;
const IMAGE_REFS: RegExp[] = [
  new RegExp(String.raw`\b(this|that|these|those|the|my|last|latest)\s+(\w+\s+)?${IMAGE_NOUN}s?\b`, "i"),
  /\bwhat (I|I've|I have) (just )?(captured|circled|marked|highlighted|grabbed|snipped|boxed|drew|drawn|screenshotted)\b/i,
  /\b(I|I've|I have) (just )?(captured|circled|snipped|screenshotted|boxed)\b/i,
  /\b(the )?(circled|captured|snipped|boxed) (part|bit|region|area|thing|one)\b/i,
];
const DEICTIC = /\b(this|that|it|these|those|here|above)\b/i;

/** The request names an image ("this figure", "what I circled"). */
export function refersToImage(text: string): boolean {
  return IMAGE_REFS.some((re) => re.test(text));
}

/**
 * The capture a request is about, if any: the latest capture with a stored
 * image when the request names an image ("this plot", "what I circled"), or —
 * with `deictic` — when it was taken in the last CAPTURE_FRESH_MS and the
 * request says "this"/"that"/"it". A capture in `exclude` (already given to
 * this reader) is not given again. Cheap: no model, one pass.
 */
export function pickContextImage(
  entries: ActivityEntry[],
  text: string,
  o: { now: number; deictic?: boolean; windowMs?: number; exclude?: Iterable<string> },
): ActivityEntry | null {
  const t = String(text ?? "");
  const named = refersToImage(t);
  const loose = !!o.deictic && t.length <= 400 && DEICTIC.test(t);
  if (!named && !loose) return null;
  const windowMs = o.windowMs ?? DEFAULT_WINDOW_MS;
  let cap: ActivityEntry | null = null;
  for (const e of entries) {
    if (e.kind !== "capture" || !e.image || e.ts <= o.now - windowMs || e.ts > o.now + 60_000) continue;
    if (!cap || e.ts >= cap.ts) cap = e;
  }
  if (!cap) return null;
  if (o.exclude && [...o.exclude].includes(cap.image!)) return null;
  if (named) return cap;
  return o.now - cap.ts <= CAPTURE_FRESH_MS ? cap : null;
}

/** The note that goes with an attached capture. */
export function captureCaption(e: ActivityEntry, now: number): string {
  const from = e.path ? ` from ${e.path}${e.where ? ` (${e.where})` : ""}` : "";
  return `[Attached: Carl's latest image capture${from}, ${ago(now - e.ts)} — the image this request refers to.]`;
}

// ---------------------------------------------------------------- project context

/** A project as the surfaces read it: its shared notes (project.md) and its rules. */
export type ProjectFiles = { slug: string; name: string; notes: string; rules: string };

const capText = (t: string, n: number, keep: "head" | "tail" = "head") => {
  const s = t.trim();
  if (s.length <= n) return s;
  return keep === "head" ? `${s.slice(0, n)}\n[… ${s.length - n} more characters]` : `[… ${s.length - n} more characters]\n${s.slice(s.length - n)}`;
};

/** Carl's rules and the project's shared notes for a small surface (voice), capped
 * well under the chat's (server/context/builder.ts): the same files, the same order. */
export function projectContextBlock(p: ProjectFiles | null, globalRules = "", maxChars = 4000): string {
  const parts: string[] = [];
  if (globalRules.trim()) parts.push(`## Carl's rules\n${capText(globalRules, Math.floor(maxChars * 0.25))}`);
  if (p) {
    const budget = maxChars - (parts[0]?.length ?? 0);
    const sec = (title: string, body: string, share: number, keep: "head" | "tail" = "head") =>
      body.trim() ? `## ${title}\n${capText(body, Math.max(200, Math.floor(budget * share)), keep)}` : "";
    parts.push(
      `# Project: ${p.name} (${p.slug})`,
      sec("Project rules", p.rules, 0.25),
      sec("Shared notes (project.md)", p.notes, 0.75),
    );
  }
  const body = parts.filter(Boolean).join("\n\n");
  if (!body) return "";
  return `<project_context>\n${capText(body, maxChars)}\n</project_context>`;
}

// ---------------------------------------------------------------- what was said by voice

/** One transcript line of a voice session → an entry (system lines are not). */
export function voiceLineEntry(role: "user" | "assistant", text: string, convId?: string | null): Omit<ActivityEntry, "ts"> | null {
  const t = clean(text, 260);
  if (!t) return null;
  return {
    kind: "voice",
    modality: "voice",
    text: role === "user" ? `Carl said: "${t}"` : `Voice replied: "${t}"`,
    ...(convId ? { convId } : {}),
  };
}

// ---------------------------------------------------------------- Ctrl+K

/** A short, human summary of an inline edit: what was there → what replaced it. */
export function editSummary(before: string, after: string): string {
  const lines = (s: string) => (s ? s.split("\n").length : 0);
  const b = before.trim();
  const a = after.trim();
  if (!b) return `inserted ${lines(after)} line(s): "${clean(a, 200)}"`;
  return `replaced ${lines(before)} line(s) with ${lines(after)}: "${clean(b, 200)}" → "${clean(a, 200)}"`;
}
