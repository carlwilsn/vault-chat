// The shared context stream, laptop side (src/activityCore.ts has the shape,
// the caps and the summary; server/activity.ts is the box's half).
//
// Writing: recordActivity() — box mode posts to the box's log for this vault
// (POST /api/v1/activity?vault=); otherwise it appends to this vault's own
// .vault-chat/local/activity.jsonl. Queued and batched, never awaited by the
// UI, failure-silent (logged). Off with localStorage `vault_chat_activity` = "0".
//
// Reading: sharedContextFor() — the recent-activity block and the project's
// memory/rules for Ctrl+K and Ctrl+L (box mode: GET /api/v1/activity/summary;
// otherwise built here from the same files).
//
// Watching: startActivityWatch() turns what the editor already knows (the
// file open, the PDF page, a selection, a marquee capture) into `focus` and
// `capture` entries, coalesced.
import { invoke } from "@tauri-apps/api/core";
import { boxGet, boxLinkFor, boxPost, type Link } from "./boxChat";
import { PROJECTS_DIR } from "./agentProjects";
import {
  ACTIVITY_DIR,
  ACTIVITY_LOG,
  ACTIVITY_LOG_OLD,
  CAPTURES_DIR,
  CONTEXT_IMAGE_MAX_BYTES,
  appendToLog,
  captureCaption,
  parseLog,
  pickContextImage,
  projectContextBlock,
  sanitizeEntry,
  summarizeActivity,
  type ActivityEntry,
  type ProjectFiles,
} from "./activityCore";
import { useStore } from "./store";

export const ACTIVITY_SWITCH = "vault_chat_activity";

/** Writing is on unless the switch says "0". */
export function activityEnabled(): boolean {
  try {
    return localStorage.getItem(ACTIVITY_SWITCH) !== "0";
  } catch {
    return true;
  }
}

function headless(): boolean {
  return !!(globalThis as { __VC_HEADLESS__?: unknown }).__VC_HEADLESS__;
}

export type ActivityInput = Omit<ActivityEntry, "ts" | "modality" | "image"> & {
  modality?: ActivityEntry["modality"];
  /** A captured image (data URL): stored under .vault-chat/local/captures/, referenced by path. */
  imageDataUrl?: string;
};

const join = (vault: string, rel: string) => `${vault.replace(/[\\/]+$/, "")}/${rel}`;

// ---------------------------------------------------------------- writing

type Pending = { vault: string; input: ActivityInput; at: number };
let queue: Pending[] = [];
let flushing: Promise<void> | null = null;

/** Record one entry. Returns at once; the write happens in the background. */
export function recordActivity(vault: string | null | undefined, input: ActivityInput): void {
  if (!vault || headless() || !activityEnabled()) return;
  queue.push({ vault, input, at: Date.now() });
  if (!flushing) flushing = Promise.resolve().then(flushLoop);
}

/** Wait until everything recorded so far is written (tests, the app closing). */
export async function flushActivity(): Promise<void> {
  while (flushing) await flushing;
}

async function flushLoop(): Promise<void> {
  try {
    while (queue.length) {
      const batch = queue;
      queue = [];
      const byVault = new Map<string, Pending[]>();
      for (const p of batch) byVault.set(p.vault, [...(byVault.get(p.vault) ?? []), p]);
      for (const [vault, items] of byVault) {
        try {
          await writeBatch(vault, items);
        } catch (e) {
          console.warn("[activity] write failed:", e);
        }
      }
    }
  } finally {
    flushing = null;
  }
}

function splitDataUrl(u: string): { b64: string; mime: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(u);
  return m ? { mime: m[1]!, b64: m[2]! } : null;
}

async function writeBatch(vault: string, items: Pending[]): Promise<void> {
  // A capture goes into the stream downscaled (a later request may send it to a model).
  for (const p of items) if (p.input.imageDataUrl) p.input = { ...p.input, imageDataUrl: await fitCapture(p.input.imageDataUrl) };
  const link = await boxLinkFor(vault).catch(() => null);
  if (link) {
    for (const p of items) await postOne(link, p.input);
    return;
  }
  // This vault's own log: one read, one write per batch.
  const log = join(vault, ACTIVITY_LOG);
  let text = "";
  try {
    text = await invoke<string>("read_text_file", { path: log });
  } catch {
    text = "";
    await invoke("write_text_file", { path: join(vault, `${ACTIVITY_DIR}/.gitignore`), contents: "*\n" }).catch(() => undefined);
  }
  for (const p of items) {
    const { imageDataUrl, ...raw } = p.input;
    const entry = sanitizeEntry({ ...raw, image: imageDataUrl ? await saveLocalCapture(vault, imageDataUrl) : undefined }, p.at);
    if (!entry) continue;
    const r = appendToLog(text, entry);
    if (r.rotated !== null) await invoke("write_text_file", { path: join(vault, ACTIVITY_LOG_OLD), contents: r.rotated });
    text = r.log;
  }
  await invoke("write_text_file", { path: log, contents: text });
}

/** Longest side of a stored capture. */
export const CAPTURE_MAX_SIDE = 1568;

/**
 * A capture made fit for a model request: at most CAPTURE_MAX_SIDE px on its
 * longest side and CONTEXT_IMAGE_MAX_BYTES (JPEG when it has to shrink).
 * Where the page cannot draw (node, tests) the original is kept.
 */
export async function fitCapture(dataUrl: string): Promise<string> {
  const g = globalThis as { createImageBitmap?: (b: Blob) => Promise<ImageBitmap>; OffscreenCanvas?: typeof OffscreenCanvas; FileReader?: typeof FileReader };
  const img = splitDataUrl(dataUrl);
  if (!img || !g.createImageBitmap || !g.OffscreenCanvas || !g.FileReader) return dataUrl;
  try {
    const bin = atob(img.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await g.createImageBitmap(new Blob([bytes], { type: img.mime }));
    const scale = Math.min(1, CAPTURE_MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && bytes.length <= CONTEXT_IMAGE_MAX_BYTES) return dataUrl;
    const c = new g.OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const Reader = g.FileReader;
    return await new Promise<string>((res, rej) => {
      const r = new Reader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  } catch {
    return dataUrl;
  }
}

async function postOne(link: Link, input: ActivityInput): Promise<void> {
  const { imageDataUrl, ...entry } = input;
  const img = imageDataUrl ? splitDataUrl(imageDataUrl) : null;
  const r = await boxPost(link, "/api/v1/activity", { entry, ...(img ? { imageBase64: img.b64, imageMime: img.mime } : {}) });
  if (!r.ok) console.warn("[activity] the box did not take an entry:", r.error);
}

async function saveLocalCapture(vault: string, dataUrl: string): Promise<string | undefined> {
  const img = splitDataUrl(dataUrl);
  if (!img) return undefined;
  try {
    const bin = atob(img.b64);
    if (bin.length > 8 * 1024 * 1024) return undefined;
    const bytes = new Array<number>(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = img.mime.includes("jpeg") || img.mime.includes("jpg") ? "jpg" : img.mime.includes("webp") ? "webp" : "png";
    const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const abs = await invoke<string>("write_binary_file_unique", { dir: join(vault, CAPTURES_DIR), name, bytes });
    const norm = abs.replace(/\\/g, "/");
    const i = norm.indexOf(`/${CAPTURES_DIR}/`);
    return i >= 0 ? norm.slice(i + 1) : `${CAPTURES_DIR}/${name}`;
  } catch (e) {
    console.warn("[activity] capture save failed:", e);
    return undefined;
  }
}

// ---------------------------------------------------------------- reading

export type SharedContext = { activity: string; project: string };

/** The project of the conversation Carl is in, if any. */
export function currentProject(): string | null {
  const s = useStore.getState();
  const c = s.conversations.find((x) => x.id === s.activeConversationId);
  return c && typeof c.project === "string" && c.project ? c.project : null;
}

/**
 * The recent-activity block and the project's memory and rules, for a small
 * surface (Ctrl+K, Ctrl+L, local voice). Never throws; "" parts on failure.
 * Box mode asks the box (the log is there); `timeoutMs` keeps it off the
 * critical path.
 */
export async function sharedContextFor(
  vault: string | null | undefined,
  project: string | null = currentProject(),
  timeoutMs = 2500,
  /** Leave out this chat's exchange (the surface carries its transcript already). */
  excludeConv: string | null = null,
): Promise<SharedContext> {
  const none = { activity: "", project: "" };
  if (!vault) return none;
  await flushActivity().catch(() => undefined);
  try {
    const link = await boxLinkFor(vault).catch(() => null);
    if (link) {
      const q = [project ? `project=${encodeURIComponent(project)}` : "", excludeConv ? `exclude=${encodeURIComponent(excludeConv)}` : ""].filter(Boolean).join("&");
      const r = await boxGet(link, `/api/v1/activity/summary${q ? `?${q}` : ""}`, timeoutMs);
      return { activity: typeof r?.activity === "string" ? r.activity : "", project: typeof r?.project === "string" ? r.project : "" };
    }
    return { activity: await localSummary(vault, project, Date.now(), excludeConv), project: await localProjectContext(vault, project) };
  } catch (e) {
    console.warn("[activity] shared context unavailable:", e);
    return none;
  }
}

async function readOr(path: string): Promise<string> {
  try {
    return await invoke<string>("read_text_file", { path });
  } catch {
    return "";
  }
}

export async function localSummary(vault: string, project: string | null, now = Date.now(), excludeConv: string | null = null): Promise<string> {
  return summarizeActivity(await localEntries(vault), { now, project, excludeConv });
}

async function localEntries(vault: string): Promise<ActivityEntry[]> {
  return parseLog((await readOr(join(vault, ACTIVITY_LOG_OLD))) + "\n" + (await readOr(join(vault, ACTIVITY_LOG))));
}

/** The capture a request refers to, as data for an image part. */
export type ContextImageData = { path: string; dataUrl: string; caption: string; sourcePath?: string; sourceAnchor?: string };

/**
 * The latest capture, when this request is about it ("this figure", "what I
 * circled"; with `deictic`, "this" within a few minutes of the capture) —
 * activityCore pickContextImage. Box mode asks the box (the captures are
 * there); otherwise this vault's own. One image, at most
 * CONTEXT_IMAGE_MAX_BYTES. null when there is none, it is too big, or
 * anything fails.
 */
export async function contextImageFor(
  vault: string | null | undefined,
  text: string,
  o: { deictic?: boolean; exclude?: string[] } = {},
): Promise<ContextImageData | null> {
  if (!vault || !text.trim()) return null;
  await flushActivity().catch(() => undefined);
  try {
    const link = await boxLinkFor(vault).catch(() => null);
    if (link) {
      const r = await boxPost(link, "/api/v1/activity/image", { text, deictic: !!o.deictic, exclude: o.exclude ?? [] });
      const im = r.ok ? (r.data?.image as { path?: string; mime?: string; dataBase64?: string; caption?: string } | null | undefined) : null;
      if (!im?.dataBase64 || !im.path || im.dataBase64.length * 0.75 > CONTEXT_IMAGE_MAX_BYTES) return null;
      return { path: im.path, dataUrl: `data:${im.mime ?? "image/png"};base64,${im.dataBase64}`, caption: String(im.caption ?? "") };
    }
    const now = Date.now();
    const e = pickContextImage(await localEntries(vault), text, { now, deictic: o.deictic, exclude: o.exclude });
    if (!e?.image) return null;
    const bytes = await invoke<number[]>("read_binary_file", { path: join(vault, e.image) });
    if (!bytes?.length || bytes.length > CONTEXT_IMAGE_MAX_BYTES) return null;
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.slice(i, i + 0x8000));
    const ext = (e.image.split(".").pop() ?? "png").toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
    return {
      path: e.image,
      dataUrl: `data:${mime};base64,${btoa(bin)}`,
      caption: captureCaption(e, now),
      ...(e.path ? { sourcePath: e.path } : {}),
      ...(e.where ? { sourceAnchor: e.where } : {}),
    };
  } catch (err) {
    console.warn("[activity] context image unavailable:", err);
    return null;
  }
}

async function localProjectContext(vault: string, project: string | null): Promise<string> {
  const rules = await readOr(join(vault, ".vault-chat/rules.md"));
  let p: ProjectFiles | null = null;
  if (project && /^[a-z0-9-]+$/.test(project)) {
    const f = (n: string) => readOr(join(vault, `${PROJECTS_DIR}/${project}/${n}.md`));
    const [proj, memory, plan, progress, prules] = await Promise.all([f("project"), f("memory"), f("plan"), f("progress"), f("rules")]);
    if (proj) {
      const name = /^#\s+(.+?)\s*$/m.exec(proj)?.[1] ?? project;
      p = { slug: project, name, project: proj, memory, plan, progress, rules: prules };
    }
  }
  return projectContextBlock(p, rules);
}

/** The shared context as one block for a system prompt ("" when empty). */
export function sharedContextText(c: SharedContext): string {
  return [c.project, c.activity].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------- watching the editor

const FOCUS_MIN_MS = 4000;
let stopWatch: (() => void) | null = null;

const rel = (vault: string, p: string) => {
  const v = vault.replace(/\\/g, "/").replace(/\/+$/, "");
  const n = p.replace(/\\/g, "/");
  return n.toLowerCase().startsWith(v.toLowerCase() + "/") ? n.slice(v.length + 1) : n;
};

/**
 * Turn the store's view of the editor into the stream: the file open and the
 * PDF page (`focus`, at most one per FOCUS_MIN_MS per file, the latest wins),
 * a selection held in an editor, and every marquee capture (`capture`, the
 * image stored). Idempotent; returns the stop function.
 */
export function startActivityWatch(): () => void {
  if (stopWatch) return stopWatch;
  let lastFocusKey = "";
  let lastFocusAt = 0;
  let pendingFocus: ReturnType<typeof setTimeout> | null = null;
  const seenCaptures = new WeakSet<object>();
  const recentImages: string[] = [];
  const focus = (vault: string, path: string, where: string | undefined, text: string) => {
    const key = `${path}|${where ?? ""}`;
    if (key === lastFocusKey) return;
    const fire = () => {
      pendingFocus = null;
      lastFocusKey = key;
      lastFocusAt = Date.now();
      recordActivity(vault, { kind: "focus", modality: "editor", path: rel(vault, path), ...(where ? { where } : {}), text, project: currentProject() ?? undefined });
    };
    if (pendingFocus) clearTimeout(pendingFocus);
    const wait = Math.max(0, FOCUS_MIN_MS - (Date.now() - lastFocusAt));
    if (wait === 0) fire();
    else pendingFocus = setTimeout(fire, wait);
  };
  const unsub = useStore.subscribe((s, prev) => {
    const vault = s.vaultPath;
    if (!vault) return;
    if (s.currentFile && s.currentFile !== prev.currentFile) focus(vault, s.currentFile, undefined, "opened the file");
    const vp = s.viewport;
    if (vp?.page && vp.path && (vp.page !== prev.viewport?.page || vp.path !== prev.viewport?.path)) {
      focus(vault, vp.path, `page ${vp.page}${vp.totalPages ? ` of ${vp.totalPages}` : ""}`, "reading");
    }
    const sel = s.editorSelection;
    if (sel && sel !== prev.editorSelection && sel.text && sel.text.trim().length >= 12) {
      focus(vault, sel.path, sel.lineStart ? `L${sel.lineStart}${sel.lineEnd && sel.lineEnd !== sel.lineStart ? `-L${sel.lineEnd}` : ""}` : "selection", `selected "${sel.text.trim().slice(0, 160)}"`);
    }
    for (const [cap, to] of [
      [s.chatPaneLastCapture, "for the chat"],
      [s.voiceLastCapture, "for voice"],
      [s.editPromptLastCapture, "for a Ctrl+K/Ctrl+L popover"],
      [s.lastCapture, ""],
    ] as const) {
      if (!cap || seenCaptures.has(cap) || !cap.imageDataUrl) continue;
      seenCaptures.add(cap);
      const path = "sourcePath" in cap ? cap.sourcePath : cap.path;
      const anchor = "sourceAnchor" in cap ? cap.sourceAnchor : cap.source_anchor;
      // One image, one entry: the same picture routed to a surface is the same capture.
      if (recentImages.includes(cap.imageDataUrl)) continue;
      recentImages.push(cap.imageDataUrl);
      if (recentImages.length > 8) recentImages.shift();
      recordActivity(vault, {
        kind: "capture",
        modality: "capture",
        text: `captured a region${to ? ` ${to}` : ""}`,
        ...(path ? { path: rel(vault, path) } : {}),
        ...(anchor ? { where: anchor.replace(/^page=/, "page ") } : {}),
        imageDataUrl: cap.imageDataUrl,
        project: currentProject() ?? undefined,
      });
    }
  });
  stopWatch = () => {
    unsub();
    if (pendingFocus) clearTimeout(pendingFocus);
    stopWatch = null;
  };
  return stopWatch;
}
