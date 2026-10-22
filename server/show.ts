// pi's Show tool: put a file (or a web address) in front of Carl, on the
// device he names — or the one he is on now — and report what actually
// happened there.
//
//   laptop  a {type:"show", to:"laptop", id, path | url, target?, pane?} signal on the
//           vault's feed (/poll); the laptop app opens it as a click in the file
//           tree does, scrolled to the target (src/showOnLaptop.ts), and acks
//           (POST /api/v1/show/<id>/ack). Success is only ever that ack. A laptop
//           with no live feed gets nothing sent and an honest "not online".
//           `pane` ("left" | "right") puts it in that pane of the split screen,
//           turning split on (src/paneLayout.ts); the ack then names which pane
//           holds what.
//   board   the iPad inbox through the same validated send as BoardSend
//           (server/inbox.ts): PDF pages, markdown as math parts (one per
//           section when it has several), an image, code or notebook cells as
//           text, an HTML page as a rendered picture. Landed = the entry written.
//           A `label` alone centres that item on the board (the board app acks).
//   phone   the same signal to the phone app (its sheet shows markdown and
//           images, and opens PDFs and pages in the phone's own viewer); acked.
//   here    the device of Carl's latest activity (the "you" layer's Device).
//
// Targets are src/viewTarget.ts's, per file type (the laptop's viewers land
// them; a target that does not fit the type is refused here, before anything
// is sent). Presence: a client's /poll carries `client=laptop|phone|board`;
// a poll in flight, or one that ended a moment ago, is a live client.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileKind, type FileKind } from "../src/fileKind";
import { hasTarget, spotLabel, targetError, targetOf, type ViewTarget } from "../src/viewTarget";
import { matchSection, notFound, type Section } from "../src/scrollTarget";
import { parsePages, MAX_PARTS } from "../src/inboxFormat";
import { readActivity } from "./activity";
import type { SendResult } from "./inbox";

export type Device = "laptop" | "board" | "phone";
const DEVICES: Device[] = ["laptop", "board", "phone"];
const DEVICE_NAME: Record<Device, string> = { laptop: "laptop", board: "iPad board", phone: "phone" };

// ---------------------------------------------------------------- presence (who is on the feed)

/** A client whose last poll ended this long ago still counts as live (the next poll starts at once). */
const LIVE_GRACE_MS = 8_000;
const presence = new Map<string, { open: number; last: number }>();
const pkey = (vault: string, client: string) => `${resolve(vault).toLowerCase()}|${client}`;

/** A /poll from `client` started: call the returned function when it ends. */
export function feedOpened(vault: string, client: string | null | undefined): () => void {
  const c = DEVICES.includes(client as Device) ? (client as Device) : null;
  if (!c) return () => {};
  const k = pkey(vault, c);
  const p = presence.get(k) ?? { open: 0, last: 0 };
  p.open++;
  p.last = Date.now();
  presence.set(k, p);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    p.open = Math.max(0, p.open - 1);
    p.last = Date.now();
  };
}

/** Is `client`'s app following this vault's feed right now? */
export function feedLive(vault: string, client: Device, now = Date.now()): boolean {
  const p = presence.get(pkey(vault, client));
  return !!p && (p.open > 0 || now - p.last < LIVE_GRACE_MS);
}

/** Tests: forget every client. */
export function resetPresence(): void {
  presence.clear();
}

// ---------------------------------------------------------------- acks

export type Ack = { ok: boolean; landed?: string; error?: string; pane?: string };
const waits = new Map<string, (a: Ack) => void>();

/** POST /api/v1/show/<id>/ack: a client says what happened. False: no one is waiting for it (late, or unknown). */
export function ackShow(id: string, body: unknown): boolean {
  const w = waits.get(id);
  if (!w) return false;
  waits.delete(id);
  const b = (body ?? {}) as Record<string, unknown>;
  w({ ok: b.ok === true, ...(typeof b.pane === "string" ? { pane: b.pane.slice(0, 10) } : {}), ...(typeof b.landed === "string" ? { landed: b.landed.slice(0, 600) } : {}), ...(typeof b.error === "string" ? { error: b.error.slice(0, 1200) } : {}) });
  return true;
}

function waitAck(id: string, ms: number): Promise<Ack | null> {
  return new Promise((res) => {
    const t = setTimeout(() => {
      waits.delete(id);
      res(null);
    }, ms);
    waits.set(id, (a) => {
      clearTimeout(t);
      res(a);
    });
  });
}

// ---------------------------------------------------------------- where Carl is

/** The device of his newest activity that says (the "you" layer's Device line), or null. */
export function currentDevice(vault: string, now = Date.now()): { device: Device; ts: number } | null {
  const all = readActivity(vault, now, 7 * 24 * 3_600_000);
  for (let i = all.length - 1; i >= 0; i--) {
    const d = all[i]!.device;
    if (d && DEVICES.includes(d as Device)) return { device: d as Device, ts: all[i]!.ts };
  }
  return null;
}

// ---------------------------------------------------------------- the tool

export type ShowDeps = {
  vault: string;
  /** A vault-level signal on the feed (/poll). */
  emit: (ev: Record<string, unknown>) => void;
  /** The validated inbox send (server/inbox.ts sendEntry, with this conversation and the inbox events). */
  sendBoard: (body: Record<string, unknown>) => Promise<SendResult>;
  /** How long a client has to ack (default: laptop 20 s — a sync and a PDF load can come first — others 10 s). */
  ackMs?: Partial<Record<Device, number>>;
  /** Render an HTML page to a PNG (default: the box's headless browser). Null: none here. */
  renderHtml?: ((html: string) => Promise<{ png: Buffer; cut: number | null } | string>) | null;
};

export type ShowResult = { ok: boolean; text: string; where?: Device };

const SHOW_KEYS = ["path", "url", "where", "pane", "title", "pages", "page", "line", "endLine", "heading", "text", "anchor", "cell", "label"];

export const SHOW_DESCRIPTION =
  "Put something in front of Carl: open a vault file (or a web address) on one of his screens, at a place in it. " +
  'where: "laptop" (the laptop app\'s viewer/editor, scrolled to the place; an open file only scrolls — use this to scroll his laptop too), ' +
  '"board" (his iPad whiteboard inbox: PDF pages, markdown — one item per section —, an image, code or notebook cells as text, an HTML page as a picture), ' +
  '"phone" (the phone app: markdown and images shown, PDFs and pages opened in the phone\'s viewer), ' +
  'or "here"/omitted (the device he is on now, from the "you" layer). ' +
  'The laptop has a split screen: two files side by side, a left pane and a right pane (the turn prefix and the "you" layer say which file is in which, and whether split is on). ' +
  'pane: "left" or "right" (laptop only) puts the file in that pane, turning split on when another file is open; without pane it replaces the file in the active pane. ' +
  'To set up or rebuild a layout (two files side by side), call Show twice: one file with pane "left", the other with pane "right". The result says which pane holds what. Pick where from what he says ("I\'m not near my laptop", "send it to my iPad"); only show what he asked to see, or work you made for him. ' +
  "The place, by file type (one of them): PDF: page (1-based, as PdfRead/PdfPages count) or text (the first page with that phrase); for the board, pages [3,4,5] or \"3-5\" too. " +
  "Markdown: line (a source line, as read numbers them), heading (its text or slug) or text. Code/plain text: line, or line + endLine (the range is highlighted). " +
  "HTML: anchor (an element id), heading or text. Notebook (.ipynb): cell (1-based) or text. Image: none. " +
  'Board with no path: label — centre the item with that label (e.g. "Problem 3") on his board. ' +
  "The result is the confirmed outcome (the place it landed, or why not, with the valid range or nearest headings) — never assume it opened.";

export const SHOW_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "A file in the vault (vault-relative)." },
    url: { type: "string", description: "A web address (laptop: the browser; phone: a link). Not for the board." },
    where: { type: "string", enum: ["laptop", "board", "phone", "here"] },
    pane: { type: "string", enum: ["left", "right"], description: 'Laptop only: the split-screen pane to open it in (split turns on). Omitted: the active pane, as before.' },
    title: { type: "string", description: "Board only: the inbox title (default: the file's name and place)." },
    pages: { description: "Board, PDF: the pages to send, e.g. [3,4] or \"3-5\" (≤ 20; default: the page asked for, else the first 20)." },
    page: { type: "number" },
    line: { type: "number" },
    endLine: { type: "number" },
    heading: { type: "string" },
    text: { type: "string" },
    anchor: { type: "string" },
    cell: { type: "number" },
    label: { type: "string" },
  },
  additionalProperties: false,
} as const;

const fail = (text: string, where?: Device): ShowResult => ({ ok: false, text, ...(where ? { where } : {}) });

/** Show {path | url, where?, place…}. Never throws. */
export async function show(d: ShowDeps, args: Record<string, unknown>): Promise<ShowResult> {
  try {
    return await run(d, args ?? {});
  } catch (e) {
    return fail(`Show failed: ${(e as Error)?.message ?? String(e)}`);
  }
}

async function run(d: ShowDeps, a: Record<string, unknown>): Promise<ShowResult> {
  const unknownKeys = Object.keys(a).filter((k) => !SHOW_KEYS.includes(k));
  if (unknownKeys.length) return fail(`Error: Show does not take ${unknownKeys.join(", ")}.`);
  const target = targetOf(a);
  const rawPath = typeof a.path === "string" ? a.path.trim() : "";
  const url = typeof a.url === "string" ? a.url.trim() : "";
  if (rawPath && url) return fail("Error: give path or url, not both.");

  // Where: named, or the device he is on.
  const asked = typeof a.where === "string" ? a.where.trim().toLowerCase() : "here";
  let where: Device;
  let because = "";
  if (asked === "here" || asked === "") {
    const cur = currentDevice(d.vault);
    if (!cur) return fail('Error: I can\'t tell which device Carl is on (nothing recent says). Pass where: "laptop", "board" or "phone".');
    where = cur.device;
    because = ` (he is on his ${DEVICE_NAME[where]})`;
  } else if (DEVICES.includes(asked as Device)) where = asked as Device;
  else if (asked === "ipad") where = "board";
  else return fail(`Error: where is "laptop", "board", "phone" or "here", not "${asked}".`);

  // A pane of the laptop's split screen.
  let pane: "left" | "right" | undefined;
  if (a.pane !== undefined) {
    const p = typeof a.pane === "string" ? a.pane.trim().toLowerCase() : "";
    if (p !== "left" && p !== "right") return fail(`Error: pane is "left" or "right" (the laptop's split screen), not ${JSON.stringify(a.pane)}.`);
    if (where !== "laptop") return fail(`Error: pane is for the laptop's split screen; the ${DEVICE_NAME[where]}${because} has no panes. Leave pane out, or pass where: "laptop".`);
    if (url) return fail("Error: a web address opens in the browser, not in a pane; pane is for a vault file.");
    pane = p;
  }

  // A label alone: an item on the board.
  if (!rawPath && !url) {
    if (where === "board" && target.label) return boardLabel(d, target.label);
    return fail("Error: Show needs a path (a vault file) or a url" + (target.label ? ' (label alone is for where: "board")' : "") + ".");
  }
  if (url) {
    if (!/^https?:\/\//i.test(url)) return fail("Error: url must start with http:// or https://.");
    if (hasTarget(target)) return fail("Error: a web address takes no place in it (page, line, heading…); open it, then say where to look.");
    if (where === "board") return fail("The board inbox doesn't take web addresses (everything on it is a file in the vault, so it works offline). Open it on the laptop or phone, or save what matters as a file and send that.", where);
    return toClient(d, where, { url }, url, because);
  }

  // A vault file.
  const f = await vaultFile(d.vault, rawPath);
  if (typeof f === "string") return fail(`Error: ${f}`);
  const kind = fileKind(f.rel).kind;
  const name = basename(f.rel);
  const t: ViewTarget = { ...target };
  if (where === "board" && kind === "pdf") delete t.page; // the board takes page as which page to send
  if (where !== "board" && a.pages !== undefined) return fail("Error: pages is for sending PDF pages to the board; on a screen pass page (one page to go to).");
  if (t.label) return fail(`Error: label is for an item on the board (with no path); ${name} takes ${spotTakes(kind)}.`);
  const bad = targetError(kind, t, name);
  if (bad) return fail(bad);
  if (where === "board") return toBoard(d, f, kind, target, a);
  return toClient(d, where, { path: f.rel, ...(hasTarget(t) ? { target: t } : {}), ...(pane ? { pane } : {}) }, `${name}${pane ? ` in the ${pane} pane` : ""}${hasTarget(t) ? ` at ${spotLabel(t)}` : ""}`, because);
}

function spotTakes(kind: FileKind): string {
  const m: Partial<Record<FileKind, string>> = { pdf: "page or text", markdown: "line, heading or text", code: "line (and endLine)", html: "anchor, heading or text", notebook: "cell or text" };
  return m[kind] ?? "no place (it just opens)";
}

/** A path (vault-relative or absolute) to an existing file inside the vault, by the same rule as every vault tool (server/voice.ts voicePath: never .git or a restricted entry), or why not. */
async function vaultFile(vault: string, p: string): Promise<{ abs: string; rel: string } | string> {
  let r: { abs: string; rel: string };
  try {
    r = (await import("./voice")).voicePath(vault, p, "read");
  } catch (e) {
    return String(e).replace(/^Refused: /, "");
  }
  try {
    if (!statSync(r.abs).isFile()) return `${r.rel} is not a file`;
  } catch {
    return `${r.rel} does not exist in the vault`;
  }
  return r;
}

// ---------------------------------------------------------------- laptop / phone: a signal, then the ack

async function toClient(d: ShowDeps, where: Device, payload: Record<string, unknown>, what: string, because: string): Promise<ShowResult> {
  if (where === "board") return fail("internal: board is not a feed client here");
  const dev = DEVICE_NAME[where];
  if (!feedLive(d.vault, where)) {
    const alt = where === "laptop" ? 'send it to the board instead (where: "board")?' : 'show it on the laptop or send it to the board instead?';
    return fail(`The ${dev} isn't online (the vault-chat app isn't open and connected on it), so nothing was shown${because}. Ask Carl: ${alt}`, where);
  }
  if (where === "phone" && payload.target) {
    // The phone has no viewer that moves to a place: it shows the file whole.
    delete payload.target;
  }
  const id = `show-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const ms = d.ackMs?.[where] ?? (where === "laptop" ? 20_000 : 10_000);
  const t0 = Date.now();
  const got = waitAck(id, ms);
  d.emit({ type: "show", id, to: where, ...payload });
  const ack = await got;
  console.log(`[show] to=${where} ${ack ? (ack.ok ? "ok" : "refused") : "no-ack"} ${Date.now() - t0}ms`);
  if (!ack) return fail(`Sent ${what} to the ${dev}${because}, but it did not confirm within ${Math.round(ms / 1000)} s — it may not have opened. Don't tell Carl it's open; ask him to check, or send it to the board instead.`, where);
  if (!ack.ok) return fail(`On the ${dev}${because}: ${ack.error ?? "it could not be shown"}`, where);
  const phoneNote = where === "phone" && what.includes(" at ") ? " (the phone shows it whole; it can't jump to a place)" : "";
  // An app from before panes opens it in the active pane and does not say a pane: say so, never claim the split.
  const paneNote = payload.pane && ack.pane !== payload.pane ? ` (this laptop app is older and has no pane control: it opened in the active pane, not the ${payload.pane} pane — Carl can drag it to that side, or update the app)` : "";
  return { ok: true, where, text: `Shown on the ${dev}${because}: ${ack.landed ?? what}${phoneNote}${paneNote}.` };
}

async function boardLabel(d: ShowDeps, label: string): Promise<ShowResult> {
  if (!feedLive(d.vault, "board")) return fail("The board isn't open on the iPad right now, so nothing was moved. Carl can find it when he opens the board.", "board");
  const id = `show-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const ms = d.ackMs?.board ?? 10_000;
  const got = waitAck(id, ms);
  d.emit({ type: "show", id, to: "board", target: { label } });
  const ack = await got;
  if (!ack) return fail(`Asked the board to show "${label}", but it did not confirm within ${Math.round(ms / 1000)} s.`, "board");
  if (!ack.ok) return fail(`On the board: ${ack.error ?? `no item labelled "${label}"`}`, "board");
  return { ok: true, where: "board", text: `Shown on the board: ${ack.landed ?? `"${label}" centred in view`}.` };
}

// ---------------------------------------------------------------- board: an inbox entry

type Part = Record<string, unknown>;

async function toBoard(d: ShowDeps, f: { abs: string; rel: string }, kind: FileKind, t: ViewTarget, a: Record<string, unknown>): Promise<ShowResult> {
  const name = basename(f.rel);
  let parts: Part[];
  let spot = "";
  let note = "";
  switch (kind) {
    case "pdf": {
      const texts = await pdfTexts(f.abs).catch(() => null);
      if (!texts) return fail(`Error: ${f.rel} is not a readable PDF.`);
      const n = texts.length;
      let pages: number[];
      if (a.pages !== undefined) {
        const p = parsePages(a.pages);
        if (typeof p === "string") return fail(`Error: ${p}`);
        pages = p;
      } else if (t.page !== undefined) pages = [t.page];
      else if (t.text) {
        const i = texts.findIndex((x) => squash(x).includes(squash(t.text!)));
        if (i < 0) return fail(`Error: "${t.text}" does not appear in ${name} (${n} pages). Pass page (1–${n}) or pages.`);
        pages = [i + 1];
      } else {
        pages = Array.from({ length: Math.min(n, 20) }, (_, i) => i + 1);
        if (n > 20) note = `pages 1–20 of ${n}`;
      }
      const out = pages.filter((p) => p > n);
      if (out.length) return fail(`Error: ${name} has ${n} page${n === 1 ? "" : "s"}; there is no page ${out.join(", ")}. Pages are 1–${n}.`);
      if (pages.length > 20) return fail("Error: at most 20 pages at once.");
      parts = [{ kind: "pdf", path: f.rel, pages }];
      spot = pages.length === 1 ? `page ${pages[0]}` : `pages ${pages[0]}–${pages[pages.length - 1]}`;
      break;
    }
    case "markdown": {
      const r = mdParts(readFileSync(f.abs, "utf8"), t, f.rel);
      if ("error" in r) return fail(r.error);
      parts = r.parts;
      spot = r.spot;
      break;
    }
    case "image": {
      parts = [{ kind: "image", path: f.rel, alt: name }];
      break;
    }
    case "code": {
      const lines = readFileSync(f.abs, "utf8").split(/\r?\n/);
      const from = t.line ?? 1;
      if (from > lines.length) return fail(`Error: ${name} has ${lines.length} lines; there is no line ${from}. Lines are 1–${lines.length}.`);
      const to = Math.min(t.endLine ?? (t.line !== undefined ? t.line : lines.length), lines.length);
      const body = lines.slice(from - 1, Math.min(to, from - 1 + 120)).join("\n");
      if (to - from + 1 > 120) note = `the first 120 lines of ${from}–${to}`;
      const fence = body.includes("```") ? "~~~~" : "```";
      parts = [{ kind: "math", markdown: `${fence}${extname(f.rel).slice(1)}\n${body}\n${fence}`, label: `${name} ${from === to ? `line ${from}` : `lines ${from}–${Math.min(to, from + 119)}`}` }];
      spot = t.line !== undefined ? spotLabel({ line: from, endLine: to }) : "";
      break;
    }
    case "notebook": {
      const r = notebookParts(readFileSync(f.abs, "utf8"), t, name);
      if ("error" in r) return fail(r.error);
      parts = r.parts;
      spot = r.spot;
      break;
    }
    case "html": {
      if (hasTarget(t)) return fail(`Error: on the board an HTML page is one picture of the page; send it without a place, or show it on the laptop to go to ${spotLabel(t)}.`);
      const r = await renderPage(d, f, name);
      if (typeof r === "string") return fail(r);
      parts = [{ kind: "image", path: r.rel, alt: `${name}, rendered as a picture`, label: name }];
      note = "a picture of the page (no scripts, links or live parts)" + (r.cut ? `; its first ${r.cut}px` : "");
      break;
    }
    default:
      return fail(`The board inbox takes PDF pages, markdown, images, code or notebook cells and HTML pages (as a picture), not ${name}. Show it on the laptop instead.`);
  }
  const title = (typeof a.title === "string" && a.title.trim() ? a.title.trim() : `${name}${spot ? `, ${spot}` : ""}`).slice(0, 120);
  const r = await d.sendBoard({ title, ...(note ? { note } : {}), parts });
  if (!r.ok) return fail(`Not sent to the board (nothing reached the inbox):\n- ${r.refusals.join("\n- ")}`, "board");
  return { ok: true, where: "board", text: `In Carl's board inbox: "${title}" (${r.parts} part${r.parts === 1 ? "" : "s"}${note ? `; ${note}` : ""}), entry ${r.id}.` };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

async function pdfTexts(abs: string): Promise<string[]> {
  const pdfjs: any = await import("pdfjs-dist");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(abs)), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  try {
    const out: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      out.push(tc.items.map((x: any) => x.str ?? "").join(" "));
    }
    return out;
  } finally {
    await doc.destroy?.();
  }
}

type Sec = { level: number; text: string; start: number; end: number };

/** Markdown sections by heading (outside fences and front matter); `start`/`end` are 0-based line indexes, end exclusive. */
function mdSections(lines: string[]): { secs: Sec[]; bodyFrom: number } {
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const e = lines.findIndex((l, j) => j > 0 && l.trim() === "---");
    if (e > 0) i = e + 1;
  }
  const bodyFrom = i;
  const secs: Sec[] = [];
  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    const fm = /^\s{0,3}(```|~~~)/.exec(l);
    if (fm) fence = fence ? (l.trim().startsWith(fence) ? null : fence) : fm[1]!;
    if (fence) continue;
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) secs.push({ level: h[1]!.length, text: h[2]!.replace(/[*_`]/g, "").trim(), start: i, end: lines.length });
  }
  for (let k = 0; k < secs.length; k++) {
    const nxt = secs.slice(k + 1).find((s) => s.level <= secs[k]!.level);
    secs[k]!.end = nxt ? nxt.start : lines.length;
  }
  return { secs, bodyFrom };
}

/** The markdown for the board: the section a place names, or each top section as its own part (a problem set). */
export function mdParts(src: string, t: ViewTarget, rel: string): { parts: Part[]; spot: string } | { error: string } {
  const lines = src.split(/\r?\n/);
  const { secs, bodyFrom } = mdSections(lines);
  const name = basename(rel);
  const part = (from: number, to: number, label?: string): Part => ({ kind: "math", markdown: lines.slice(from, to).join("\n").trim(), ...(label ? { label: label.slice(0, 80) } : {}) });
  const sections: Section[] = secs.map((s) => ({ text: s.text }));
  if (t.heading) {
    const i = matchSection(sections, t.heading);
    if (i === null) return { error: notFound(t.heading, rel, sections).replace("Call ScrollTo again", "Call Show again") };
    const s = secs[i]!;
    return { parts: [part(s.start, s.end, s.text)], spot: `"${s.text}"` };
  }
  if (t.line !== undefined || t.text) {
    let idx = t.line !== undefined ? t.line - 1 : lines.findIndex((l) => squash(l).includes(squash(t.text!)));
    if (t.line !== undefined && (idx < 0 || idx >= lines.length)) return { error: `Error: ${name} has ${lines.length} lines; there is no line ${t.line}. Lines are 1–${lines.length}.` };
    if (idx < 0) return { error: notFound(t.text!, rel, sections).replace("Call ScrollTo again", "Call Show again") };
    // The innermost section holding that line; before the first heading, the opening text.
    const s = [...secs].reverse().find((x) => x.start <= idx && idx < x.end);
    if (!s) return { parts: [part(bodyFrom, secs[0]?.start ?? lines.length)], spot: t.line !== undefined ? `line ${t.line}` : `"${t.text}"` };
    return { parts: [part(s.start, s.end, s.text)], spot: `"${s.text}"` };
  }
  // The whole file: one part per section at the first level with two or more (a problem set: one problem each).
  for (let level = 1; level <= 6; level++) {
    const top = secs.filter((s) => s.level === level);
    if (top.length < 2) continue;
    const parts: Part[] = [];
    const lead = lines.slice(bodyFrom, top[0]!.start).filter((l) => l.trim() && !/^\s{0,3}#{1,6}\s/.test(l));
    if (lead.length) parts.push(part(bodyFrom, top[0]!.start));
    for (const s of top) parts.push(part(s.start, s.end, s.text));
    if (parts.length > MAX_PARTS) break;
    return { parts, spot: "" };
  }
  return { parts: [part(bodyFrom, lines.length, secs[0]?.text)], spot: "" };
}

function notebookParts(src: string, t: ViewTarget, name: string): { parts: Part[]; spot: string } | { error: string } {
  let nb: any;
  try {
    nb = JSON.parse(src);
  } catch (e) {
    return { error: `Error: ${name} is not a readable notebook (${(e as Error).message}).` };
  }
  const cells: any[] = Array.isArray(nb?.cells) ? nb.cells : [];
  const lang = String(nb?.metadata?.language_info?.name ?? nb?.metadata?.kernelspec?.language ?? "python");
  const srcOf = (c: any) => (Array.isArray(c?.source) ? c.source.join("") : String(c?.source ?? ""));
  const asPart = (c: any, i: number): Part => ({ kind: "math", markdown: c?.cell_type === "markdown" ? srcOf(c) : "```" + lang + "\n" + srcOf(c) + "\n```", label: `Cell ${i + 1}` });
  const n = cells.length;
  if (!n) return { error: `Error: ${name} has no cells.` };
  if (t.cell !== undefined) {
    if (t.cell > n) return { error: `Error: ${name} has ${n} cells; there is no cell ${t.cell}. Cells are 1–${n}.` };
    return { parts: [asPart(cells[t.cell - 1], t.cell - 1)], spot: `cell ${t.cell}` };
  }
  if (t.text) {
    const i = cells.findIndex((c) => squash(srcOf(c)).includes(squash(t.text!)));
    if (i < 0) return { error: `Error: "${t.text}" is in none of the ${n} cells of ${name}. Pass cell (1–${n}).` };
    return { parts: [asPart(cells[i], i)], spot: `cell ${i + 1}` };
  }
  const keep = cells.map((c, i) => ({ c, i })).filter(({ c }) => srcOf(c).trim()).slice(0, 20);
  return { parts: keep.map(({ c, i }) => asPart(c, i)), spot: "" };
}

/** An HTML page as a picture beside the inbox: rendered once, offline (no network, its own scripts only). */
async function renderPage(d: ShowDeps, f: { abs: string; rel: string }, name: string): Promise<{ rel: string; cut: number | null } | string> {
  const html = readFileSync(f.abs, "utf8");
  const render = d.renderHtml === undefined ? defaultRender : d.renderHtml;
  if (!render) return "The board can't take this HTML page: the box has no headless browser to render it as a picture. Show it on the laptop instead.";
  const out = await render(html);
  if (typeof out === "string") return `The page could not be rendered for the board (${out}). Show it on the laptop instead.`;
  const hash = createHash("sha256").update(out.png).digest("hex").slice(0, 10);
  const rel = `boards/.inbox/rendered/${name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-").slice(0, 60)}-${hash}.png`;
  mkdirSync(join(d.vault, "boards", ".inbox", "rendered"), { recursive: true });
  writeFileSync(join(d.vault, ...rel.split("/")), out.png);
  return { rel, cut: out.cut };
}

const PAGE_W = 1000;
const PAGE_MAX_H = 2000;

async function defaultRender(html: string): Promise<{ png: Buffer; cut: number | null } | string> {
  const { findBrowser, headless } = await import("./headless");
  const { WIDGET_CSP } = await import("../src/widgetHost");
  if (!findBrowser()) return "no headless browser on the box";
  const csp = `<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">`;
  const probe = `<pre id="vc-result" style="display:none"></pre><script>addEventListener("load",function(){setTimeout(function(){document.getElementById("vc-result").textContent=JSON.stringify({h:Math.ceil(document.documentElement.scrollHeight)})},300)});</script>`;
  // Our CSP first (before anything of the page's), the height probe last.
  let doc = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${csp}`) : `${csp}${html}`;
  doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, `${probe}</body>`) : `${doc}${probe}`;
  let cut: number | null = null;
  const r = await headless(doc, { w: PAGE_W, h: 800, budgetMs: 4000, shot: (v) => {
    let h = 800;
    try {
      h = Math.max(200, Number(JSON.parse(String(v)).h) || 800);
    } catch {
      /* no verdict: the first screen */
    }
    cut = h > PAGE_MAX_H ? PAGE_MAX_H : null;
    return Math.min(h, PAGE_MAX_H);
  } });
  return r.png ? { png: r.png, cut } : "the browser returned no picture";
}
