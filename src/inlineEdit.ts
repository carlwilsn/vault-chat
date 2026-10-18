// Ctrl+K (rewrite the selection) and Ctrl+L (ask about it): one-shot calls on
// the box (src/complete.ts). This module builds what each request says.
import { complete, type CompleteRequest } from "./complete";
import { northStarPromptBlock } from "./meta";

function prependNorthStar(base: string, northStar?: string): string {
  const block = northStarPromptBlock(northStar ?? "");
  return block ? `${block}\n\n${base}` : base;
}

/** The shared context (src/activity.ts: the project's memory and rules, what
 *  Carl did lately on every surface), after the surface's own rules. */
export function withSharedContext(system: string, shared?: string): string {
  const t = (shared ?? "").trim();
  if (!t) return system;
  return (
    `${system}\n\n# Context from Carl's other surfaces\n` +
    `Carl's rules in it are binding, like the rules above. The rest (project memory, what he did lately in the editor, Ctrl+K, Ctrl+L, voice and chats) is context: ` +
    `use it to resolve "this", "that", "what I just did". Your output format is still set by the instructions above.\n\n${t}`
  );
}

const SYSTEM = `You are an inline editor inside a text/code file. The user presses Ctrl+K and gives you an instruction plus context from the surrounding file.

Your output replaces the SELECTION they had highlighted, or — when SELECTION is empty — is inserted at the cursor.

Strict output rules:
- Output ONLY the replacement / insertion text. No prose, no preamble, no explanation.
- Do NOT wrap your output in markdown code fences (\`\`\`) unless the surrounding file is itself a markdown file and fences are genuinely part of the authored content.
- Match the surrounding style: indentation, quoting, comment style, prose tone.
- Preserve leading/trailing whitespace contract of the original selection where relevant.
- Keep the output self-contained — no cross-references to the chat, no "here is your code".

If earlier turns of this popover are shown, the latest request refines the same edit. Re-emit the entire replacement, not a diff or a description of changes.`;

export type InlineTurn = { prompt: string; result: string };

export type InlineEditParams = {
  prompt: string;
  selection: string;
  before: string;
  after: string;
  language?: string;
  priorTurns?: InlineTurn[];
  /** Images captured via the in-popover marquee injection. Each
   *  carries optional sourcePath / sourceAnchor so we can caption the
   *  image with "from <file> (<page=N>)" when handing it to the model
   *  — prevents the agent from asking where a loose image came from. */
  extraImages?: CapturedExtra[];
  /** Per-vault north-star brief, prepended to the system prompt so the
   *  inline editor honors the vault's declared mode. */
  northStar?: string;
  /** The shared context stream's block (src/activity.ts sharedContextText). */
  sharedContext?: string;
};

export type CapturedExtra = {
  imageDataUrl: string;
  sourcePath?: string;
  sourceAnchor?: string | null;
  /** Says what the image is (a capture the request refers to); replaces the source caption. */
  caption?: string;
};

/** The request's text and images: the first turn's context, the earlier turns
 *  of this popover, and the latest request; each image captioned in the text. */
function oneMessage(firstText: string, prior: InlineTurn[], latest: string, images: CapturedExtra[]): { text: string; images?: string[] } {
  let text = firstText;
  if (prior.length > 0) {
    const turns = prior.map((t, i) => `${i === 0 ? "" : `User: ${t.prompt}\n`}You answered:\n${t.result}`);
    text += `\n\n[Earlier in this popover]\n${turns.join("\n\n")}\n\n[The latest request]\n${latest}`;
  }
  if (images.length === 0) return { text };
  const captions = images.map((img, i) => {
    const src = img.sourcePath ? img.sourcePath.split("/").pop() : null;
    const what = img.caption ? img.caption : src ? `Captured region from ${src}${img.sourceAnchor ? ` (${img.sourceAnchor})` : ""}` : "Captured region";
    return `Image ${i + 1}: ${what}`;
  });
  return { text: `${text}\n\n${captions.join("\n")}`, images: images.map((x) => x.imageDataUrl) };
}

/** Exactly what a Ctrl+K request sends. */
export function buildInlineEditRequest(p: InlineEditParams): CompleteRequest {
  const prior = p.priorTurns ?? [];
  const first = buildContextBody(p, prior[0]?.prompt ?? p.prompt);
  return { instructions: withSharedContext(prependNorthStar(SYSTEM, p.northStar), p.sharedContext), ...oneMessage(first, prior, p.prompt, p.extraImages ?? []) };
}

/** Ctrl+K: the replacement text. */
export function runInlineEdit(p: InlineEditParams): Promise<string> {
  return complete(buildInlineEditRequest(p));
}

function buildContextBody(
  p: InlineEditParams,
  instruction: string,
  attached?: Array<{ rel: string; path: string; content?: string | null }>,
): string {
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
  if (attached && attached.length > 0) {
    const blocks = attached.map((a) => {
      if (a.content == null) {
        return `@${a.rel} — path: ${a.path} (binary or unreadable)`;
      }
      return `@${a.rel} — absolute path: ${a.path}\n${a.content}`;
    });
    parts.push(
      `ATTACHED FILES (the user referenced these with @mention; paths are authoritative, do not search for them):\n${blocks.join("\n\n")}`,
    );
  }
  return parts.join("\n\n");
}

const ASK_SYSTEM = `You are an assistant inside a text/code file viewer. The user highlights a selection (or puts their cursor on a line) and asks a question about it.

Answer from the context you are given (the file excerpt, the page text, any attached files and images). If it is not enough, say what is missing.

When the user has captured a region from a PDF (a LOCATION line is present and an image is attached), the captured image is the primary subject of the question. Lead with what is visible in the image — describe the marqueed content first, then bring in surrounding-page text only as supporting context. The LOCATION line tells you exactly which page the user is on; trust it over any pattern-matching impulse from training data, and prefer the labeled CURRENT PAGE text over PREV/NEXT when they conflict. Do not invent theorem numbers, equation labels, or proof structure that isn't visible in the image or in the labeled page text.

Answer in markdown. Be concise — this renders in a small popover. Use fenced code blocks for code. Use $$...$$ for display math (inline $...$ does not render here).`;

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

export type InlineAskParams = InlineEditParams & {
  // Optional region screenshot (data URL) to attach to the first user
  // message alongside the text context. Used by the PDF marquee so the
  // model can see math, tables, and diagrams that text extraction
  // mangles.
  imageDataUrl?: string;
  // PDF-only: when present, the first user turn uses a structured
  // page-keyed context block (LOCATION + CURRENT/PREV/NEXT pages)
  // instead of the flat before/after dump. before/after are still
  // populated for the chat-transplant hidden preamble downstream, but
  // the popover ask itself reads from this field exclusively.
  pdfContext?: PdfAskContext;
  // User-attached files via @mention. Content is pre-loaded by the
  // caller (null for binaries) so we don't re-read here.
  attachedFiles?: Array<{ rel: string; path: string; content: string | null }>;
  // Images captured mid-conversation via the popover's Capture button.
  // Attached to the LATEST user turn only.
  extraImages?: CapturedExtra[];
  // Recent chat-pane transcript. If provided, gets folded into the
  // hidden context on the first turn so the popover agent knows
  // what the user was just working on in the main chat.
  chatPaneHistory?: Array<{ role: "user" | "assistant"; content: string }>;
};

/** Ctrl+L: the answer (markdown). */
export function runInlineAsk(p: InlineAskParams): Promise<string> {
  return complete(buildInlineAskRequest(p));
}

/** Exactly what a Ctrl+L request sends. */
export function buildInlineAskRequest(p: InlineAskParams): CompleteRequest {
  const prior = p.priorTurns ?? [];
  const firstPrompt = prior[0]?.prompt ?? p.prompt;
  let firstContent = p.pdfContext
    ? buildPdfContextBody(p, firstPrompt, p.pdfContext, p.attachedFiles)
    : buildContextBody(p, firstPrompt, p.attachedFiles);
  // The last few turns of the open chat, as reference for what Carl is working on.
  const chat = p.chatPaneHistory ?? [];
  if (chat.length > 0) {
    const transcript = chat.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n---\n\n");
    const header =
      "[Recent chat-pane conversation — context for what the user is working on right now. Do not respond to it directly; it's reference material for the question that follows.]";
    firstContent = `${header}\n\n${transcript}\n\n[End of chat-pane history]\n\n${firstContent}`;
  }
  // The marquee's region first, then images captured in the popover.
  const images: CapturedExtra[] = [...(p.imageDataUrl ? [{ imageDataUrl: p.imageDataUrl }] : []), ...(p.extraImages ?? [])];
  return { instructions: withSharedContext(prependNorthStar(ASK_SYSTEM, p.northStar), p.sharedContext), ...oneMessage(firstContent, prior, p.prompt, images) };
}

// Build the first-turn user content for a PDF marquee ask. Layout:
//
//   LOCATION + CAPTURED TEXT first so the model frames its answer
//   around "the user is on page N looking at this region." Image goes
//   into the user content array separately (right after this text), so
//   model order is: location label → image → labeled page texts →
//   question. The QUESTION lands last because recency pulls a stronger
//   signal from later content in the prompt.
function buildPdfContextBody(
  p: InlineAskParams,
  instruction: string,
  ctx: PdfAskContext,
  attached?: Array<{ rel: string; path: string; content?: string | null }>,
): string {
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
  if (attached && attached.length > 0) {
    const blocks = attached.map((a) => {
      if (a.content == null) {
        return `@${a.rel} — path: ${a.path} (binary or unreadable)`;
      }
      return `@${a.rel} — absolute path: ${a.path}\n${a.content}`;
    });
    parts.push(
      `ATTACHED FILES (the user referenced these with @mention; paths are authoritative, do not search for them):\n${blocks.join("\n\n")}`,
    );
  }
  parts.push(`QUESTION:\n${instruction}`);
  return parts.join("\n\n");
}

export function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const m = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return m ? m[1] : s;
}
