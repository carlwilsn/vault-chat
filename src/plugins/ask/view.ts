// The Ctrl+K / Ctrl+L box's shared state (src/plugins/ask, app/ask): what a request is (the anchor it opens at, the
// selection and the text around it, a PDF page's context), and the boxes open now. Each open box (./Prompt.tsx, the
// plugin's or the built-in copy drawn in the app's tree) registers here while it is on screen, with what it shows and
// what its buttons do, so the offers (./index.tsx) read and act on the box Carl sees: what the agent does through
// PluginAct is what his keys and clicks do. Shared with the app (a live copy of app/ask takes this module from the
// running app), so the copies and the fallback see the same boxes.
import type { EditProposal } from "../../complete";

export type InlineEditAnchor = {
  left: number;
  top: number;
  bottom: number;
  // Optional right edge. When present (PDF marquee), placement treats
  // the anchor as a full rect and places the popover on the side the
  // drag ended — dirX/dirY carry the drag direction.
  right?: number;
  // Sign of the drag's horizontal motion (+1 right, -1 left). Used only
  // with `right`. Defaults to +1 if omitted.
  dirX?: number;
  // Sign of the drag's vertical motion (+1 down, -1 up). Defaults to +1.
  dirY?: number;
};

// PDF marquees carry richer location info: the canvas-overlap page is
// authoritative (computed from canvas geometry, not text matching), and
// PREV/CURRENT/NEXT page text comes from a page-indexed array — so the
// ask agent gets context that is anchored to where the user actually is
// in the doc, not "wherever the captured snippet first matches in a
// joined full-text string." Image leads, page label is explicit.
export type PdfContext = {
  pageNum: number;
  totalPages: number;
  fileName: string;
  currentPageText: string;
  prevPageText: string | null;
  nextPageText: string | null;
};

export type InlineEditRequest = {
  anchor: InlineEditAnchor;
  selection: string;
  /** The whole file and the selection's offsets in it (an editor only): what the agent's ProposeEdit resolves against. */
  doc?: { text: string; from: number; to: number };
  before: string;
  after: string;
  language?: string;
  // Optional screenshot (data URL) sent to the agent alongside the
  // text context. Not shown to the user.
  imageDataUrl?: string;
  // Optional source-location hint for when this request later becomes
  // a note — e.g. "page=3" for a PDF marquee, "L42" for a code cursor.
  sourceAnchor?: string;
  // PDF-only: structured page-keyed context. When present, the ask
  // agent uses this in place of the flat before/after dump.
  pdfContext?: PdfContext;
};

/** What an open box shows now (the offers' `open` state). */
export type AskBoxState = {
  id: string;
  /** The vault-relative file it was opened on, or null. */
  file: string | null;
  /** It may propose an edit to the file (Ctrl+K in an editor); otherwise it only answers (Ctrl+L, a viewer). */
  editable: boolean;
  selection: string;
  where: string | null;
  /** What is typed in it, not sent yet. */
  prompt: string;
  /** The question it last sent, and its answer so far. */
  asked: string | null;
  answer: string;
  streaming: boolean;
  error: string | null;
  /** The edit the agent proposed, waiting for Accept: the text it puts in and what it replaces. */
  proposal: { newText: string; removed: string | null } | null;
  turns: number;
  images: number;
};

/** An open box's handle: what it shows and what its controls do (each the same as the click or key). */
export type AskBox = {
  read(): AskBoxState;
  type(text: string): void;
  submit(text?: string): Promise<void> | void;
  accept(): boolean;
  close(): void;
  sendToChat(): Promise<void> | void;
  saveAsNote(): void;
  focus(): void;
};

let seq = 0;
const boxes = new Map<string, AskBox>();
type Listener = (event: string, data?: unknown) => void;
const listeners = new Set<Listener>();

/** A fresh id for a box (ask-1, ask-2, ...). */
export const nextAskId = (): string => `ask-${++seq}`;

/** A box on screen; the off when it closes. */
export function registerAskBox(id: string, box: AskBox): () => void {
  boxes.set(id, box);
  emitAskEvent("opened", { id });
  return () => {
    if (boxes.get(id) !== box) return;
    boxes.delete(id);
    emitAskEvent("closed", { id });
  };
}

/** The boxes open now, oldest first. */
export const askBoxes = (): [string, AskBox][] => [...boxes.entries()];

/** The box an action means: the one named, else the newest. */
export function askBox(id?: unknown): [string, AskBox] {
  const all = askBoxes();
  if (!all.length) throw new Error("no Ctrl+K / Ctrl+L box is open (Carl opens one with Ctrl+K or Ctrl+L in a file)");
  if (id === undefined || id === null || id === "") return all[all.length - 1]!;
  const hit = all.find(([k]) => k === String(id));
  if (!hit) throw new Error(`no open box "${String(id)}" (open: ${all.map(([k]) => k).join(", ")})`);
  return hit;
}

/** What the boxes did (opened, closed, asked, answered, accepted, rejected, sentToChat, savedAsNote), for the offers' events. */
export function onAskEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
export function emitAskEvent(event: string, data?: unknown): void {
  for (const f of [...listeners]) {
    try {
      f(event, data);
    } catch {
      /* a listener's own failure */
    }
  }
}

/** The proposal as the offers show it. */
export const shownProposal = (p: EditProposal | null, selection: string): AskBoxState["proposal"] =>
  p ? { newText: p.newText, removed: p.removed ?? (selection || null) } : null;

/** Tests: forget every box. */
export function _resetAskBoxes(): void {
  boxes.clear();
}
