import { streamText, stepCountIs, type ModelMessage } from "ai";
import { buildModel, findModel, DEFAULT_MODEL_ID } from "./providers";
import { buildTools } from "./tools";
import { loadSkills, skillPromptIndex, expandSkillInvocation } from "./skills";
import { loadSessionContext } from "./context";

export type TokenUsage = {
  prompt: number;
  completion: number;
  total: number;
  context: number;
};

export type StreamEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool_use"; id: string; name: string; input: any }
  | { kind: "tool_result"; id: string; result: string }
  | { kind: "done"; usage?: TokenUsage }
  | { kind: "error"; message: string };

export type ChatTurn = { role: "user" | "assistant"; content: string };

const BASE_SYSTEM = `You are the runtime for a personal knowledge vault. The user interacts with you through a desktop app that shows a file tree, a markdown viewer, and this chat pane.

You are working inside the user's vault. Your working directory is the vault root. When the user refers to files, they mean files in this vault. Start by understanding the vault's structure before making changes.

Core behaviors:
- When the vault defines rules (e.g. LEARNING_RULES.md), treat them as binding. They override generic defaults.
- Render math using $$...$$ display style. Do not use inline $...$ in chat — it will not render.
- All paths passed to tools must be absolute.
- Tools available: Read, Write, Edit, Delete, Glob, Grep, Bash, ListDir, NotebookEdit, PdfExtract, TodoWrite, WebFetch, and (if configured) WebSearch. Prefer Edit over Write for small changes. Prefer Grep+Glob over reading many files blindly. Use Delete only when the user has explicitly asked to remove a file — it is irreversible. Use NotebookEdit on .ipynb files instead of Write/Edit — it's cell-aware and safer. Use PdfExtract to read PDF slide decks, papers, and lecture notes in the vault — pass a page range for long PDFs. Use TodoWrite whenever a task will take 3+ distinct steps, so the user can see the plan unfold — update it as you progress. Use WebFetch when you know the URL. Use WebSearch for current information or to find URLs when the user asks a general web question.
- Bash runs in the vault root by default. Use it for git, pytest, scripts, and anything shell-native.`;

export async function runAgent(params: {
  modelId: string;
  apiKey: string;
  vault: string;
  history: ChatTurn[];
  userMessage: string;
  onEvent: (e: StreamEvent) => void;
  abortSignal?: AbortSignal;
  tavilyKey?: string;
}) {
  const { modelId, apiKey, vault, history, userMessage, onEvent, abortSignal, tavilyKey } = params;

  try {
    const spec = findModel(modelId) ?? findModel(DEFAULT_MODEL_ID);
    if (!spec) throw new Error(`unknown model: ${modelId}`);
    const model = buildModel(spec, apiKey);

    const [sessionContext, skills] = await Promise.all([
      loadSessionContext(vault),
      loadSkills(vault),
    ]);

    const { body: expandedMessage } = expandSkillInvocation(userMessage, skills);

    const system = [
      BASE_SYSTEM,
      `\nVault root: ${vault}`,
      sessionContext ? `\n${sessionContext}` : "",
      skills.length ? `\n${skillPromptIndex(skills)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // Prompt caching (Anthropic): mark the system prompt and the prior
    // conversation prefix as cacheable. The current user turn is never
    // cached — it changes every call. On a 10-turn conversation this
    // cuts input-token cost ~10x for cached reads ($0.30/M vs $3/M on
    // Sonnet), 5-minute TTL while the session is active.
    //
    // Up to 4 breakpoints are allowed; we use 2: after the system, and
    // on the last history message. Other providers (OpenAI, Google)
    // silently ignore providerOptions.anthropic.
    const cacheControl = {
      anthropic: { cacheControl: { type: "ephemeral" as const } },
    };

    const historyMessages: ModelMessage[] = history.map<ModelMessage>((h, i) => {
      const isLast = i === history.length - 1;
      return {
        role: h.role,
        content: h.content,
        ...(isLast ? { providerOptions: cacheControl } : {}),
      };
    });

    const systemMessage: ModelMessage = {
      role: "system",
      content: system,
      providerOptions: cacheControl,
    };

    const messages: ModelMessage[] = [
      systemMessage,
      ...historyMessages,
      { role: "user", content: expandedMessage },
    ];

    const tools = buildTools(vault, tavilyKey);

    const result = streamText({
      model,
      messages,
      tools,
      stopWhen: stepCountIs(25),
      abortSignal,
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          if ("text" in part && typeof part.text === "string") {
            onEvent({ kind: "text", delta: part.text });
          }
          break;
        case "tool-call":
          onEvent({
            kind: "tool_use",
            id: part.toolCallId,
            name: part.toolName,
            input: part.input,
          });
          break;
        case "tool-result": {
          const output = (part as any).output;
          const text =
            typeof output === "string" ? output : JSON.stringify(output, null, 2);
          onEvent({ kind: "tool_result", id: part.toolCallId, result: text });
          break;
        }
        case "error": {
          const err = (part as any).error;
          onEvent({
            kind: "error",
            message: err?.message ?? String(err),
          });
          break;
        }
      }
    }

    const usage = await result.usage;
    if (usage) {
      const prompt = usage.inputTokens ?? 0;
      const completion = usage.outputTokens ?? 0;
      const cached = (usage as any).cachedInputTokens ?? 0;
      const context = prompt + cached;
      onEvent({
        kind: "done",
        usage: {
          prompt,
          completion,
          total: usage.totalTokens ?? prompt + completion + cached,
          context,
        },
      });
    } else {
      onEvent({ kind: "done" });
    }
  } catch (e: any) {
    onEvent({ kind: "error", message: e?.message ?? String(e) });
  }
}
