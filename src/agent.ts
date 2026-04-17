import { streamText, stepCountIs, type ModelMessage } from "ai";
import { buildModel, findModel, DEFAULT_MODEL_ID } from "./providers";
import { buildTools } from "./tools";
import { loadSkills, skillPromptIndex, expandSkillInvocation } from "./skills";
import { loadSessionContext } from "./context";
import { loadMetaSystemPrompt, loadMetaTools } from "./meta";

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

// Fallback baseline — used only if the meta vault's system.md is
// unreadable (missing or permission-denied). The real prompt lives in
// %APPDATA%/com.vault-chat.app/meta/system.md and is user-editable.
const FALLBACK_SYSTEM = `You are the runtime for a personal knowledge vault. Tools: Read, Write, Edit, Delete, Glob, Grep, Bash, ListDir, NotebookEdit, PdfExtract, TodoWrite, WebFetch, WebSearch. Use absolute paths. Render math with $$...$$.`;

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

    const [sessionContext, skills, metaSystem, metaTools] = await Promise.all([
      loadSessionContext(vault),
      loadSkills(vault),
      loadMetaSystemPrompt(),
      loadMetaTools(),
    ]);

    const { body: expandedMessage } = expandSkillInvocation(userMessage, skills);

    const baseSystem = metaSystem.trim() || FALLBACK_SYSTEM;
    const metaToolNames = Object.keys(metaTools);

    const system = [
      baseSystem,
      `\nVault root: ${vault}`,
      sessionContext ? `\n${sessionContext}` : "",
      skills.length ? `\n${skillPromptIndex(skills)}` : "",
      metaToolNames.length
        ? `\n## Meta-vault tools\n\nThese tools were loaded from the meta vault and are available in addition to the built-in set:\n${metaToolNames.map((n) => `- ${n}`).join("\n")}`
        : "",
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

    const builtinTools = buildTools(vault, tavilyKey);
    const tools = { ...builtinTools, ...metaTools };

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
