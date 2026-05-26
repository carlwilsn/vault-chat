import { streamText, stepCountIs, tool, type ModelMessage } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { buildModel, findModel, supportsVision, DEFAULT_MODEL_ID } from "./providers";
import { buildTools } from "./tools";
import { loadSkills, skillPromptIndex, expandSkillInvocation } from "./skills";
import { loadSessionContext } from "./context";
import { loadMetaSystemPrompt, loadMetaTools, getMetaVaultPath, loadVaultNorthStar, northStarPromptBlock } from "./meta";

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
  | { kind: "tool_input_start"; id: string; name: string }
  | { kind: "tool_input_delta"; id: string; delta: string }
  | { kind: "tool_use"; id: string; name: string; input: any }
  | { kind: "tool_result"; id: string; result: string }
  | { kind: "done"; usage?: TokenUsage }
  | { kind: "error"; message: string };

export type ChatTurn = { role: "user" | "assistant"; content: string };

// Fallback baseline — used only if the meta vault's system.md is
// unreadable (missing or permission-denied). The real prompt lives in
// %APPDATA%/com.vault-chat.app/meta/system.md and is user-editable.
const FALLBACK_SYSTEM = `You are the runtime for a personal knowledge vault. Tools: Read, Write, Edit, Delete, Glob, Grep, Bash, ListDir, NotebookEdit, PdfExtract, PdfPageSnapshot, TodoWrite, WebFetch, WebSearch, ListNotes, ResolveNote, ReopenNote, CreateNote. Use absolute paths. Render math with $$...$$.

The user keeps a scratchpad of notes at <vault>/.vault-chat/notes.jsonl — quick thoughts they flagged while working. Call ListNotes when they ask about their notes, what they've flagged, what's open, etc. When a conversation actually addresses an open note, call ResolveNote to close it. When you notice something the user will want to revisit, offer to CreateNote it for them.`;

function detectPlatform(): "windows" | "mac" | "linux" {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  if (/windows/i.test(ua)) return "windows";
  if (/mac/i.test(ua)) return "mac";
  return "linux";
}

// Probe the actual shell the Rust bash_exec command will use, once,
// and reuse forever. On Windows this differs from the user's terminal:
// the agent's Bash tool uses Git Bash if installed (POSIX commands
// work), and only falls back to `cmd /C` when Git for Windows is
// missing. The system prompt needs the truth so the agent doesn't
// reach for cmd-style syntax inside a POSIX shell or vice versa.
type ShellKind = { kind: "git-bash" | "cmd" | "bash"; path: string | null };
let shellKindPromise: Promise<ShellKind> | null = null;
function getShellKind(): Promise<ShellKind> {
  if (!shellKindPromise) {
    shellKindPromise = invoke<ShellKind>("bash_shell_kind").catch(() => ({
      kind: "bash" as const,
      path: null,
    }));
  }
  return shellKindPromise;
}

export async function runAgent(params: {
  modelId: string;
  apiKey: string;
  vault: string;
  history: ChatTurn[];
  userMessage: string;
  userAttachments?: import("./store").ChatAttachment[];
  onEvent: (e: StreamEvent) => void;
  abortSignal?: AbortSignal;
  tavilyKey?: string;
  strictVault?: boolean;
  bashDisabled?: boolean;
  voiceMode?: boolean;
}) {
  const { modelId, apiKey, vault, history, userMessage, userAttachments, onEvent, abortSignal, tavilyKey, strictVault, bashDisabled, voiceMode } = params;

  try {
    const spec = findModel(modelId) ?? findModel(DEFAULT_MODEL_ID);
    if (!spec) throw new Error(`unknown model: ${modelId}`);
    const model = buildModel(spec, apiKey);

    const [sessionContext, skills, metaSystem, metaTools, metaPath, northStar, shellKind] = await Promise.all([
      loadSessionContext(vault),
      loadSkills(vault),
      loadMetaSystemPrompt(),
      loadMetaTools(),
      getMetaVaultPath().catch(() => null),
      loadVaultNorthStar(vault),
      getShellKind(),
    ]);

    const { body: expandedMessage } = expandSkillInvocation(userMessage, skills);

    const baseSystem = metaSystem.trim() || FALLBACK_SYSTEM;
    const metaToolNames = Object.keys(metaTools);

    const platform = detectPlatform();
    // Windows splits two ways now. Git Bash (when installed) gives you
    // a real POSIX shell; cmd is the legacy fallback for stripped-down
    // installs. Tell the agent which it actually has so commands match.
    const shellNote =
      platform === "windows"
        ? shellKind.kind === "git-bash"
          ? "Host OS: Windows. The Bash tool runs commands via Git Bash (`bash -c`) — use POSIX shell syntax (`ls`, `head`, `grep`, single-quoted strings, `$VAR`). Paths under the user's home are reachable via either `C:/Users/...` or `/c/Users/...` — both work. Avoid `cmd`-only constructs (`dir`, `&&` chained with `if not exist`, `%VAR%`)."
          : "Host OS: Windows. The Bash tool runs commands via `cmd /C` — use Windows-compatible syntax. For the current date use `date /T` (plain `date` is interactive and will hang). For the time use `time /T`. Be sparing with embedded quotes — cmd's quoting rules are unforgiving; prefer one short command per call over long pipelines."
        : platform === "mac"
          ? "Host OS: macOS. The Bash tool runs commands via `bash -lc`."
          : "Host OS: Linux. The Bash tool runs commands via `bash -lc`.";

    const voiceNote = voiceMode
      ? `\n## Voice mode\n\nThe user is speaking to you and listening to your replies via text-to-speech. Your output IS audio.\n\n- Keep replies short and conversational — like talking to a friend, not writing a doc. A few sentences usually beats paragraphs.\n- Plain prose only: no markdown formatting (no \`**bold**\`, \`*italic*\`, \`#\` headers, \`-\` bullets, code fences) for spoken content. They get pronounced literally and sound bad.\n- No emoji.\n- "Read this to me" / "what does this say" means: call Read (or PdfExtract for PDFs), then speak the content as natural prose. You CAN read content aloud — your text becomes audio. Don't say "I can't do audio."\n- If the user is following along with a document (the active-file context will be included on their turn), assume their question is about that document unless they say otherwise.\n- For things that genuinely need visual presentation (long code, big tables), say so briefly and write to a file with Write — don't dump the raw content into the voice channel.`
      : "";

    const northStarBlock = northStarPromptBlock(northStar);

    const system = [
      baseSystem,
      `\nVault root: ${vault}`,
      `\n${shellNote}`,
      northStarBlock ? `\n${northStarBlock}` : "",
      sessionContext ? `\n${sessionContext}` : "",
      skills.length ? `\n${skillPromptIndex(skills)}` : "",
      metaToolNames.length
        ? `\n## Meta-vault tools\n\nThese tools were loaded from the meta vault and are available in addition to the built-in set:\n${metaToolNames.map((n) => `- ${n}`).join("\n")}`
        : "",
      voiceNote,
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

    // Anthropic rejects cache_control on empty text blocks ("cannot be
    // set for empty text blocks"). A cancelled stream can leave an
    // empty assistant turn at the tail of history; an unconfigured
    // system prompt can also be "". Only stamp the cacheControl
    // breakpoint on a content block that actually has text.
    const historyMessages: ModelMessage[] = history
      .filter((h) => h.content.trim().length > 0)
      .map<ModelMessage>((h, i, arr) => {
        const isLast = i === arr.length - 1;
        const scrubbed = scrub(h.content);
        const cacheable = isLast && scrubbed.trim().length > 0;
        return {
          role: h.role,
          content: scrubbed,
          ...(cacheable ? { providerOptions: cacheControl } : {}),
        };
      });

    const systemMessage: ModelMessage = {
      role: "system",
      content: system,
      ...(system.trim().length > 0 ? { providerOptions: cacheControl } : {}),
    };

    // Attach captured images to the final user turn as structured
    // content so vision-capable models see them. Non-vision models
    // would have the images stripped upstream by the scrub pass, but
    // these are IMAGE parts not markdown — we gate by supportsVision.
    const finalUserText = scrub(expandedMessage);
    const attachableImages = vision ? userAttachments ?? [] : [];
    const safeUserText = finalUserText.trim() ? finalUserText : "(no message text)";
    const finalUserMessage: ModelMessage =
      attachableImages.length > 0
        ? {
            role: "user",
            content: [
              { type: "text", text: safeUserText },
              ...attachableImages.flatMap((a) => {
                const src = a.sourcePath ? a.sourcePath.split("/").pop() : null;
                const headParts: string[] = [];
                headParts.push(
                  src
                    ? `Captured region from ${src}${a.sourceAnchor ? ` (${a.sourceAnchor})` : ""}`
                    : "Captured region",
                );
                if (a.capturedFilePath) {
                  // Surface the on-disk vault-relative path so the agent
                  // can reference this image in tool calls — e.g. write a
                  // markdown file that embeds it via
                  // ![cap](.vault-chat/captures/foo.png). The file exists
                  // for the rest of this session; if the user doesn't act
                  // on it, the next app-start sweep prunes it.
                  headParts.push(
                    `saved at ${a.capturedFilePath} (vault-relative — reference this path in a markdown image link if the user asks for one)`,
                  );
                }
                const caption = headParts.join("; ") + ":";
                return [
                  { type: "text" as const, text: caption },
                  { type: "image" as const, image: new URL(a.imageDataUrl) },
                ];
              }),
            ],
          }
        : { role: "user", content: safeUserText };

    const messages: ModelMessage[] = [
      systemMessage,
      ...historyMessages,
      finalUserMessage,
    ];

    const builtinTools = buildTools(vault, {
      metaPath,
      tavilyKey,
      strictVault: strictVault ?? false,
      bashDisabled: bashDisabled ?? false,
    });
    const innerTools = { ...builtinTools, ...metaTools };

    // Agent: delegate a self-contained sub-task to a sub-call with
    // isolated context. The sub-agent shares the model + tool set
    // (minus Agent itself, to prevent unbounded recursion) but starts
    // from a fresh conversation, so it can read 30 files without
    // bloating the main agent's working context. Returns the
    // sub-agent's final assistant text as a single string. The
    // caller's chat UI sees this as one tool call with one result —
    // intermediate sub-agent steps are not surfaced.
    const subAgentTool = tool({
      description:
        "Delegate a self-contained sub-task to a sub-agent. The sub-agent has its own fresh context and the same tool set (minus Agent itself). " +
        "Use this when (a) the work would otherwise read 10+ files and burn the main context, (b) the user wants a synthesized answer rather than a play-by-play, or (c) you want to map a large codebase or do parallel research. " +
        "Do NOT use Agent for single tool calls you could do directly, or for tasks where the user needs to see/review each step. " +
        "The `prompt` field MUST be self-contained — the sub-agent has zero memory of this conversation. Include every file path, every constraint, and the exact form of answer you want back.",
      inputSchema: z.object({
        description: z.string().describe("3-5 word task description (shown in the UI)."),
        prompt: z
          .string()
          .describe(
            "Self-contained prompt for the sub-agent. Include the question, the relevant context, and what shape of answer to return.",
          ),
      }),
      execute: async ({ prompt: subPrompt }) => {
        const subSystem = `You are a sub-agent spawned by the main vault agent.

Your job is one focused task. Return a tight synthesis — no preamble, no closing summary, no offers to do more. The caller is another agent, not the user.

You have full read/write tool access to the user's vault.
Vault root: ${vault}
${shellNote}

Be terse. If the task is research, return findings as a structured list with file:line citations. If the task is a code change, make the change and return what you did + the affected files.`;
        try {
          const subResult = streamText({
            model,
            messages: [
              { role: "system", content: subSystem },
              { role: "user", content: subPrompt },
            ],
            tools: innerTools,
            stopWhen: stepCountIs(30),
            abortSignal,
          });
          let final = "";
          for await (const part of subResult.fullStream) {
            if (part.type === "text-delta" && "text" in part && typeof part.text === "string") {
              final += part.text;
              onEvent({ kind: "text", delta: part.text });
            } else if (part.type === "tool-input-start") {
              onEvent({ kind: "tool_input_start", id: (part as any).id, name: (part as any).toolName });
            } else if (part.type === "tool-input-delta") {
              const delta = (part as any).delta;
              if (typeof delta === "string" && delta.length > 0) {
                onEvent({ kind: "tool_input_delta", id: (part as any).id, delta });
              }
            } else if (part.type === "tool-call") {
              onEvent({ kind: "tool_use", id: (part as any).toolCallId, name: (part as any).toolName, input: (part as any).input });
            } else if (part.type === "tool-result") {
              const output = (part as any).output;
              const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
              onEvent({ kind: "tool_result", id: (part as any).toolCallId, result: text });
            }
          }
          return final.trim() || "(sub-agent returned no output)";
        } catch (e: any) {
          return `Sub-agent failed: ${e?.message ?? String(e)}`;
        }
      },
    });

    const tools = { ...innerTools, Agent: subAgentTool };

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

    // Detect failures that are safe to retry. Conservative — only the
     // shapes we've actually seen for transient upstream blips:
     // - browser-level "Failed to fetch" (network couldn't reach the API)
     // - Vercel AI SDK's "No output generated" (stream returned nothing)
     // - explicit 5xx markers and known "overloaded" / network strings.
     // We intentionally do NOT retry on 4xx, auth errors, or anything
     // that mentions the prompt — those won't fix themselves.
    const isTransient = (err: any): boolean => {
      const msg = String(err?.message ?? err ?? "").toLowerCase();
      if (!msg) return false;
      return (
        msg.includes("failed to fetch") ||
        msg.includes("no output generated") ||
        msg.includes("network") ||
        msg.includes("econnreset") ||
        msg.includes("etimedout") ||
        msg.includes("socket hang up") ||
        msg.includes("overloaded") ||
        / 5\d\d\b/.test(msg)
      );
    };

    // Single attempt at the stream. Returns whether anything user-visible
    // was emitted (`gotOutput`) so the caller can decide if a retry is
    // safe — retrying after tokens have been delivered would double-emit.
    type AttemptResult =
      | { ok: true; usage: any }
      | { ok: false; error: any; gotOutput: boolean };

    const attempt = async (): Promise<AttemptResult> => {
      let gotOutput = false;
      try {
        const result = streamText({
          model,
          messages,
          tools,
          stopWhen: stepCountIs(50),
          abortSignal,
          ...(providerOptions ? { providerOptions } : {}),
        });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              if ("text" in part && typeof part.text === "string") {
                gotOutput = true;
                onEvent({ kind: "text", delta: part.text });
              }
              break;
            case "reasoning-start":
              gotOutput = true;
              onEvent({ kind: "reasoning_start" });
              break;
            case "reasoning-delta":
              if ("text" in part && typeof part.text === "string") {
                gotOutput = true;
                onEvent({ kind: "reasoning", delta: part.text });
              }
              break;
            case "tool-input-start":
              gotOutput = true;
              onEvent({
                kind: "tool_input_start",
                id: part.id,
                name: (part as any).toolName,
              });
              break;
            case "tool-input-delta": {
              const delta = (part as any).delta;
              if (typeof delta === "string" && delta.length > 0) {
                gotOutput = true;
                onEvent({ kind: "tool_input_delta", id: (part as any).id, delta });
              }
              break;
            }
            case "tool-call":
              gotOutput = true;
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
              // Mid-stream SDK error event. Surface as a structured
              // attempt failure so the outer loop can decide whether to
              // retry (safe only if nothing was emitted yet).
              return { ok: false, error: (part as any).error, gotOutput };
            }
          }
        }

        const usage = await result.usage;
        return { ok: true, usage };
      } catch (e) {
        return { ok: false, error: e, gotOutput };
      }
    };

    // First try. If it fails before any token reaches the user AND the
    // failure looks transient (upstream blip, network hiccup), retry
    // exactly once after a short backoff. The user sees a brief pause
    // instead of an error toast for the common Anthropic flake.
    let res = await attempt();
    if (!res.ok && !res.gotOutput && isTransient(res.error)) {
      console.warn(
        "[agent] initial stream failed, retrying once:",
        res.error?.message ?? res.error,
      );
      await new Promise((r) => setTimeout(r, 1200));
      res = await attempt();
    }

    if (!res.ok) {
      onEvent({
        kind: "error",
        message: res.error?.message ?? String(res.error),
      });
      return;
    }

    const usage = res.usage;
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
