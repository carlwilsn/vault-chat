import { streamText, stepCountIs, type ModelMessage } from "ai";
import { buildModel, findModel, DEFAULT_MODEL_ID } from "./providers";
import { buildTools } from "./tools";

const SYSTEM = `You are an inline editor inside a text/code file. The user presses Ctrl+K and gives you an instruction plus context from the surrounding file.

Your output replaces the SELECTION they had highlighted, or — when SELECTION is empty — is inserted at the cursor.

Strict output rules:
- Output ONLY the replacement / insertion text. No prose, no preamble, no explanation.
- Do NOT wrap your output in markdown code fences (\`\`\`) unless the surrounding file is itself a markdown file and fences are genuinely part of the authored content.
- Match the surrounding style: indentation, quoting, comment style, prose tone.
- Preserve leading/trailing whitespace contract of the original selection where relevant.
- Keep the output self-contained — no cross-references to the chat, no "here is your code".

If the conversation has multiple turns, later user messages refine the same edit. Re-emit the entire replacement, not a diff or a description of changes.`;

export type InlineTurn = { prompt: string; result: string };

export type InlineEditParams = {
  modelId: string;
  apiKey: string;
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
  abortSignal?: AbortSignal;
};

export type CapturedExtra = {
  imageDataUrl: string;
  sourcePath?: string;
  sourceAnchor?: string | null;
};

// Emit a user-turn content array with text + captioned image parts.
// AI SDK's UserContent type is narrow, so we cast to any — we only
// produce text / image parts, both valid. Images with source metadata
// get a short caption preceding them so the model knows the region's
// origin without asking.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeUserContent(text: string, images: CapturedExtra[]): any {
  if (images.length === 0) return text;
  const parts: unknown[] = [{ type: "text", text }];
  for (const img of images) {
    const src = img.sourcePath ? img.sourcePath.split("/").pop() : null;
    const caption = src
      ? `Captured region from ${src}${img.sourceAnchor ? ` (${img.sourceAnchor})` : ""}:`
      : "Captured region:";
    parts.push({ type: "text", text: caption });
    parts.push({ type: "image", image: new URL(img.imageDataUrl) });
  }
  return parts;
}

export async function* runInlineEdit(
  p: InlineEditParams,
): AsyncGenerator<string, void, void> {
  const spec = findModel(p.modelId) ?? findModel(DEFAULT_MODEL_ID);
  if (!spec) throw new Error(`unknown model: ${p.modelId}`);
  const model = buildModel(spec, p.apiKey);

  const messages: ModelMessage[] = [];
  const prior = p.priorTurns ?? [];
  const extras: CapturedExtra[] = p.extraImages ?? [];
  const firstPrompt = prior[0]?.prompt ?? p.prompt;
  const firstContent = buildContextBody(p, firstPrompt);
  if (prior.length > 0) {
    messages.push({ role: "user", content: firstContent });
    messages.push({ role: "assistant", content: prior[0].result });
    for (let i = 1; i < prior.length; i++) {
      messages.push({ role: "user", content: prior[i].prompt });
      messages.push({ role: "assistant", content: prior[i].result });
    }
    // Latest user turn — the one the model is about to respond to —
    // carries any freshly captured marquee images.
    messages.push({ role: "user", content: makeUserContent(p.prompt, extras) });
  } else {
    // Single-turn case; attach extras to the only user message.
    messages.push({ role: "user", content: makeUserContent(firstContent, extras) });
  }

  const result = streamText({
    model,
    system: SYSTEM,
    messages,
    abortSignal: p.abortSignal,
  });

  for await (const chunk of result.textStream) {
    yield chunk;
  }
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
        return `@${a.rel} — absolute path: ${a.path} (binary or unreadable; call Read if you need contents)`;
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

You have read-only tools for fetching more context: Read, Glob, Grep, ListDir, PdfExtract, WebFetch, WebSearch. Use them only when you genuinely need more than the file excerpt provides — otherwise answer directly.

Answer in markdown. Be concise — this renders in a small popover. Use fenced code blocks for code. Use $$...$$ for display math (inline $...$ does not render here). Don't narrate tool use.`;

export type AskEvent =
  | { kind: "text"; delta: string }
  | { kind: "thinking" }
  | { kind: "error"; message: string };

export type InlineAskParams = InlineEditParams & {
  vault: string;
  tavilyKey?: string;
  // Optional region screenshot (data URL) to attach to the first user
  // message alongside the text context. Used by the PDF marquee so the
  // model can see math, tables, and diagrams that text extraction
  // mangles.
  imageDataUrl?: string;
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

export async function* runInlineAsk(
  p: InlineAskParams,
): AsyncGenerator<AskEvent, void, void> {
  const spec = findModel(p.modelId) ?? findModel(DEFAULT_MODEL_ID);
  if (!spec) throw new Error(`unknown model: ${p.modelId}`);
  const model = buildModel(spec, p.apiKey);

  const allTools = buildTools(p.vault, p.tavilyKey) as Record<string, unknown>;
  const readOnlyNames = [
    "Read",
    "Glob",
    "Grep",
    "ListDir",
    "PdfExtract",
    "WebFetch",
    "WebSearch",
  ] as const;
  const tools: Record<string, unknown> = {};
  for (const name of readOnlyNames) {
    if (allTools[name]) tools[name] = allTools[name];
  }

  const messages: ModelMessage[] = [];
  const prior = p.priorTurns ?? [];
  const firstPrompt = prior[0]?.prompt ?? p.prompt;
  let firstContent = buildContextBody(p, firstPrompt, p.attachedFiles);

  // If the caller supplied recent chat-pane history, prepend it to
  // the first turn's context body as a labelled transcript. The
  // popover agent then has the last few turns from the main chat as
  // context on what the user is working on.
  const chat = p.chatPaneHistory ?? [];
  if (chat.length > 0) {
    const transcript = chat
      .map((m) => {
        const who = m.role === "user" ? "User" : "Assistant";
        return `${who}: ${m.content}`;
      })
      .join("\n\n---\n\n");
    const header =
      "[Recent chat-pane conversation — context for what the user is working on right now. Do not respond to it directly; it's reference material for the question that follows.]";
    firstContent = `${header}\n\n${transcript}\n\n[End of chat-pane history]\n\n${firstContent}`;
  }

  // If we have a region screenshot, attach it as an image part on the
  // first user message — the same turn that carries the file context.
  // The model then sees text + image together and can cross-reference.
  const extras: CapturedExtra[] = p.extraImages ?? [];
  const firstTurnImages: CapturedExtra[] = [];
  if (p.imageDataUrl) {
    firstTurnImages.push({ imageDataUrl: p.imageDataUrl });
  }

  if (prior.length > 0) {
    messages.push({ role: "user", content: makeUserContent(firstContent, firstTurnImages) });
    messages.push({ role: "assistant", content: prior[0].result });
    for (let i = 1; i < prior.length; i++) {
      messages.push({ role: "user", content: prior[i].prompt });
      messages.push({ role: "assistant", content: prior[i].result });
    }
    // Latest turn — extras go here so the model uses them for the
    // response it's about to generate.
    messages.push({ role: "user", content: makeUserContent(p.prompt, extras) });
  } else {
    // Single-turn: both firstTurn image (if any) AND extras land here.
    messages.push({
      role: "user",
      content: makeUserContent(firstContent, [...firstTurnImages, ...extras]),
    });
  }

  const result = streamText({
    model,
    system: ASK_SYSTEM,
    messages,
    tools: tools as any,
    stopWhen: stepCountIs(8),
    abortSignal: p.abortSignal,
  });

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      if ("text" in part && typeof part.text === "string") {
        yield { kind: "text", delta: part.text };
      }
    } else if (part.type === "tool-call") {
      yield { kind: "thinking" };
    } else if (part.type === "error") {
      const err = (part as { error?: { message?: string } }).error;
      yield { kind: "error", message: err?.message ?? String(err) };
    }
  }
}

export function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const m = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return m ? m[1] : s;
}
