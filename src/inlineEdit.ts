// Ctrl+K and Ctrl+L are one input: Carl talking to the agent, with his selection, the open file and his cursor
// as context. The agent decides per message: answer, propose an edit (the ProposeEdit tool: server/engine/proposeEdit.ts),
// or do more with its tools. Requests to the agent on the box, as a side thread of the open conversation (src/complete.ts
// side(); server/engine/pi/side.ts: pi forks the conversation's session, with
// pi's read-only tools). The conversation's history, the agent's instructions
// and what Carl did elsewhere come from the box; this module builds what the
// request itself says. A popover's later requests continue the same side
// thread, so they carry only what is new.
import { side, type SideOpts, type SideRequest, type SideResult } from "./complete";
import { northStarPromptBlock } from "./meta";

function prependNorthStar(base: string, northStar?: string): string {
  const block = northStarPromptBlock(northStar ?? "");
  return block ? `${block}\n\n${base}` : base;
}

export type InlineTurn = { prompt: string; result: string };

export type InlineEditParams = {
  prompt: string;
  selection: string;
  before: string;
  after: string;
  language?: string;
  /** The popover's side thread (its earlier requests): this request refines them. */
  side?: string | null;
  /** The open conversation: the side thread forks its pi session. */
  convId?: string | null;
  /** Images captured via the in-popover marquee injection. Each
   *  carries optional sourcePath / sourceAnchor so we can caption the
   *  image with "from <file> (<page=N>)" when handing it to the model
   *  — prevents the agent from asking where a loose image came from. */
  extraImages?: CapturedExtra[];
  /** Per-vault north-star brief, prepended to the request's rules so the
   *  inline editor honors the vault's declared mode. */
  northStar?: string;
  /** Whether the open file can take an edit (false for a PDF, image, rendered page): no ProposeEdit then. Default true. */
  editable?: boolean;
  /** The model Carl picked for this input; unset, the box's default for it (Haiku 5.5). */
  model?: string;
};

export type CapturedExtra = {
  imageDataUrl: string;
  sourcePath?: string;
  sourceAnchor?: string | null;
  /** Says what the image is (a capture the request refers to); replaces the source caption. */
  caption?: string;
};

/** The request's text and images, each image captioned in the text. */
function oneMessage(text: string, images: CapturedExtra[]): { text: string; images?: string[] } {
  if (images.length === 0) return { text };
  const captions = images.map((img, i) => {
    const src = img.sourcePath ? img.sourcePath.split("/").pop() : null;
    const what = img.caption ? img.caption : src ? `Captured region from ${src}${img.sourceAnchor ? ` (${img.sourceAnchor})` : ""}` : "Captured region";
    return `Image ${i + 1}: ${what}`;
  });
  return { text: `${text}\n\n${captions.join("\n")}`, images: images.map((x) => x.imageDataUrl) };
}

/** Where the request goes: a new side thread of the open conversation, or the popover's own. */
function target(p: InlineEditParams): Pick<SideRequest, "convId" | "side"> {
  return { convId: p.convId ?? null, ...(p.side ? { side: p.side } : {}) };
}

type Attached = Array<{ rel: string; path: string; content?: string | null }>;

/** The files Carl @mentioned, with their contents. */
function attachedBlock(attached?: Attached): string {
  if (!attached || attached.length === 0) return "";
  const blocks = attached.map((a) => (a.content == null ? `@${a.rel} — path: ${a.path} (binary or unreadable)` : `@${a.rel} — absolute path: ${a.path}\n${a.content}`));
  return `ATTACHED FILES (the user referenced these with @mention; paths are authoritative, do not search for them):\n${blocks.join("\n\n")}`;
}

function buildContextBody(p: InlineEditParams, instruction: string, attached?: Attached): string {
  const MAX_CTX = 4000;
  const before =
    p.before.length > MAX_CTX ? "…" + p.before.slice(-MAX_CTX) : p.before;
  const after =
    p.after.length > MAX_CTX ? p.after.slice(0, MAX_CTX) + "…" : p.after;

  const parts: string[] = [];
  if (p.language) parts.push(`FILE_LANGUAGE: ${p.language}`);
  parts.push(`INSTRUCTION:\n${instruction}`);
  if (p.selection) {
    parts.push(`SELECTION:\n${p.selection}`);
  } else {
    parts.push("SELECTION: (empty — insert at the cursor)");
  }
  parts.push(`BEFORE (file content before selection/cursor):\n${before}`);
  parts.push(`AFTER (file content after selection/cursor):\n${after}`);
  const files = attachedBlock(attached);
  if (files) parts.push(files);
  return parts.join("\n\n");
}

const INLINE_HEADER = `# Ctrl+K / Ctrl+L: Carl is talking to you from the file he has open
This is one input: Carl's message, with his selection, the open file and his cursor as context. It is a side request beside his conversation; your reply shows in a small popover over the file and is not added to the chat.
Decide from what he says:
- A question: answer in markdown, concisely. Use fenced code blocks for code and $$...$$ for display math (inline $...$ does not render here). Start from the context you are given (the file excerpt, the page text, attached files and images); when it is not enough, look it up with your tools (files in the vault, PDFs with PdfRead, images, the web). Never ask Carl for a screenshot or a copy of anything in his vault: read it yourself.
- A change to the file: call ProposeEdit(newText). It replaces his SELECTION (or is inserted at his CURSOR when the selection is empty). newText is only the replacement, in the surrounding style, without code fences unless fences belong in the file. Nothing is written until he accepts. Then say in one line what you proposed.
- Something bigger ("clean this up and move it into a note"): do it with the tools you have (ProposeEdit, CreateNote, and so on), then say what you did in a line.
When he has captured a region from a PDF (a LOCATION line is present and an image is attached), the image is the primary subject: describe what is visible first, then bring in page text as support. The LOCATION line tells you exactly which page he is on; trust it, and prefer the CURRENT PAGE text over PREV/NEXT. Do not invent theorem numbers or labels that are not visible.
If he refines in a later message, it refines the same work; propose the whole new replacement again.`;

const READ_ONLY_FILE = "\nThis file cannot be edited from here: ProposeEdit is not available. Answer in words, or use your other tools.";

// Structured page-keyed context for PDF marquees. Fixes the old
// behavior where surrounding context was sliced from a single joined
// full-text string via indexOf(captured snippet) — which could anchor
// on the wrong page entirely if the snippet's prefix happened to match
// elsewhere in the doc. Now the page comes from canvas-overlap geometry
// (authoritative), and PREV/NEXT are direct page-array lookups.
export type PdfAskContext = {
  pageNum: number;
  totalPages: number;
  fileName: string;
  currentPageText: string;
  prevPageText: string | null;
  nextPageText: string | null;
};

export type InlineParams = InlineEditParams & {
  // Optional region screenshot (data URL) to attach to the first user
  // message alongside the text context. Used by the PDF marquee so the
  // model can see math, tables, and diagrams that text extraction
  // mangles.
  imageDataUrl?: string;
  // PDF-only: when present, the first request uses a structured
  // page-keyed context block (LOCATION + CURRENT/PREV/NEXT pages)
  // instead of the flat before/after dump.
  pdfContext?: PdfAskContext;
  // User-attached files via @mention. Content is pre-loaded by the
  // caller (null for binaries) so we don't re-read here.
  attachedFiles?: Array<{ rel: string; path: string; content: string | null }>;
  // Images captured mid-conversation via the popover's Capture button.
  // Attached to the LATEST request only.
  extraImages?: CapturedExtra[];
};

/** Ctrl+L: the answer (markdown, streamed to `onText`), and the side thread a follow-up continues. */
export function runInline(p: InlineParams, opts: SideOpts = {}): Promise<SideResult> {
  return side(buildInlineRequest(p), opts);
}

/** Exactly what a Ctrl+K / Ctrl+L request sends. */
export function buildInlineRequest(p: InlineParams): SideRequest {
  let text: string;
  if (p.side) {
    // A follow-up in the same side thread: only what is new.
    text = [p.prompt, attachedBlock(p.attachedFiles)].filter(Boolean).join("\n\n");
  } else {
    const body = p.pdfContext ? buildPdfContextBody(p, p.prompt, p.pdfContext, p.attachedFiles) : buildContextBody(p, p.prompt, p.attachedFiles);
    text = `${prependNorthStar(p.editable === false ? INLINE_HEADER + READ_ONLY_FILE : INLINE_HEADER, p.northStar)}\n\n${body}`;
  }
  // The marquee's region first (with the first request), then images captured in the popover.
  const images: CapturedExtra[] = [...(p.imageDataUrl && !p.side ? [{ imageDataUrl: p.imageDataUrl }] : []), ...(p.extraImages ?? [])];
  return { kind: "inline", editable: p.editable !== false, ...(p.model ? { model: p.model } : {}), ...target(p), ...oneMessage(text, images) };
}

// Build the first request's content for a PDF marquee ask. Layout:
//
//   LOCATION + CAPTURED TEXT first so the model frames its answer
//   around "the user is on page N looking at this region." Image goes
//   into the user content array separately (right after this text), so
//   model order is: location label → image → labeled page texts →
//   question. The QUESTION lands last because recency pulls a stronger
//   signal from later content in the prompt.
function buildPdfContextBody(p: InlineParams, instruction: string, ctx: PdfAskContext, attached?: Attached): string {
  const parts: string[] = [];
  parts.push(
    `LOCATION: page ${ctx.pageNum} of ${ctx.totalPages} in ${ctx.fileName}`,
  );
  if (p.selection) {
    parts.push(`CAPTURED TEXT (inside the marqueed rectangle):\n${p.selection}`);
  } else {
    parts.push(
      "CAPTURED TEXT: (none — the rectangle has no extractable text; rely on the image)",
    );
  }
  parts.push(
    `CURRENT PAGE (page ${ctx.pageNum} — where the user is):\n${ctx.currentPageText || "(empty)"}`,
  );
  if (ctx.prevPageText) {
    parts.push(`PREV PAGE (page ${ctx.pageNum - 1}):\n${ctx.prevPageText}`);
  }
  if (ctx.nextPageText) {
    parts.push(`NEXT PAGE (page ${ctx.pageNum + 1}):\n${ctx.nextPageText}`);
  }
  const files = attachedBlock(attached);
  if (files) parts.push(files);
  parts.push(`QUESTION:\n${instruction}`);
  return parts.join("\n\n");
}

export function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const m = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return m ? m[1] : s;
}
