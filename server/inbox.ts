// The board inbox on the box (board/INBOX.md; format: src/inboxFormat.ts).
//
//   boards/.inbox/<id>/entry.json   one send: title, note, parts, status
//   boards/.inbox/<id>/part-<n>.*   what the box made of a part: the typeset
//                                   math (.html), a widget's bundle (.widget.js),
//                                   snapshots (.png)
//
// A send is validated whole before anything is written; every reason it is
// refused is returned (the agent fixes them; Carl never sees a bad send):
//   pdf    — the file is a PDF in the vault, the pages exist, at most 20
//   math   — every $…$ / $$…$$ compiles in KaTeX (its message on failure);
//            the markdown is typeset by vault-chat's one markdown pipeline
//   image  — PNG / JPEG / WebP / SVG in the vault, ≤ 20 MB, bitmaps ≤ 4096 px
//            on the long side; an SVG with script, foreignObject, event
//            handlers or outside references is refused; `alt` is required
//   widget — esbuild bundles it, and it mounts without throwing in a headless
//            Chromium (server/headless.ts), which also takes its PNG snapshot
//
// Parts are checked in parallel (at most CHECKS at once; results and refusals
// in send order). A math part's snapshot is taken after the entry lands (it is
// for the agent and the overview; the board typesets the math itself), and
// lands as a second event. A make streams: each BoardSend {make, more:true}
// adds its parts to the entry still being made, the last send (no `more`)
// finishes it.
//
// "Add to board" copies a part's files into the board's assets/ (named by
// their content, so a PDF added twice is stored once) and returns the items
// for the app to place. Every change pushes {type:"inbox"} on the /poll ring.
//
// Timings: one line per phase in the box's board log (<state>/logs/board.jsonl,
// ev "inbox.*", the entry id on every line).
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { boxLogs } from "./boxLogs";
import { appendActivity } from "./activity";
import { ASSETS_DIR, imageSize, slugify, validSlug } from "../src/boardFormat";
import {
  ENTRY_FILE,
  INBOX_DIR,
  MATH_LAYOUT_W,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
  MAX_MATH_CHARS,
  MAX_PARTS,
  MAX_WIDGET_BYTES,
  WIDGET_LAYOUT,
  parsePages,
  summarize,
  validEntryId,
  type Entry,
  type EntrySummary,
  type Part,
} from "../src/inboxFormat";
import { mathDocument, widgetDocument } from "../src/widgetHost";
import { boardDir, ensureBoardsHidden, type Out } from "./boards";
// voice.ts (the vault path guard) is loaded on first use, not with this module: the engine imports this
// one, and voice.ts brings the app's command modules with it.
const voicePath = async (vault: string, p: unknown, mode: "read" | "write") => (await import("./voice")).voicePath(vault, p, mode);
import { writeAtomic, renameRetry } from "./atomic";
import { findBrowser, headless, warmUp } from "./headless";
import { katexCss } from "./katexCss";

/**
 * On /poll. `landed`: the entry is done (a direct send, or a make's last send). `making` + `parts`: a make's
 * parts so far (`parts`: how many). `snapshot`: a part's snapshot came in after the entry landed.
 */
export type InboxEvent = { type: "inbox"; id: string; status: string; title: string; landed?: boolean; failed?: string; making?: boolean; parts?: number; snapshot?: boolean };
/** `log`: where the timing lines go (default: the box's board log under `stateDir`). */
export type InboxCtx = { conversation?: string; stateDir?: string; emit?: (ev: InboxEvent) => void; log?: (rec: Record<string, unknown>) => void };

// ---------------------------------------------------------------- timings

/** The timing sink: ctx.log, else the board log in the state dir (the server's own default on the box), else none. */
function sinkOf(ctx: InboxCtx): ((rec: Record<string, unknown>) => void) | null {
  if (ctx.log) return ctx.log;
  const dir = ctx.stateDir ?? process.env.VC_STATE_DIR ?? (process.env.NODE_ENV === "production" ? join(homedir(), ".local", "state", "vault-chat-server") : null);
  return dir ? (rec) => boxLogs(dir).board.append(rec) : null;
}

/** One timing line: `ev` is "inbox.<phase>", `ms` the phase's own time, `t` ms since the send (or make) began. */
export function inboxLog(ctx: InboxCtx, ev: string, rec: Record<string, unknown>): void {
  try {
    sinkOf(ctx)?.({ at: new Date().toISOString(), ev: `inbox.${ev}`, ...rec });
  } catch {
    /* logging never breaks a send */
  }
}

/** Run `f`, log its time as `phase` with `rec`. */
async function timed<T>(ctx: InboxCtx, phase: string, rec: Record<string, unknown>, f: () => Promise<T> | T): Promise<T> {
  const t0 = performance.now();
  try {
    return await f();
  } finally {
    inboxLog(ctx, "phase", { phase, ...rec, ms: Math.round(performance.now() - t0) });
  }
}

// ---------------------------------------------------------------- one at a time per entry

const locks = new Map<string, Promise<unknown>>();
/** `f` after every earlier call for the same entry (a make's sends and its snapshots never interleave). */
function withLock<T>(id: string, f: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.then(f, f);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  void tail.then(() => locks.get(id) === tail && locks.delete(id));
  return run;
}

/** Work that runs after an entry landed (math snapshots). */
const after = new Set<Promise<unknown>>();
/** Resolves when the after-landing work started so far is done (tests, the bench). */
export async function inboxSettled(): Promise<void> {
  while (after.size) await Promise.all([...after]);
}

/** `items` mapped by `f` with at most `n` at once; results in order. */
async function pool<T, R>(items: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * Load what the checks use before they need it: the headless browser and the typesetting and PDF modules (a
 * cold first send otherwise spends seconds on them). Called when a make starts and when a send arrives.
 */
export function prewarm(): void {
  warmUp();
  void mathErrors("$x$").catch(() => {});
  void typesetMath("x").catch(() => {});
  void import("pdfjs-dist").catch(() => {});
}

/** Parts checked at once (each may hold a tab in the headless browser). */
const CHECKS = 4;

/** This server process (a make that was running in another one is gone). */
export const INBOX_BOOT = randomBytes(6).toString("hex");

function inboxRoot(vault: string): string {
  const root = join(vault, "boards", INBOX_DIR);
  mkdirSync(root, { recursive: true });
  ensureBoardsHidden(vault);
  return root;
}

function entryPath(vault: string, id: string): string | null {
  if (!validEntryId(id)) return null;
  return join(inboxRoot(vault), id);
}

export function readEntry(vault: string, id: string): Entry | null {
  const dir = entryPath(vault, id);
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(join(dir, ENTRY_FILE), "utf8")) as Entry;
  } catch {
    return null;
  }
}

function writeEntry(vault: string, e: Entry): void {
  const dir = entryPath(vault, e.id)!;
  mkdirSync(dir, { recursive: true });
  e.updatedAt = Date.now();
  writeAtomic(join(dir, ENTRY_FILE), JSON.stringify(e, null, 1) + "\n");
}

/** A make that was running in a server process that is gone failed with it. */
function settleStale(vault: string, e: Entry, ctx: InboxCtx): Entry {
  if (e.making && !e.failed && e.making.boot && e.making.boot !== INBOX_BOOT) {
    e.failed = "the box restarted while it was being made";
    writeEntry(vault, e);
    ctx.emit?.({ type: "inbox", id: e.id, status: e.status, title: e.title, failed: e.failed });
  }
  return e;
}

export function listEntries(vault: string, ctx: InboxCtx = {}): { entries: EntrySummary[]; unread: number } {
  const root = inboxRoot(vault);
  const out: Entry[] = [];
  for (const id of readdirSync(root)) {
    const e = validEntryId(id) ? readEntry(vault, id) : null;
    if (e) out.push(settleStale(vault, e, ctx));
  }
  out.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const entries = out.map(summarize);
  return { entries, unread: entries.filter((x) => x.status === "unread" && !x.making).length };
}

export function getEntry(vault: string, id: string, ctx: InboxCtx = {}): Out {
  const e = readEntry(vault, id);
  return e ? { status: 200, body: settleStale(vault, e, ctx) } : { status: validEntryId(id) ? 404 : 400, body: { error: "no such inbox entry" } };
}

export function markRead(vault: string, id: string, ctx: InboxCtx = {}): Out {
  const e = readEntry(vault, id);
  if (!e) return { status: 404, body: { error: "no such inbox entry" } };
  if (e.status === "unread" && !e.making) {
    e.status = "read";
    writeEntry(vault, e);
    ctx.emit?.({ type: "inbox", id, status: e.status, title: e.title });
  }
  return { status: 200, body: { ok: true, status: e.status } };
}

/** `{part, board, items}`: part `part` (an index) became `items` on board `board`. */
export function markAdded(vault: string, id: string, b: any, ctx: InboxCtx = {}): Out {
  const e = readEntry(vault, id);
  if (!e) return { status: 404, body: { error: "no such inbox entry" } };
  const part = Number(b?.part);
  if (!Number.isInteger(part) || part < 0 || part >= e.parts.length) return { status: 400, body: { error: "part: an index of this entry's parts" } };
  if (!validSlug(b?.board)) return { status: 400, body: { error: "board: a board's slug" } };
  const items = Array.isArray(b?.items) ? b.items.map(String).slice(0, 40) : [];
  e.added = { ...(e.added ?? {}), [String(part)]: { board: b.board, items, at: Date.now() } };
  e.status = "added";
  writeEntry(vault, e);
  ctx.emit?.({ type: "inbox", id, status: e.status, title: e.title });
  return { status: 200, body: { ok: true, status: e.status } };
}

// ---------------------------------------------------------------- making (BoardMake)

/** A make starts: its entry exists at once ("being made", with its title). */
export function startMake(vault: string, a: { title: string; request: string }, ctx: InboxCtx = {}): Entry {
  const title = oneLine(a.title, 120) || "Something for the board";
  const e: Entry = {
    id: newId(vault, title),
    title,
    note: "",
    ...(ctx.conversation ? { from: { conversation: ctx.conversation } } : {}),
    createdAt: Date.now(),
    parts: [],
    status: "unread",
    making: { request: String(a.request ?? "").slice(0, 4000), startedAt: Date.now(), boot: INBOX_BOOT },
  };
  writeEntry(vault, e);
  ctx.emit?.({ type: "inbox", id: e.id, status: e.status, title: e.title, making: true, parts: 0 });
  inboxLog(ctx, "make.start", { id: e.id });
  prewarm();
  return e;
}

/**
 * A make that ended without its last send: "couldn't make: <reason>". The parts it already sent stay (each passed
 * the checks), with `failed` saying it is unfinished. No-op once it landed.
 */
export function failMake(vault: string, id: string, reason: string, ctx: InboxCtx = {}): boolean {
  const e = readEntry(vault, id);
  if (!e || !e.making || e.failed) return false;
  e.failed = oneLine(reason, 300) || "the make ended without sending anything";
  writeEntry(vault, e);
  ctx.emit?.({ type: "inbox", id, status: e.status, title: e.title, failed: e.failed, parts: e.parts.length });
  inboxLog(ctx, "make.failed", { id, parts: e.parts.length, ms: Date.now() - (e.making.startedAt ?? e.createdAt) });
  return true;
}

// ---------------------------------------------------------------- the validated send

export type SendResult = { ok: true; id: string; parts: number; making?: boolean } | { ok: false; refusals: string[] };

/**
 * The send: `{title, note?, parts, make?, more?}`. `make`: the id of a "being made" entry this send fills; with
 * `more: true` its parts are added and the entry stays being made (the maker sends each part as soon as it is
 * made), without it the send finishes the entry (its parts, possibly none, are the last).
 */
export async function sendEntry(vault: string, body: any, ctx: InboxCtx = {}): Promise<SendResult> {
  const make = typeof body?.make === "string" ? body.make : null;
  if (body?.make !== undefined && make && validEntryId(make)) return withLock(make, () => send(vault, body, ctx));
  return send(vault, body, ctx);
}

async function send(vault: string, body: any, ctx: InboxCtx): Promise<SendResult> {
  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);
  const refusals: string[] = [];
  const raw: unknown[] = Array.isArray(body?.parts) ? body.parts : [];
  const more = body?.more === true;
  let target: Entry | null = null;
  if (body?.make !== undefined) {
    target = typeof body.make === "string" ? readEntry(vault, body.make) : null;
    if (!target) refusals.push(`make: no entry ${String(body.make).slice(0, 80)} is being made`);
    else if (!target.making) refusals.push(`make: ${target.id} was already sent`);
    else if (target.failed) refusals.push(`make: ${target.id} already failed (${target.failed})`);
  } else if (more) refusals.push("more: only with make (the parts of an entry being made)");
  const have = target?.making ? target.parts.length : 0;
  const title = oneLine(body?.title, 120) || (target?.making ? target.title : "");
  if (!title) refusals.push("title: a one-line title is required");
  const note = body?.note !== undefined ? oneLine(body?.note, 300) : (target?.note ?? "");
  if (!raw.length && !have) refusals.push("parts: at least one part is required");
  if (have + raw.length > MAX_PARTS) refusals.push(`parts: at most ${MAX_PARTS} per entry`);
  const id = target?.id ?? (refusals.length ? "" : newId(vault, title));
  inboxLog(ctx, "send.start", { id: id || null, make: !!target, more, parts: raw.length, have });
  if (refusals.length) {
    inboxLog(ctx, "send.refused", { id: id || null, refusals: refusals.length, t: since() });
    return { ok: false, refusals };
  }

  if (raw.some((p: any) => p?.kind === "widget" || p?.kind === "math")) warmUp();
  const dir = entryPath(vault, id)!;
  const checked = await pool(raw, CHECKS, async (p, n) => {
    const where = `part ${n + 1}`;
    const tm = { ctx, rec: { id, part: have + n + 1, kind: (p as any)?.kind ?? null } };
    try {
      return await timed(ctx, "part", tm.rec, () => checkPart(vault, p, have + n, tm));
    } catch (e) {
      return `${where}: ${(e as Error)?.message ?? String(e)}`;
    }
  });
  const parts: Part[] = [];
  const files: { name: string; data: Buffer | string }[] = [];
  const snaps: { n: number; html: string }[] = [];
  checked.forEach((r, n) => {
    if (typeof r === "string") refusals.push(r.startsWith(`part ${n + 1}: `) ? r : `part ${n + 1}: ${r}`);
    else {
      parts.push(r.part);
      files.push(...r.files);
      if (r.snapshot) snaps.push({ n: have + n, html: r.snapshot });
    }
  });
  if (refusals.length) {
    inboxLog(ctx, "send.refused", { id, refusals: refusals.length, t: since() });
    return { ok: false, refusals };
  }

  await timed(ctx, "write", { id, files: files.length }, () => {
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const p = join(dir, f.name);
      writeFileSync(`${p}.tmp`, f.data);
      renameRetry(`${p}.tmp`, p);
    }
    const e: Entry = {
      id,
      title,
      note,
      ...(ctx.conversation || target?.from ? { from: { conversation: ctx.conversation ?? target?.from?.conversation } } : {}),
      createdAt: target?.createdAt ?? Date.now(),
      parts: [...(target?.parts ?? []), ...parts],
      status: target?.status ?? "unread",
      ...(target?.added ? { added: target.added } : {}),
      ...(more && target?.making ? { making: target.making } : {}),
    };
    writeEntry(vault, e);
  });
  const total = have + parts.length;
  ctx.emit?.(more ? { type: "inbox", id, status: target?.status ?? "unread", title, making: true, parts: total } : { type: "inbox", id, status: target?.status ?? "unread", title, landed: true, parts: total });
  inboxLog(ctx, "send.landed", { id, more, parts: parts.length, total, t: since(), ...(target?.making && !more ? { makeMs: Date.now() - target.making.startedAt } : {}) });
  // The shared stream: every surface's next turn (and a voice call on any chat) knows it landed.
  if (!more) appendActivity(vault, { kind: "inbox", text: `"${title}" landed in the board inbox (${total} part${total === 1 ? "" : "s"})`, ...(ctx.conversation ? { convId: ctx.conversation } : {}) });
  if (snaps.length && findBrowser()) {
    const job = snapshotsAfter(vault, id, snaps, ctx).catch(() => {});
    after.add(job);
    void job.finally(() => after.delete(job));
  }
  return { ok: true, id, parts: total, ...(more ? { making: true } : {}) };
}

/** Math snapshots, after the entry landed: each one is written into its part, with an event. */
async function snapshotsAfter(vault: string, id: string, snaps: { n: number; html: string }[], ctx: InboxCtx): Promise<void> {
  await pool(snaps, 2, async ({ n, html }) => {
    const shot = await timed(ctx, "mathShot", { id, part: n + 1, after: true }, () => mathSnapshot(html)).catch(() => null);
    if (!shot) return;
    await withLock(id, async () => {
      const e = readEntry(vault, id);
      const p = e?.parts[n];
      if (!e || !p || p.kind !== "math" || p.html !== `part-${n + 1}.html`) return;
      const dir = entryPath(vault, id)!;
      writeFileSync(join(dir, `part-${n + 1}.png.tmp`), shot.png);
      renameRetry(join(dir, `part-${n + 1}.png.tmp`), join(dir, `part-${n + 1}.png`));
      p.snapshot = `part-${n + 1}.png`;
      if (shot.h) (p as any).h = shot.h;
      writeEntry(vault, e);
      ctx.emit?.({ type: "inbox", id, status: e.status, title: e.title, snapshot: true, ...(e.making && !e.failed ? { making: true } : {}), parts: e.parts.length });
    });
  });
}

/** A part's checks' timing: each phase is one line with the entry id and the part's number. */
type Tm = { ctx: InboxCtx; rec: Record<string, unknown> };
const phase = <T>(tm: Tm | undefined, name: string, f: () => Promise<T> | T): Promise<T> => (tm ? timed(tm.ctx, name, tm.rec, f) : Promise.resolve().then(f));

/** A checked part, its files, and (math) the typeset html whose snapshot is taken after the entry lands. */
type Checked = { part: Part; files: { name: string; data: Buffer | string }[]; snapshot?: string } | string;

async function checkPart(vault: string, p: any, n: number, tm?: Tm): Promise<Checked> {
  if (!p || typeof p !== "object") return "not a part";
  const base: { label?: string; width?: number } = {};
  if (p.label !== undefined) base.label = oneLine(p.label, 80);
  if (p.width !== undefined) {
    const w = Number(p.width);
    if (!Number.isFinite(w) || w < 20 || w > 20000) return "width: canvas units, 20–20000";
    base.width = w;
  }
  switch (p.kind) {
    case "pdf":
      return checkPdf(vault, p, base, tm);
    case "math":
      return checkMath(p, base, n, tm);
    case "image":
      return checkImage(vault, p, base, tm);
    case "widget":
      return checkWidget(vault, p, base, n, tm);
    default:
      return `kind: one of pdf, math, image, widget (got ${JSON.stringify(p.kind ?? null)?.slice(0, 40)})`;
  }
}

async function vaultFile(vault: string, p: unknown): Promise<{ abs: string; rel: string } | string> {
  if (typeof p !== "string" || !p.trim()) return "path: a file in the vault is required";
  let r: { abs: string; rel: string };
  try {
    r = await voicePath(vault, p, "read");
  } catch (e) {
    return `path: ${String(e).replace(/^Refused: /, "")}`;
  }
  try {
    if (!statSync(r.abs).isFile()) return `path: ${r.rel} is not a file`;
  } catch {
    return `path: ${r.rel} does not exist`;
  }
  return r;
}

async function pdfDoc(data: Uint8Array): Promise<any> {
  const pdfjs: any = await import("pdfjs-dist");
  return pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
}

async function checkPdf(vault: string, p: any, base: object, tm?: Tm): Promise<Checked> {
  const f = await phase(tm, "read", () => vaultFile(vault, p.path));
  if (typeof f === "string") return f;
  if (extname(f.rel).toLowerCase() !== ".pdf") return `path: ${f.rel} is not a .pdf`;
  const pages = parsePages(p.pages);
  if (typeof pages === "string") return pages;
  let count = 0;
  try {
    count = await phase(tm, "pdf", async () => {
      const doc = await pdfDoc(new Uint8Array(readFileSync(f.abs)));
      const n = doc.numPages as number;
      await doc.destroy?.();
      return n;
    });
  } catch (e) {
    return `path: ${f.rel} is not a readable PDF (${(e as Error).message})`;
  }
  const out = pages.filter((x) => x > count);
  if (out.length) return `pages: ${out.join(", ")} ${out.length > 1 ? "are" : "is"} out of range — ${f.rel} has ${count} page${count === 1 ? "" : "s"}`;
  return { part: { kind: "pdf", ...base, path: f.rel, pages }, files: [] };
}

// ---- math

/** KaTeX's message for each formula that does not compile (none: []). Exported for the tests. */
export async function mathErrors(markdown: string): Promise<string[]> {
  const [{ unified }, { default: remarkParse }, { default: remarkGfm }, { default: remarkMath }, katex, { prepareMarkdown }] = await Promise.all([
    import("unified"),
    import("remark-parse"),
    import("remark-gfm"),
    import("remark-math"),
    import("katex"),
    import("../src/mdPipeline"),
  ]);
  const tree: any = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath).parse(prepareMarkdown(markdown));
  const errs: string[] = [];
  const bare = new Set<string>();
  const walk = (node: any) => {
    // TeX written outside $…$ would show as raw TeX: refused, so every formula on the board is typeset.
    if (node.type === "text") for (const m of String(node.value).matchAll(BARE_TEX)) bare.add(m[0]);
    if (node.type === "math" || node.type === "inlineMath") {
      try {
        (katex as any).default.renderToString(node.value, { displayMode: node.type === "math", throwOnError: true, strict: "ignore", trust: false });
      } catch (e) {
        const msg = String((e as Error).message ?? e).replace(/^KaTeX parse error: /, "");
        errs.push(`KaTeX: ${msg} in ${node.type === "math" ? "$$" : "$"}${String(node.value).slice(0, 80)}${node.type === "math" ? "$$" : "$"}`);
      }
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(tree);
  if (bare.size) errs.push(`TeX outside math (${[...bare].slice(0, 3).join(", ")}) would show raw: wrap each formula in $…$ (inline) or $$…$$ (display)`);
  return errs;
}

/** TeX in plain text: a control word (\frac, \alpha), or a braced sub/superscript (x_{n}, e^{x}). */
const BARE_TEX = /\\[A-Za-z]{2,}|[_^]\{/g;

/**
 * TeX in a widget's strings (in its source "\\frac", "$\\gamma$", or String.raw`\frac`) would show raw — a widget
 * has no typesetter. The common commands only, so a regex or a path in a string does not trip it.
 */
const WIDGET_TEX = /\\{1,2}(?:frac|dfrac|sum|prod|int|sqrt|alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|theta|lambda|mu|sigma|Sigma|pi|infty|leq?|geq?|neq|cdot|times|mathbb|mathcal|mathbf|mathrm|left|right|lVert|rVert|partial|nabla|max|min|lim|operatorname|text)(?![A-Za-z])/;

/** The markdown typeset as everywhere else in vault-chat (the chat profile: GFM, math, safe HTML). */
export async function typesetMath(markdown: string): Promise<string> {
  const [{ createElement }, { renderToStaticMarkup }, { default: ReactMarkdown }, md] = await Promise.all([
    import("react"),
    import("react-dom/server"),
    import("react-markdown"),
    import("../src/mdPipeline"),
  ]);
  const { remarkPlugins, rehypePlugins } = md.pluginsFor("chat");
  return renderToStaticMarkup(createElement(ReactMarkdown as any, { remarkPlugins, rehypePlugins, urlTransform: md.markdownUrlTransform }, md.prepareMarkdown(markdown)));
}

async function checkMath(p: any, base: object, n: number, tm?: Tm): Promise<Checked> {
  const markdown = typeof p.markdown === "string" ? p.markdown : "";
  if (!markdown.trim()) return "markdown: the text is required";
  if (markdown.length > MAX_MATH_CHARS) return `markdown: at most ${MAX_MATH_CHARS} characters per part`;
  const errs = await phase(tm, "katex", () => mathErrors(markdown));
  if (errs.length) return errs.join("; ");
  const html = await phase(tm, "typeset", () => typesetMath(markdown));
  // Its snapshot (for the agent and the board's overview) is taken after the entry lands (snapshotsAfter).
  return { part: { kind: "math", ...base, markdown, html: `part-${n + 1}.html` }, files: [{ name: `part-${n + 1}.html`, data: html }], snapshot: html };
}

/** The typeset math's PNG and height (css px), or null (no browser, or it did not render). Cached by its html. */
async function mathSnapshot(html: string): Promise<{ png: Buffer; h: number | undefined } | null> {
  if (!findBrowser()) return null;
  const k = sha(html);
  const hit = cacheGet(shotCache, k);
  if (hit) return hit;
  const r = await headless(mathDocument(html, katexCss(), MATH_LAYOUT_W), { w: MATH_LAYOUT_W, h: 200, shot: (v) => Math.max(40, Math.min(4000, Number(json(v)?.h) || 0)) || null });
  if (!r.png) return null;
  const out = { png: r.png, h: Number(json(r.verdict)?.h) || undefined };
  cacheSet(shotCache, k, out);
  return out;
}

// Small caches, so a send the agent repeats after fixing one part (or a make that resends) redoes nothing it did.
const CACHE_MAX = 64;
const shotCache = new Map<string, { png: Buffer; h: number | undefined }>();
const mountCache = new Map<string, { error: null; png: Buffer | null }>();
const bundleCache = new Map<string, { inputs: [string, string][]; js: string }>();
const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
function cacheGet<V>(m: Map<string, V>, k: string): V | undefined {
  const v = m.get(k);
  if (v !== undefined) {
    m.delete(k);
    m.set(k, v);
  }
  return v;
}
function cacheSet<V>(m: Map<string, V>, k: string, v: V): void {
  m.set(k, v);
  while (m.size > CACHE_MAX) m.delete(m.keys().next().value!);
}

// ---- image

/** WebP's pixel size (VP8, VP8L, VP8X), or null. */
function webpSize(b: Buffer): { w: number; h: number } | null {
  if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return null;
  const c = b.toString("ascii", 12, 16);
  if (c === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  if (c === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (c === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  return null;
}

/** An SVG's size from width/height or its viewBox, and why it may not be shown (or null). */
export function svgCheck(text: string): { w: number; h: number } | string {
  const head = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!head) return "not an SVG (no <svg> element)";
  if (/<script\b/i.test(text)) return "the SVG has a <script>; send a plain drawing";
  if (/<foreignObject\b/i.test(text)) return "the SVG has <foreignObject>; send a plain drawing";
  if (/\son[a-z]+\s*=/i.test(text)) return "the SVG has event handlers (on…=); send a plain drawing";
  if (/(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|javascript:)/i.test(text) || /url\(\s*["']?\s*(?:https?:|\/\/)/i.test(text)) return "the SVG references outside files; everything must be inside it";
  const num = (re: RegExp) => {
    const m = re.exec(head);
    return m && !/%/.test(m[1]!) ? parseFloat(m[1]!) : NaN;
  };
  let w = num(/\swidth\s*=\s*["']\s*([\d.]+[a-z%]*)/i), h = num(/\sheight\s*=\s*["']\s*([\d.]+[a-z%]*)/i);
  const vb = /viewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)/i.exec(head);
  if (!(w > 0 && h > 0) && vb) {
    const vw = parseFloat(vb[3]!), vh = parseFloat(vb[4]!);
    if (w > 0) h = (w * vh) / vw;
    else if (h > 0) w = (h * vw) / vh;
    else (w = vw), (h = vh);
  }
  if (!(w > 0 && h > 0)) return "the SVG has no size: give it a viewBox (or width and height)";
  return { w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10 };
}

async function checkImage(vault: string, p: any, base: object, tm?: Tm): Promise<Checked> {
  const alt = oneLine(p.alt, 300);
  const f = await phase(tm, "read", () => vaultFile(vault, p.path));
  if (typeof f === "string") return f;
  if (!alt) return "alt: one line saying what it shows is required";
  const ext = extname(f.rel).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(ext)) return `path: ${f.rel} is not a PNG, JPEG, WebP or SVG`;
  const size = statSync(f.abs).size;
  if (size > MAX_IMAGE_BYTES) return `${f.rel} is ${(size / 1048576).toFixed(1)} MB; the limit is 20 MB`;
  const buf = await phase(tm, "readImage", () => readFileSync(f.abs));
  let dim: { w: number; h: number } | null;
  if (ext === ".svg") {
    const r = svgCheck(buf.toString("utf8"));
    if (typeof r === "string") return `${f.rel}: ${r}`;
    dim = r;
  } else {
    dim = ext === ".webp" ? webpSize(buf) : imageSize(buf);
    if (!dim) return `${f.rel} is not a readable ${ext.slice(1).toUpperCase()}`;
    if (Math.max(dim.w, dim.h) > MAX_IMAGE_SIDE) return `${f.rel} is ${dim.w}×${dim.h}; bitmaps are at most ${MAX_IMAGE_SIDE} px on the long side`;
  }
  return { part: { kind: "image", ...base, path: f.rel, alt, w: dim.w, h: dim.h }, files: [] };
}

// ---- widget

const ESBUILD_PIN = "0.27.7";
let esbuildP: Promise<any> | null = null;

/** esbuild: the repo's (dev, tests), else a pinned copy npm installs into the state dir on first use (like pi). */
export function loadEsbuild(stateDir?: string): Promise<any> {
  return (esbuildP ??= (async () => {
    const tryDir = (d: string) => {
      try {
        return createRequire(join(d, "noop.js"))("esbuild");
      } catch {
        return null;
      }
    };
    for (const d of [process.env.VC_ESBUILD_DIR, process.cwd(), dirname(process.argv[1] ?? "")].filter(Boolean) as string[]) {
      const m = tryDir(d);
      if (m) return m;
    }
    const dir = join(stateDir ?? process.env.VC_STATE_DIR ?? join(process.env.HOME ?? ".", ".local", "state", "vault-chat-server"), "esbuild", ESBUILD_PIN);
    const have = tryDir(dir);
    if (have) return have;
    mkdirSync(dir, { recursive: true });
    await new Promise<void>((res, rej) => {
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      const p = spawn(npm, ["install", "--prefix", dir, "--no-audit", "--no-fund", "--no-save", `esbuild@${ESBUILD_PIN}`], { windowsHide: true, shell: process.platform === "win32" });
      let err = "";
      p.stderr?.on("data", (d) => (err += d));
      p.on("error", rej);
      p.on("close", (c) => (c === 0 ? res() : rej(new Error(`npm could not install esbuild@${ESBUILD_PIN}: ${err.trim().split("\n").pop()}`))));
    });
    const m = tryDir(dir);
    if (!m) throw new Error(`esbuild@${ESBUILD_PIN} is not loadable from ${dir}`);
    return m;
  })().catch((e) => {
    esbuildP = null;
    throw e;
  }));
}

/** The files a cached bundle was built from still say what they said. */
function sameInputs(inputs: [string, string][]): boolean {
  try {
    return inputs.every(([f, h]) => sha(readFileSync(f)) === h);
  } catch {
    return false;
  }
}

/**
 * The widget module bundled for the page (an IIFE exporting into __vcWidget), or esbuild's reasons. Cached: a
 * module whose files (it and what it imports) are unchanged is not bundled again.
 */
export async function bundleWidget(abs: string, stateDir?: string): Promise<{ js: string } | { error: string }> {
  const hit = cacheGet(bundleCache, abs);
  if (hit && sameInputs(hit.inputs)) return { js: hit.js };
  const esbuild = await loadEsbuild(stateDir);
  try {
    const r = await esbuild.build({
      metafile: true,
      entryPoints: [abs],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "__vcWidget",
      platform: "browser",
      target: "es2020",
      logLevel: "silent",
      charset: "utf8",
      legalComments: "none",
    });
    const js = r.outputFiles?.[0]?.text ?? "";
    if (js.length > MAX_WIDGET_BYTES * 4) return { error: `the bundle is ${Math.round(js.length / 1024)} KB; keep a widget small (no large libraries)` };
    // Its inputs (paths relative to esbuild's working directory) and their hashes: the cache's check.
    const inputs: [string, string][] = [];
    for (const f of Object.keys(r.metafile?.inputs ?? {})) {
      try {
        const a = resolve(f);
        inputs.push([a, sha(readFileSync(a))]);
      } catch {
        /* a virtual input */
      }
    }
    if (inputs.length) cacheSet(bundleCache, abs, { inputs, js });
    return { js };
  } catch (e: any) {
    const errs: any[] = e?.errors ?? [];
    return { error: errs.length ? errs.slice(0, 3).map((x) => `${x.text}${x.location ? ` (${x.location.file.split(/[\\/]/).pop()}:${x.location.line}:${x.location.column})` : ""}`).join("; ") : String(e?.message ?? e) };
  }
}

/** Mount the bundled widget headless: "ok" or what it threw, and its snapshot. */
export async function checkWidgetMount(js: string, layout: { w: number; h: number }): Promise<{ error: string | null; png: Buffer | null }> {
  // A bundle that mounted cleanly at this size mounts the same way again (only a pass is remembered).
  const k = `${sha(js)}:${layout.w}x${layout.h}`;
  const hit = cacheGet(mountCache, k);
  if (hit) return hit;
  const r = await headless(widgetDocument(js, layout), { w: layout.w, h: layout.h, budgetMs: 1500 });
  if (r.verdict === null) return { error: "the page never reported (the bundle did not run)", png: r.png };
  if (r.verdict === "ok") cacheSet(mountCache, k, { error: null, png: r.png });
  return { error: r.verdict === "ok" ? null : r.verdict.split("\n").slice(0, 4).join(" | ").slice(0, 600), png: r.png };
}

async function checkWidget(vault: string, p: any, base: object, n: number, tm?: Tm): Promise<Checked> {
  const alt = oneLine(p.alt, 300);
  const f = await phase(tm, "read", () => vaultFile(vault, p.path));
  if (typeof f === "string") return f;
  if (!alt) return "alt: one line saying what it shows is required";
  if (![".ts", ".js", ".mts", ".mjs"].includes(extname(f.rel).toLowerCase())) return `path: ${f.rel} is not a TypeScript (or JavaScript) module`;
  if (statSync(f.abs).size > MAX_WIDGET_BYTES) return `${f.rel} is larger than ${MAX_WIDGET_BYTES / 1024} KB`;
  let layout = { ...WIDGET_LAYOUT };
  if (p.layout !== undefined) {
    const w = Number(p.layout?.w), h = Number(p.layout?.h);
    if (!(w >= 120 && w <= 2000 && h >= 80 && h <= 2000)) return "layout: {w, h} in css px, 120–2000 × 80–2000";
    layout = { w: Math.round(w), h: Math.round(h) };
  }
  const tex = WIDGET_TEX.exec(readFileSync(f.abs, "utf8"));
  if (tex) return `${f.rel} writes TeX (${tex[0].replace(/^\\+/, "\\")}) that a widget would show raw: use Unicode (γ, ‖V‖∞, Vₖ₊₁, ≤) in the widget, or send the formula as a math part beside it`;
  const b = await phase(tm, "bundle", () => bundleWidget(f.abs));
  if ("error" in b) return `it does not build: ${b.error}`;
  if (!findBrowser()) return "widgets can't be checked: there is no headless browser on the box (install Chromium or set VC_HEADLESS_BROWSER)";
  const m = await phase(tm, "mount", () => checkWidgetMount(b.js, layout));
  if (m.error) return `it throws on mount: ${m.error}`;
  const files: { name: string; data: Buffer | string }[] = [{ name: `part-${n + 1}.widget.js`, data: b.js }];
  const part: Part = { kind: "widget", ...base, path: f.rel, alt, layout, bundle: `part-${n + 1}.widget.js` };
  if (m.png) {
    files.push({ name: `part-${n + 1}.png`, data: m.png });
    part.snapshot = `part-${n + 1}.png`;
  }
  return { part, files };
}

// ---------------------------------------------------------------- the files the app reads

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".html": "text/plain; charset=utf-8",
  ".js": "text/plain; charset=utf-8",
};
/** Nothing served from the inbox or a board's assets runs on the box's origin. */
export const INERT = { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox", "X-Content-Type-Options": "nosniff" };

/** GET …/inbox/<id>/part/<n>[/<what>]: the part's file (pdf, image), `html` (math), `bundle` (widget), `snapshot`. */
export async function partFile(vault: string, id: string, n: number, what: string | undefined): Promise<Out> {
  const e = readEntry(vault, id);
  const p = e?.parts[n];
  if (!e || !p) return { status: 404, body: { error: "not found" } };
  let abs: string | null = null;
  try {
    if (!what && (p.kind === "pdf" || p.kind === "image")) abs = (await voicePath(vault, p.path, "read")).abs;
    else if (what === "html" && p.kind === "math" && p.html) abs = join(entryPath(vault, id)!, p.html);
    else if (what === "bundle" && p.kind === "widget" && p.bundle) abs = join(entryPath(vault, id)!, p.bundle);
    else if (what === "snapshot" && (p.kind === "math" || p.kind === "widget") && p.snapshot) abs = join(entryPath(vault, id)!, p.snapshot);
  } catch {
    abs = null;
  }
  if (!abs) return { status: 404, body: { error: "not found" } };
  try {
    return { status: 200, body: null, file: readFileSync(abs), mime: MIME[extname(abs).toLowerCase()] ?? "application/octet-stream", headers: INERT };
  } catch {
    return { status: 404, body: { error: "not found" } };
  }
}

// ---------------------------------------------------------------- add to board

/** An item for the app to place: size in the part's own units (lw × lh), the rest is the item. */
export type ItemTemplate = Record<string, unknown> & { kind: string; src: string; lw: number; lh: number; label?: string; inbox: { id: string; part: number } };

function copyAsset(boardFolder: string, data: Buffer, ext: string): string {
  const name = `${createHash("sha256").update(data).digest("hex").slice(0, 20)}${ext}`;
  const dir = join(boardFolder, ASSETS_DIR);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  if (!existsSync(f)) {
    writeFileSync(`${f}.tmp`, data);
    renameRetry(`${f}.tmp`, f);
  }
  return `${ASSETS_DIR}/${name}`;
}

/** POST /api/v1/boards/<slug>/from-inbox {id, part?}: the part's (or every part's) files into the board, its items back. */
export async function addToBoard(vault: string, slug: string, b: any): Promise<Out> {
  const folder = boardDir(vault, slug);
  if (!folder) return { status: 404, body: { error: "no such board" } };
  const e = readEntry(vault, String(b?.id ?? ""));
  if (!e) return { status: 404, body: { error: "no such inbox entry" } };
  const which = b?.part === undefined || b?.part === null ? e.parts.map((_, i) => i) : [Number(b.part)];
  if (which.some((i) => !Number.isInteger(i) || i < 0 || i >= e.parts.length)) return { status: 400, body: { error: "part: an index of this entry's parts" } };
  const edir = entryPath(vault, e.id)!;
  const items: ItemTemplate[] = [];
  for (const i of which) {
    const p = e.parts[i]!;
    const common = { inbox: { id: e.id, part: i }, ...(p.label ? { label: p.label } : {}), ...(p.width ? { width: p.width } : {}) };
    if (p.kind === "pdf") {
      const data = readFileSync((await voicePath(vault, p.path, "read")).abs);
      const src = copyAsset(folder, data, ".pdf");
      const doc = await pdfDoc(new Uint8Array(data));
      for (const pg of p.pages) {
        const vp = (await doc.getPage(pg)).getViewport({ scale: 1 });
        items.push({ kind: "pdf", src, page: pg, lw: Math.round(vp.width * 10) / 10, lh: Math.round(vp.height * 10) / 10, ...common, label: p.label ? `${p.label} · p. ${pg}` : `p. ${pg}` });
      }
      await doc.destroy?.();
    } else if (p.kind === "image") {
      const abs = (await voicePath(vault, p.path, "read")).abs;
      const src = copyAsset(folder, readFileSync(abs), extname(abs).toLowerCase().replace(".jpeg", ".jpg"));
      items.push({ kind: "image", src, lw: p.w ?? 1000, lh: p.h ?? 750, alt: p.alt, ...common });
    } else if (p.kind === "math") {
      const src = copyAsset(folder, readFileSync(join(edir, p.html!)), ".html");
      const snap = p.snapshot && existsSync(join(edir, p.snapshot)) ? copyAsset(folder, readFileSync(join(edir, p.snapshot)), ".png") : undefined;
      items.push({ kind: "math", src, lw: MATH_LAYOUT_W, lh: (p as any).h ?? 0, ...(snap ? { snap } : {}), ...common });
    } else if (p.kind === "widget") {
      const src = copyAsset(folder, readFileSync(join(edir, p.bundle!)), ".js");
      const snap = p.snapshot && existsSync(join(edir, p.snapshot)) ? copyAsset(folder, readFileSync(join(edir, p.snapshot)), ".png") : undefined;
      const lay = p.layout ?? WIDGET_LAYOUT;
      items.push({ kind: "widget", src, lw: lay.w, lh: lay.h, alt: p.alt, ...(snap ? { snap } : {}), ...common });
    }
  }
  return { status: 200, body: { items } };
}

// ---------------------------------------------------------------- helpers

function oneLine(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function json(s: string | null): any {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/** `2026-10-16-cauchy-sequences-problem-set`, made unique. */
function newId(vault: string, title: string): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const base = `${day}-${slugify(title).slice(0, 48).replace(/-+$/, "")}`;
  const root = inboxRoot(vault);
  let id = base;
  for (let i = 2; existsSync(join(root, id)); i++) id = `${base}-${i}`;
  return id;
}
