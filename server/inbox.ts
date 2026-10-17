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
// "Add to board" copies a part's files into the board's assets/ (named by
// their content, so a PDF added twice is stored once) and returns the items
// for the app to place. Every change pushes {type:"inbox"} on the /poll ring.
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
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
import { voicePath } from "./voice";
import { writeAtomic, renameRetry } from "./atomic";
import { findBrowser, headless } from "./headless";
import { katexCss } from "./katexCss";

export type InboxEvent = { type: "inbox"; id: string; status: string; title: string; landed?: boolean; failed?: string };
export type InboxCtx = { conversation?: string; stateDir?: string; emit?: (ev: InboxEvent) => void };

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
  ctx.emit?.({ type: "inbox", id: e.id, status: e.status, title: e.title });
  return e;
}

/** A make that ended without a send: "couldn't make: <reason>". No-op once it landed. */
export function failMake(vault: string, id: string, reason: string, ctx: InboxCtx = {}): boolean {
  const e = readEntry(vault, id);
  if (!e || !e.making || e.failed) return false;
  e.failed = oneLine(reason, 300) || "the make ended without sending anything";
  writeEntry(vault, e);
  ctx.emit?.({ type: "inbox", id, status: e.status, title: e.title, failed: e.failed });
  return true;
}

// ---------------------------------------------------------------- the validated send

export type SendResult = { ok: true; id: string; parts: number } | { ok: false; refusals: string[] };

/** The send: `{title, note?, parts, make?}` (`make`: the id of a "being made" entry this send fills). */
export async function sendEntry(vault: string, body: any, ctx: InboxCtx = {}): Promise<SendResult> {
  const refusals: string[] = [];
  const title = oneLine(body?.title, 120);
  if (!title) refusals.push("title: a one-line title is required");
  const note = oneLine(body?.note, 300);
  const raw: unknown[] = Array.isArray(body?.parts) ? body.parts : [];
  if (!raw.length) refusals.push("parts: at least one part is required");
  if (raw.length > MAX_PARTS) refusals.push(`parts: at most ${MAX_PARTS} per send`);
  let target: Entry | null = null;
  if (body?.make !== undefined) {
    target = typeof body.make === "string" ? readEntry(vault, body.make) : null;
    if (!target) refusals.push(`make: no entry ${String(body.make).slice(0, 80)} is being made`);
    else if (!target.making) refusals.push(`make: ${target.id} was already sent`);
  }
  if (refusals.length) return { ok: false, refusals };

  const id = target?.id ?? newId(vault, title);
  const dir = entryPath(vault, id)!;
  const files: { name: string; data: Buffer | string }[] = [];
  const parts: Part[] = [];
  for (let n = 0; n < raw.length && n < MAX_PARTS; n++) {
    const where = `part ${n + 1}`;
    try {
      const r = await checkPart(vault, raw[n], n, where);
      if (typeof r === "string") refusals.push(`${where}: ${r}`);
      else {
        parts.push(r.part);
        files.push(...r.files);
      }
    } catch (e) {
      refusals.push(`${where}: ${(e as Error)?.message ?? String(e)}`);
    }
  }
  if (refusals.length) return { ok: false, refusals };

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
    parts,
    status: "unread",
  };
  writeEntry(vault, e);
  ctx.emit?.({ type: "inbox", id, status: e.status, title, landed: true });
  return { ok: true, id, parts: parts.length };
}

type Checked = { part: Part; files: { name: string; data: Buffer | string }[] } | string;

async function checkPart(vault: string, p: any, n: number, where: string): Promise<Checked> {
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
      return checkPdf(vault, p, base);
    case "math":
      return checkMath(p, base, n);
    case "image":
      return checkImage(vault, p, base);
    case "widget":
      return checkWidget(vault, p, base, n);
    default:
      return `kind: one of pdf, math, image, widget (got ${JSON.stringify(p.kind ?? null)?.slice(0, 40)})`;
  }
  void where;
}

function vaultFile(vault: string, p: unknown): { abs: string; rel: string } | string {
  if (typeof p !== "string" || !p.trim()) return "path: a file in the vault is required";
  let r: { abs: string; rel: string };
  try {
    r = voicePath(vault, p, "read");
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

async function checkPdf(vault: string, p: any, base: object): Promise<Checked> {
  const f = vaultFile(vault, p.path);
  if (typeof f === "string") return f;
  if (extname(f.rel).toLowerCase() !== ".pdf") return `path: ${f.rel} is not a .pdf`;
  const pages = parsePages(p.pages);
  if (typeof pages === "string") return pages;
  let count = 0;
  try {
    const doc = await pdfDoc(new Uint8Array(readFileSync(f.abs)));
    count = doc.numPages;
    await doc.destroy?.();
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
  const walk = (node: any) => {
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
  return errs;
}

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

async function checkMath(p: any, base: object, n: number): Promise<Checked> {
  const markdown = typeof p.markdown === "string" ? p.markdown : "";
  if (!markdown.trim()) return "markdown: the text is required";
  if (markdown.length > MAX_MATH_CHARS) return `markdown: at most ${MAX_MATH_CHARS} characters per part`;
  const errs = await mathErrors(markdown);
  if (errs.length) return errs.join("; ");
  const html = await typesetMath(markdown);
  const files: { name: string; data: Buffer | string }[] = [{ name: `part-${n + 1}.html`, data: html }];
  const part: Part = { kind: "math", ...base, markdown, html: `part-${n + 1}.html` };
  // A snapshot for the agent and the board's overview, when the box has a browser.
  if (findBrowser()) {
    try {
      const r = await headless(mathDocument(html, katexCss(), MATH_LAYOUT_W), { w: MATH_LAYOUT_W, h: 200, shot: (v) => Math.max(40, Math.min(4000, Number(json(v)?.h) || 0)) || null });
      if (r.png) {
        files.push({ name: `part-${n + 1}.png`, data: r.png });
        (part as any).snapshot = `part-${n + 1}.png`;
        (part as any).h = Number(json(r.verdict)?.h) || undefined;
      }
    } catch {
      /* no snapshot: the overview shows the label */
    }
  }
  return { part, files };
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

async function checkImage(vault: string, p: any, base: object): Promise<Checked> {
  const alt = oneLine(p.alt, 300);
  const f = vaultFile(vault, p.path);
  if (typeof f === "string") return f;
  if (!alt) return "alt: one line saying what it shows is required";
  const ext = extname(f.rel).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(ext)) return `path: ${f.rel} is not a PNG, JPEG, WebP or SVG`;
  const size = statSync(f.abs).size;
  if (size > MAX_IMAGE_BYTES) return `${f.rel} is ${(size / 1048576).toFixed(1)} MB; the limit is 20 MB`;
  const buf = readFileSync(f.abs);
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

/** The widget module bundled for the page (an IIFE exporting into __vcWidget), or esbuild's reasons. */
export async function bundleWidget(abs: string, stateDir?: string): Promise<{ js: string } | { error: string }> {
  const esbuild = await loadEsbuild(stateDir);
  try {
    const r = await esbuild.build({
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
    return { js };
  } catch (e: any) {
    const errs: any[] = e?.errors ?? [];
    return { error: errs.length ? errs.slice(0, 3).map((x) => `${x.text}${x.location ? ` (${x.location.file.split(/[\\/]/).pop()}:${x.location.line}:${x.location.column})` : ""}`).join("; ") : String(e?.message ?? e) };
  }
}

/** Mount the bundled widget headless: "ok" or what it threw, and its snapshot. */
export async function checkWidgetMount(js: string, layout: { w: number; h: number }): Promise<{ error: string | null; png: Buffer | null }> {
  const r = await headless(widgetDocument(js, layout), { w: layout.w, h: layout.h, budgetMs: 1500 });
  if (r.verdict === null) return { error: "the page never reported (the bundle did not run)", png: r.png };
  return { error: r.verdict === "ok" ? null : r.verdict.split("\n").slice(0, 4).join(" | ").slice(0, 600), png: r.png };
}

async function checkWidget(vault: string, p: any, base: object, n: number): Promise<Checked> {
  const alt = oneLine(p.alt, 300);
  const f = vaultFile(vault, p.path);
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
  const b = await bundleWidget(f.abs);
  if ("error" in b) return `it does not build: ${b.error}`;
  if (!findBrowser()) return "widgets can't be checked: there is no headless browser on the box (install Chromium or set VC_HEADLESS_BROWSER)";
  const m = await checkWidgetMount(b.js, layout);
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
export function partFile(vault: string, id: string, n: number, what: string | undefined): Out {
  const e = readEntry(vault, id);
  const p = e?.parts[n];
  if (!e || !p) return { status: 404, body: { error: "not found" } };
  let abs: string | null = null;
  try {
    if (!what && (p.kind === "pdf" || p.kind === "image")) abs = voicePath(vault, p.path, "read").abs;
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
      const data = readFileSync(voicePath(vault, p.path, "read").abs);
      const src = copyAsset(folder, data, ".pdf");
      const doc = await pdfDoc(new Uint8Array(data));
      for (const pg of p.pages) {
        const vp = (await doc.getPage(pg)).getViewport({ scale: 1 });
        items.push({ kind: "pdf", src, page: pg, lw: Math.round(vp.width * 10) / 10, lh: Math.round(vp.height * 10) / 10, ...common, label: p.label ? `${p.label} · p. ${pg}` : `p. ${pg}` });
      }
      await doc.destroy?.();
    } else if (p.kind === "image") {
      const abs = voicePath(vault, p.path, "read").abs;
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
