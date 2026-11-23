// The note composer (Ctrl+N, a Ctrl+K box's "save as note"): what it holds while it is open (its text and its anchors:
// the files it points at and the regions captured on them) and what its controls do. Module state, not React's, so the
// popup (src/NotePopup.tsx) and the Notes part's offers (src/plugins/notes: composer state and its actions) read and
// change the same thing: the agent's PluginAct is Carl's click. Saving is the notes noun's add on the box (src/notes.ts
// appendNote → POST /notes → box:notes add).
import { create } from "zustand";
import { useStore } from "./store";
import { anchorImages, buildNote, type NoteAnchor } from "./notes";
import { fileKind } from "./fileKind";

export type NoteComposerState = { text: string; anchors: NoteAnchor[] };
export const useNoteComposer = create<NoteComposerState>(() => ({ text: "", anchors: [] }));
const N = () => useNoteComposer.getState();

export function kindOf(path: string): NoteAnchor["source_kind"] {
  if (!path) return "none";
  const { kind } = fileKind(path);
  if (kind === "markdown") return "markdown";
  if (kind === "pdf") return "pdf";
  if (kind === "html") return "html";
  if (kind === "image") return "image";
  if (kind === "notebook") return "notebook";
  return "code";
}

/** Open it (Ctrl+N): seeded with `text` and `anchors`, else the open file. */
export function openNoteComposer(p: { text?: string; anchors?: NoteAnchor[]; turns?: { role: "user" | "assistant"; content: string }[] } = {}): void {
  useStore.getState().openNoteComposer({ initialDraft: p.text, initialAnchors: p.anchors, initialTurns: p.turns });
}

/** What it shows when it opens (the popup calls this on each open). */
export function seedNoteComposer(text: string, anchors: NoteAnchor[] | undefined, currentFile: string | null): void {
  useNoteComposer.setState({
    text,
    anchors: anchors && anchors.length ? anchors : currentFile ? [{ source_path: currentFile, source_kind: kindOf(currentFile), source_anchor: null, primary: true }] : [],
  });
}

export const setNoteComposerText = (text: string) => useNoteComposer.setState({ text });

/** Link another file or folder (its picker's pick). */
export function addNoteAnchor(path: string, isDir = false): void {
  if (N().anchors.some((a) => a.source_path === path)) return;
  useNoteComposer.setState((s) => ({ anchors: [...s.anchors, { source_path: path, source_kind: isDir ? "code" : kindOf(path), source_anchor: null, primary: s.anchors.length === 0 }] }));
}

/** Link a vault file or folder by its vault-relative path (the agent's addComposerFile); false when there is none. */
export function addNoteAnchorAt(rel: string): boolean {
  const s = useStore.getState();
  const vault = (s.vaultPath ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const r = rel.replace(/\\/g, "/").replace(/^\.?\//, "");
  const f = s.files.find((x) => x.path.replace(/\\/g, "/") === `${vault}/${r}`);
  if (!f) return false;
  addNoteAnchor(f.path, f.is_dir);
  return true;
}

/** An anchor's ×: the first left becomes the primary. */
export function removeNoteAnchor(path: string): void {
  useNoteComposer.setState((s) => {
    const next = s.anchors.filter((a) => a.source_path !== path);
    if (next.length > 0 && !next.some((a) => a.primary)) next[0] = { ...next[0]!, primary: true };
    return { anchors: next };
  });
}

/** A captured picture's ×. */
export function removeNoteImage(path: string, index: number): void {
  useNoteComposer.setState((s) => ({
    anchors: s.anchors.map((a) => {
      if (a.source_path !== path) return a;
      const next = anchorImages(a).filter((_, i) => i !== index);
      return { ...a, image_data_url: next[0] ?? null, images: next };
    }),
  }));
}

/** Capture region: the popup hides, Carl drags a region in the viewer, and it comes back with the picture. */
export function captureForNote(): void {
  const s = useStore.getState();
  s.setChatPaneCapturePending(false);
  s.setEditPromptCapturePending(false);
  s.stashNoteForCapture({ draft: N().text, anchors: N().anchors, turns: s.noteComposer.initialTurns ?? [] });
  window.dispatchEvent(new CustomEvent("vc-marquee-toggle"));
}

/** Save note: the notes noun's add (empty text is fine: the anchor alone is a bookmark); then it closes. */
export async function saveNoteComposer(): Promise<string> {
  const s = useStore.getState();
  const note = buildNote({ anchors: N().anchors, turns: s.noteComposer.initialTurns ?? [], userDraft: N().text.trim() || null });
  await s.addNote(note);
  s.closeNoteComposer();
  return note.id;
}

export const closeNoteComposer = () => useStore.getState().closeNoteComposer();

/** What the agent reads of it. */
export function noteComposerNow() {
  const s = useStore.getState().noteComposer;
  if (!s.open) return { open: false };
  return {
    open: true,
    text: N().text,
    anchors: N().anchors.map((a) => ({ path: a.source_path, ...(a.source_anchor ? { anchor: a.source_anchor } : {}), ...(a.primary ? { primary: true } : {}), images: anchorImages(a).length })),
    turns: (s.initialTurns ?? []).length,
  };
}
