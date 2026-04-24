import { streamText, stepCountIs, type ModelMessage } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { buildModel, findModel, supportsVision, DEFAULT_MODEL_ID } from "./providers";
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
  | { kind: "reasoning"; delta: string }
  | { kind: "reasoning_start" }
  | { kind: "tool_use"; id: string; name: string; input: any }
  | { kind: "tool_result"; id: string; result: string }
  | { kind: "done"; usage?: TokenUsage }
  | { kind: "error"; message: string };

export type ChatTurn = { role: "user" | "assistant"; content: string };

// Fallback baseline — used only if the meta vault's system.md is
// unreadable (missing or permission-denied). The real prompt lives in
// %APPDATA%/com.vault-chat.app/meta/system.md and is user-editable.
const FALLBACK_SYSTEM = `You are the runtime for a personal knowledge vault. Tools: Read, Write, Edit, Delete, Glob, Grep, Bash, ListDir, NotebookEdit, PdfExtract, TodoWrite, WebFetch, WebSearch, ListNotes, ResolveNote, ReopenNote, CreateNote. Use absolute paths. Render math with $$...$$.

The user keeps a scratchpad of notes at <vault>/.vault-chat/notes.jsonl — quick thoughts they flagged while working. Call ListNotes when they ask about their notes, what they've flagged, what's open, etc. When a conversation actually addresses an open note, call ResolveNote to close it. When you notice something the user will want to revisit, offer to CreateNote it for them.`;

function detectPlatform(): "windows" | "mac" | "linux" {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  if (/windows/i.test(ua)) return "windows";
  if (/mac/i.test(ua)) return "mac";
  return "linux";
}

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

    const platform = detectPlatform();
    const shellNote =
      platform === "windows"
        ? "Host OS: Windows. The Bash tool runs commands via `cmd /C` — use Windows-compatible syntax. For the current date use `date /T` (plain `date` is interactive and will hang). For the time use `time /T`. Prefer PowerShell one-liners via `powershell -NoProfile -Command \"...\"` when you need Unix-y behavior."
        : platform === "mac"
          ? "Host OS: macOS. The Bash tool runs commands via `bash -lc`."
          : "Host OS: Linux. The Bash tool runs commands via `bash -lc`.";

    const system = [
      baseSystem,
      `\nVault root: ${vault}`,
      `\n${shellNote}`,
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

    // If the active model can't take images, scrub markdown data:image
    // embeds from every turn before they hit the adapter — OpenRouter
    // otherwise bounces the request with "No endpoints found that
    // support image input" for text-only upstreams like Qwen3-235B.
    const vision = supportsVision(spec);
    const scrub = (s: string) =>
      vision
        ? s
        : s.replace(
            /!\[[^\]]*\]\(data:image\/[^)]+\)/g,
            "[image omitted — current model does not support vision]",
          );

    const historyMessages: ModelMessage[] = history.map<ModelMessage>((h, i) => {
      const isLast = i === history.length - 1;
      return {
        role: h.role,
        content: scrub(h.content),
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
      { role: "user", content: scrub(expandedMessage) },
    ];

    const builtinTools = buildTools(vault, tavilyKey);
    const tools = { ...builtinTools, ...metaTools };

    // Reasoning hints per provider. Each SDK takes a different shape,
    // so we branch on spec.provider and construct just the block the
    // active adapter understands. Extra keys are ignored by adapters
    // that don't recognize them, but we keep the object minimal anyway.
    // Reasoning / thinking hints. Each adapter takes a different shape.
    // Extended thinking on Claude 4.x, reasoningEffort on OpenAI's
    // reasoning families, thinkingConfig on Gemini 2.5. OpenRouter has
    // no universal flag — left off by default.
    let providerOptions: ProviderOptions | undefined;
    if (spec.provider === "anthropic") {
      // Opus 4.7+ uses the new adaptive reasoning API: thinking.type
      // is "adaptive" and the budget is controlled via output_config.
      // effort instead of a raw token budget. Older models (Opus 4.6,
      // Sonnet 4.6, Haiku 4.5) still accept the enabled+budgetTokens
      // shape, and sending the new keys to them fails — so branch.
      const isAdaptive = /^claude-opus-4-7/i.test(spec.id);
      providerOptions = isAdaptive
        ? {
            anthropic: {
              thinking: { type: "adaptive" },
              output_config: { effort: "medium" },
            },
          }
        : {
            anthropic: { thinking: { type: "enabled", budgetTokens: 3000 } },
          };
    } else if (spec.provider === "openai" && /^(o1|o3|o4|gpt-5)/i.test(spec.id)) {
      providerOptions = { openai: { reasoningEffort: "medium" } };
    } else if (spec.provider === "google" && /^gemini-2\.5/i.test(spec.id)) {
      providerOptions = { google: { thinkingConfig: { thinkingBudget: 3000 } } };
    }

    const result = streamText({
      model,
      messages,
      tools,
      stopWhen: stepCountIs(25),
      abortSignal,
      ...(providerOptions ? { providerOptions } : {}),
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          if ("text" in part && typeof part.text === "string") {
            onEvent({ kind: "text", delta: part.text });
          }
          break;
        case "reasoning-start":
          onEvent({ kind: "reasoning_start" });
          break;
        case "reasoning-delta":
          if ("text" in part && typeof part.text === "string") {
            onEvent({ kind: "reasoning", delta: part.text });
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
        case "tool-error": {
          const err = (part as any).error;
          const msg = err?.message ?? String(err);
          console.error(`[agent] tool-error id=${part.toolCallId}:`, err);
          onEvent({
            kind: "tool_result",
            id: part.toolCallId,
            result: `ERROR: ${msg}`,
          });
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
