// The composer's draft (src/plugins/composer): what Carl has typed, the vault files he @-mentioned, the pictures and
// files attached, the last attach error, and whether a send is under way. Module state (a small zustand store) rather
// than the component's own, so the composer on screen, its built-in fallback (src/ComposerPanel.tsx) and the agent's
// actions (./index.tsx offers) read and change the one draft; a swap between them (the plugin coming up on start,
// turned off, reloaded) keeps what he typed.
//
// The send itself (sendDraft) is the composer's old send, unchanged: @-references resolved, outside-vault paths read
// and uploaded, the viewport context, then the box's send intent through dispatchChatAction.
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useStore, type FileUpload } from "../../store";
import { attachPath, insideVault, pathMentions } from "../../attachFiles";
import { imageMime } from "../../imageMime";
import { filesLine } from "../../filesLine";
import { isUnreadableAsText } from "../../fileKind";
import { buildViewportContextText } from "../../viewportContext";
import { dispatchChatAction } from "../../sync";
import { aiBlockedNow, chatGateOf } from "../../chatGate";
import { scopedState } from "../../chatScope";

import { splitFilesLine } from "../../filesLine";
import { pickContext, type WebPick } from "../../webDrive";

export type PendingImage = { imageDataUrl: string; sourcePath?: string; sourceAnchor?: string | null; capturedFilePath?: string };
export type Mention = { rel: string; path: string; name: string; raw: string };
export type { MentionHit } from "./mentionMatch";

export type Draft = {
  input: string;
  mentions: Mention[];
  images: PendingImage[];
  files: FileUpload[];
  /** Elements selected on web pages (a pane's Select, or the agent's webPage select): chips, sent as context. */
  picks: WebPick[];
  attachError: string | null;
  /** Sends still resolving their files (the send intent not yet dispatched). */
  sending: number;
};

const EMPTY: Draft = { input: "", mentions: [], images: [], files: [], picks: [], attachError: null, sending: 0 };

type Up<T> = T | ((prev: T) => T);
const apply = <T>(u: Up<T>, prev: T): T => (typeof u === "function" ? (u as (p: T) => T)(prev) : u);

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A chip's name: what the composer shows and detach takes. */
export const pickName = (p: WebPick) => `${p.tag} · ${p.label}`;

// ---- what happened, for the plugin's events ----------------------------------------------------------------------
type Sent = { text: string; images: number; files: string[]; references: string[] };
type Attached = { name: string; kind: "image" | "file" | "reference" | "selection" };
const sentFns = new Set<(s: Sent) => void>();
const attachedFns = new Set<(a: Attached) => void>();
const detachedFns = new Set<(a: Attached) => void>();
export function onDraftEvent(on: { sent?: (s: Sent) => void; attached?: (a: Attached) => void; detached?: (a: Attached) => void }): () => void {
  if (on.sent) sentFns.add(on.sent);
  if (on.attached) attachedFns.add(on.attached);
  if (on.detached) detachedFns.add(on.detached);
  return () => {
    if (on.sent) sentFns.delete(on.sent);
    if (on.attached) attachedFns.delete(on.attached);
    if (on.detached) detachedFns.delete(on.detached);
  };
}
const told = <T>(fns: Set<(x: T) => void>, x: T) => {
  for (const f of [...fns]) {
    try {
      f(x);
    } catch {
      /* a listener's trouble is its own */
    }
  }
};

// ---- the thread's scroll, held while a pasted picture's row appears (the chat pane owns the scroll) ---------------
export const scrollHold: { hold: () => void; restore: () => boolean } = { hold: () => {}, restore: () => false };

// ---- the composer's focus across a swap (the in-tree composer while the records load, then the plugin's) ----------
export const focusHandoff = { at: 0 };

// The files Carl looked at lately, for the @ picker (./mentionMatch.ts): an empty @ lists them, a typed one ranks them
// higher. The app keeps no recent-files list of its own, so this is the files open in the viewer now (the active one
// first) and then the ones opened since the app started, newest first, plus what he @-picked. Laptop memory only.
const RECENT_MAX = 30;
let opened: string[] = [];
export function noteRecentFile(path: string | null | undefined): void {
  if (!path || /^https?:/i.test(path)) return;
  opened = [path, ...opened.filter((p) => p !== path)].slice(0, RECENT_MAX);
}
useStore.subscribe((s, prev) => {
  if (s.currentFile !== prev.currentFile) noteRecentFile(s.currentFile);
  if (s.vaultPath !== prev.vaultPath) opened = [];
});
noteRecentFile(useStore.getState().currentFile);
export function recentFiles(): string[] {
  const s = useStore.getState();
  const active = s.panes.find((p) => p.id === s.activePaneId)?.file ?? s.currentFile;
  const open = [active, ...s.panes.map((p) => p.file)].filter((p): p is string => !!p && !/^https?:/i.test(p));
  return [...new Set([...open, ...opened])];
}

// Build a context preamble out of attached mentions. Returns an empty
// string when there's nothing to attach. Unreadable-as-text files
// (images, pdfs, unsupported) are listed by path only so the agent knows
// to fetch them explicitly via Read / PdfExtract.
async function buildMentionPreamble(mentions: Array<{ rel: string; path: string; isDir?: boolean }>): Promise<string> {
  if (mentions.length === 0) return "";
  const blocks: string[] = [];
  for (const { rel, path, isDir } of mentions) {
    if (isDir) {
      blocks.push(`@${rel}/ — absolute path: ${path} (directory — use ListDir/Glob/Grep to inspect contents)`);
      continue;
    }
    if (isUnreadableAsText(path)) {
      const ext = (path.split(".").pop() ?? "").toLowerCase();
      blocks.push(`@${rel} — absolute path: ${path} (binary ${ext}, contents not inlined)`);
      continue;
    }
    try {
      const content = await invoke<string>("read_text_file", { path });
      blocks.push(`@${rel} — absolute path: ${path}\n\n${content}`);
    } catch (err) {
      blocks.push(`@${rel} — absolute path: ${path} (read failed: ${String(err)})`);
    }
  }
  const preamble = [
    "FILE ATTACHMENTS",
    "The user attached the following files with @-mentions. The absolute paths below are the ground truth — you already know where each file is. DO NOT run Glob, Grep, or any other tool to search for these files. If the user's question can be answered from the path or the inlined content, answer directly.",
    "",
    blocks.join("\n\n"),
  ].join("\n");
  // Names only: the app log captures console.info, and it never holds a file's contents.
  console.info(`[@ref] attaching ${mentions.length} file(s): ${mentions.map((m) => m.rel).join(", ")}`.slice(0, 300));
  return preamble;
}

// Persist a chat-pane capture's PNG bytes to disk so the agent can reference it from tools like `Write`. Returns the
// vault-relative path on success, or null on any failure (the data URL still goes with the message). Files land in
// `<vault>/.vault-chat/captures/`; an app-start sweep prunes old ones.
export async function saveCaptureToDisk(vault: string, imageDataUrl: string): Promise<string | null> {
  try {
    const m = imageDataUrl.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (!m) return null;
    const ext = m[1] === "jpeg" ? "jpg" : m[1].toLowerCase();
    const binary = atob(m[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // Timestamp + short random suffix so two near-simultaneous captures never collide.
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 19);
    const suffix = Math.random().toString(36).slice(2, 7);
    const name = `capture-${ts}-${suffix}.${ext}`;
    const absPath = await invoke<string>("write_binary_file_unique", { dir: `${vault}/.vault-chat/captures`, name, bytes: Array.from(bytes) });
    return absPath.startsWith(vault + "/") ? absPath.slice(vault.length + 1) : absPath;
  } catch (e) {
    console.warn("[capture] disk save failed:", e);
    return null;
  }
}

/** One draft and what changes it: the chat panel's (`convId` null: the active chat, below) or a chat tile's own
 *  (draftFor). Every composer, the panel's and each tile's, is the one Composer over one of these. */
function createDraft(convId: string | null) {
  const store = create<Draft>(() => ({ ...EMPTY }));
  const useDraft = store;
  /** The text, and any tracked mention whose @name is no longer in it dropped (he deleted it inline). A lookahead
   *  terminator so "@foo.pdf?" / "@foo.md," still count. */
  function setInput(u: Up<string>): void {
    const v = apply(u, store.getState().input);
    const mentions = store.getState().mentions;
    const kept = mentions.filter((m) => new RegExp(`(^|\\s)@${escapeRegExp(m.name)}(?![\\w./-])`).test(v));
    store.setState(kept.length === mentions.length ? { input: v } : { input: v, mentions: kept });
  }
  /** The text alone (a keystroke: the mentions are checked by the caller's onInputChange as before). */
  const setInputOnly = (v: string) => store.setState({ input: v });
  const setMentions = (u: Up<Mention[]>) => store.setState({ mentions: apply(u, store.getState().mentions) });
  const setImages = (u: Up<PendingImage[]>) => store.setState({ images: apply(u, store.getState().images) });
  const setFiles = (u: Up<FileUpload[]>) => store.setState({ files: apply(u, store.getState().files) });
  const setAttachError = (e: string | null) => store.setState({ attachError: e });
  const clearDraft = () => store.setState({ input: "", mentions: [], images: [], files: [], picks: [], attachError: null });
  const hasDraft = (d: Draft = store.getState()) => !!d.input.trim() || d.images.length > 0 || d.files.length > 0 || d.picks.length > 0;
  /** An element selected on a web page joins the draft as a chip (the same element again: once). Says `attached`. */
  function addPick(p: WebPick): void {
    if (!store.getState().picks.some((x) => x.url === p.url && x.ref === p.ref)) store.setState((d) => ({ picks: [...d.picks, p] }));
    told(attachedFns, { name: pickName(p), kind: "selection" });
  }

  /** Files read when attached (attachFiles.ts), into the draft; the failures are the attach error. */
  function addAttached(rs: Awaited<ReturnType<typeof attachPath>>[]): void {
    const ok = rs.flatMap((r) => (r.ok ? [r.file] : []));
    const bad = rs.flatMap((r) => (r.ok ? [] : [r.error]));
    if (ok.length) setFiles((prev) => [...prev, ...ok]);
    setAttachError(bad.length ? bad.join(" ") : null);
    if (bad.length) console.warn(`[attach] ${bad.join(" ")}`.slice(0, 300));
    for (const f of ok) told(attachedFns, { name: f.name, kind: "file" });
  }

  /** Pictures into the draft (pasted, dropped, captured, read from a path): every way in is this one, so each says
   *  `attached` (report 28: paste and drop skipped it). */
  function attachImages(imgs: PendingImage[]): void {
    if (!imgs.length) return;
    setImages((prev) => [...prev, ...imgs]);
    for (const i of imgs) told(attachedFns, { name: i.sourcePath?.split("/").pop() ?? "pasted image", kind: "image" });
  }

  /** An @-reference to a vault file (the @ menu's pick, the + menu, the agent's attach). `inline`: the @name is already in
   *  the text (the @ menu typed it); otherwise it is added at the end. */
  function addReference(m: Mention, inline = false): void {
    if (!store.getState().mentions.some((x) => x.path === m.path)) setMentions((prev) => [...prev, m]);
    if (!inline) store.setState((d) => ({ input: `${d.input}${d.input && !/\s$/.test(d.input) ? " " : ""}${m.raw} ` }));
    told(attachedFns, { name: m.name, kind: "reference" });
  }

  /** Take one thing off the draft (the × on a picture or a file, or the agent's detach by name): an @-reference's
   *  @name leaves the text too. Says `detached`. */
  function detachItem(kind: "image" | "file" | "reference" | "selection", index: number): string | null {
    const d = store.getState();
    let name: string | null = null;
    if (kind === "image" && d.images[index]) {
      name = d.images[index]!.sourcePath?.split("/").pop() ?? "pasted image";
      setImages((prev) => prev.filter((_, j) => j !== index));
    } else if (kind === "file" && d.files[index]) {
      name = d.files[index]!.name;
      setFiles((prev) => prev.filter((_, j) => j !== index));
    } else if (kind === "selection" && d.picks[index]) {
      name = pickName(d.picks[index]!);
      store.setState((x) => ({ picks: x.picks.filter((_, j) => j !== index) }));
    } else if (kind === "reference" && d.mentions[index]) {
      const ref = d.mentions[index]!;
      name = ref.name;
      setMentions((prev) => prev.filter((m) => m !== ref));
      setInput((prev) => prev.split(ref.raw).join("").replace(/ {2,}/g, " "));
    }
    if (name) told(detachedFns, { name, kind });
    return name;
  }

  /** Paths picked from disk or named by the agent: images as pictures, vault files as @-references, files outside the
   *  vault read now and uploaded with the message (the box has no copy of them). */
  async function attachPaths(paths: string[]): Promise<{ attached: Attached[]; errors: string[] }> {
    const vaultPath = useStore.getState().vaultPath;
    const refs: Mention[] = [];
    const outside: string[] = [];
    const attached: Attached[] = [];
    const errors: string[] = [];
    for (const raw of paths) {
      const path = raw.replace(/\\/g, "/");
      const name = path.split("/").pop() ?? path;
      const mime = imageMime(path);
      if (mime) {
        try {
          const bytes = await invoke<number[]>("read_binary_file", { path });
          const url = await new Promise<string>((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result));
            r.onerror = () => rej(r.error);
            r.readAsDataURL(new Blob([new Uint8Array(bytes)], { type: mime }));
          });
          attachImages([{ imageDataUrl: url, sourcePath: path }]);
          attached.push({ name, kind: "image" });
          continue;
        } catch (e) {
          console.warn("[attach] image read failed:", e);
        }
      }
      if (!insideVault(path, vaultPath)) {
        outside.push(path);
        continue;
      }
      const rel = path.slice((vaultPath ?? "").replace(/\\/g, "/").replace(/\/+$/, "").length + 1);
      refs.push({ rel, path, name, raw: `@${name}` });
    }
    if (outside.length) {
      const rs = await Promise.all(outside.map((p) => attachPath(p)));
      addAttached(rs);
      for (const r of rs) if (r.ok) attached.push({ name: r.file.name, kind: "file" });
      else errors.push(r.error);
    }
    for (const r of refs) {
      addReference(r);
      attached.push({ name: r.name, kind: "reference" });
    }
    return { attached, errors };
  }

  /** A capture taken for the chat (the marquee): the thumbnail at once, its file on disk when saved. */
  function addCapture(cap: { imageDataUrl: string; sourcePath?: string; sourceAnchor?: string | null }): void {
    attachImages([{ imageDataUrl: cap.imageDataUrl, sourcePath: cap.sourcePath, sourceAnchor: cap.sourceAnchor }]);
    const vaultPath = useStore.getState().vaultPath;
    if (!vaultPath) return;
    void saveCaptureToDisk(vaultPath, cap.imageDataUrl).then((rel) => {
      if (!rel) return;
      setImages((prev) => prev.map((img) => (img.imageDataUrl === cap.imageDataUrl && !img.capturedFilePath ? { ...img, capturedFilePath: rel } : img)));
    });
  }

  /**
   * Send the draft. While the agent works the composer stays open, as in Claude Code: a message goes to the running
   * agent at once (it reads it at its next step). Returns null when it went, else why not.
   */
  async function sendDraft(): Promise<string | null> {
    const st = useStore.getState();
    if (aiBlockedNow()) return "signed out of Claude";
    if (!chatGateOf(scopedState(st, convId)).ready) return "the chat can't take a message now (no box, the box out of reach, or a read-only chat)";
    const draft = store.getState();
    let text = draft.input.trim();
    const { mentions, images: pendingImages, files: pendingFiles, picks } = draft;
    if (!text && pendingImages.length === 0 && pendingFiles.length === 0 && picks.length === 0) return "nothing to send";
    const vaultPath = st.vaultPath;
    const files = st.files;
    store.setState((d) => ({ sending: d.sending + 1 }));
    try {
      // "@C:\path\to\file.pdf" typed or pasted: a file on this laptop. Outside the vault it is read and goes up
      // with the message (the box cannot open a path here); inside, it is an ordinary @-reference.
      const uploads: FileUpload[] = [...pendingFiles];
      const typedRefs: Array<{ rel: string; path: string; isDir?: boolean }> = [];
      const vaultNorm = (vaultPath ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
      for (const m of pathMentions(text)) {
        const path = m.path.replace(/\\/g, "/");
        if (insideVault(path, vaultPath)) {
          typedRefs.push({ rel: path.slice(vaultNorm.length + 1), path });
          continue;
        }
        const r = await attachPath(path);
        if (!r.ok) {
          setAttachError(r.error);
          return r.error;
        }
        uploads.push(r.file);
        text = text.replace(m.raw, `@${r.file.name}`);
      }
      // Resolve every @name token in the text — not just the ones picked from the dropdown. Start from the
      // already-tracked mentions (which carry the exact picked path) and backfill by basename match.
      const tokens = Array.from(text.matchAll(/(?:^|\s)@([\w][\w./-]*)/g)).map((m) => m[1]);
      const byPath = new Map<string, { rel: string; path: string; isDir?: boolean }>();
      for (const m of mentions) {
        const f = files.find((f) => f.path === m.path);
        byPath.set(m.path, { rel: m.rel, path: m.path, isDir: f?.is_dir ?? false });
      }
      for (const tok of tokens) {
        const lower = tok.toLowerCase();
        if (mentions.some((m) => m.name.toLowerCase() === lower)) continue;
        // An attached file's own name (it goes up with the message, not by reference).
        if (uploads.some((u) => u.name.toLowerCase().startsWith(lower))) continue;
        // Case-insensitive basename match — users type however they type.
        const hits = files.filter((f) => !f.hidden && f.name.toLowerCase() === lower);
        if (hits.length === 0) console.warn(`[@ref] no vault entry matched "${tok}" — agent will see only the literal token`);
        for (const h of hits) {
          if (!byPath.has(h.path)) {
            const rel = vaultPath && h.path.startsWith(vaultPath + "/") ? h.path.slice(vaultPath.length + 1) : h.path;
            byPath.set(h.path, { rel, path: h.path, isDir: h.is_dir });
          }
        }
      }
      for (const t of typedRefs) if (!byPath.has(t.path)) byPath.set(t.path, t);
      // A path outside the vault never goes in the prompt (the box cannot open it): those files are uploaded.
      for (const [p, r] of [...byPath]) {
        if (!vaultPath || insideVault(p, vaultPath) || r.isDir) continue;
        byPath.delete(p);
        const got = await attachPath(p);
        if (!got.ok) {
          setAttachError(got.error);
          return got.error;
        }
        if (!uploads.some((u) => u.name === got.file.name && u.size === got.file.size)) uploads.push(got.file);
      }
      const resolved = Array.from(byPath.values());
      const mentionPreamble = await buildMentionPreamble(resolved);
      const viewportCtx = buildViewportContextText(useStore.getState());
      const contextPreamble = [mentionPreamble, pickContext(picks), viewportCtx].filter(Boolean).join("\n\n---\n\n");
      // Belt-and-suspenders: the resolved paths as a footer on the user turn too (stripped from the bubble).
      const pathFooter = resolved.length > 0 ? `\n\n[attached: ${resolved.map((r) => `@${r.rel.split("/").pop()} → ${r.path}`).join(", ")}]` : "";
      // The attached files' names on the message (chips on its bubble: splitFilesLine).
      const filesLn = filesLine(uploads.map((u) => u.name));
      // Only a selection: the message names it (what it is goes in the context).
      if (!text && picks.length) text = `Selected: ${picks.map(pickName).join(", ")}`;
      clearDraft();
      dispatchChatAction({
        kind: "send",
        ...(convId ? { convId } : {}),
        text: text + filesLn + pathFooter,
        contextPreamble: contextPreamble || undefined,
        attachments: pendingImages.length > 0 ? pendingImages : undefined,
        uploads: uploads.length > 0 ? uploads : undefined,
      });
      told(sentFns, { text, images: pendingImages.length, files: uploads.map((u) => u.name), references: resolved.map((r) => r.rel) });
      return null;
    } finally {
      store.setState((d) => ({ sending: Math.max(0, d.sending - 1) }));
    }
  }

  /** Stop the running agent (Esc, or the button with nothing typed); held for the usage limit, cancel the pick-up. */
  const stopAgent = () => dispatchChatAction(convId ? { kind: "stop", id: convId } : { kind: "stop" });

  return { useDraft, setInput, setInputOnly, setMentions, setImages, setFiles, setAttachError, clearDraft, hasDraft, addPick, addAttached, attachImages, addReference, detachItem, attachPaths, addCapture, sendDraft, stopAgent };
}

export type DraftApi = ReturnType<typeof createDraft>;

/** The chat panel's draft (the active chat): the composer plugin's, its fallback's and the agent's. */
export const activeDraft = createDraft(null);
export const { useDraft, setInput, setInputOnly, setMentions, setImages, setFiles, setAttachError, clearDraft, hasDraft, addPick, addAttached, attachImages, addReference, detachItem, attachPaths, addCapture, sendDraft, stopAgent } = activeDraft;

const tileDrafts = new Map<string, DraftApi>();
/** A chat tile's own draft (Carl 11-26: a tile is its own view, even of the chat the panel shows); null: the panel's. */
export function draftFor(chatId: string | null | undefined): DraftApi {
  if (!chatId) return activeDraft;
  let d = tileDrafts.get(chatId);
  if (!d) {
    tileDrafts.set(chatId, (d = createDraft(chatId)));
    for (const w of tileWatchers) w(d);
  }
  return d;
}
/** The chat tiles' drafts made so far (the composer plugin's state and actions reach them by chat id). */
export const tileDraftList = (): [string, DraftApi][] => [...tileDrafts.entries()];
const tileWatchers = new Set<(d: DraftApi) => void>();
/** Calls `fn` on any change to a chat tile's draft, and when a tile's draft is first made. */
export function watchTileDrafts(fn: () => void): () => void {
  const offs: (() => void)[] = [];
  const add = (d: DraftApi) => {
    offs.push(d.useDraft.subscribe(fn));
    fn();
  };
  for (const d of tileDrafts.values()) offs.push(d.useDraft.subscribe(fn));
  tileWatchers.add(add);
  return () => {
    tileWatchers.delete(add);
    offs.forEach((f) => f());
  };
}

/** A message sent while the agent works, not read yet (its row's Send now / Edit / Cancel). */
export function queuedMessages(): { id: string; text: string }[] {
  return useStore.getState().messages.filter((m) => m.waiting && m.mid).map((m) => ({ id: m.mid!, text: m.content.replace(/\n*\[attached:[^\]]*\]\s*$/, "") }));
}
/** Its row's Send now: cut the agent's current step, it answers this next. */
export function sendQueuedNow(id: string): void {
  const convId = useStore.getState().activeConversationId;
  if (convId) dispatchChatAction({ kind: "sendNow", convId, id });
}
/** Its row's Cancel (taken back, not sent), or Edit (`edit`: taken back into the composer's text). */
export function unqueue(id: string, edit = false): void {
  const convId = useStore.getState().activeConversationId;
  if (!convId) return;
  const m = queuedMessages().find((q) => q.id === id);
  dispatchChatAction({ kind: "unqueue", convId, id });
  if (edit && m) window.dispatchEvent(new CustomEvent("vc-composer-insert", { detail: splitFilesLine(m.text).text }));
}

/** Tests: an empty draft. */
export const _resetDraft = () => useDraft.setState({ ...EMPTY });
