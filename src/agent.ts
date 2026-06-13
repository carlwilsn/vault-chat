import { streamText, generateText, stepCountIs, tool, type ModelMessage } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { buildModel, findModel, supportsVision, DEFAULT_MODEL_ID } from "./providers";
import { buildTools } from "./tools";
import { loadSkills, skillPromptIndex, expandSkillInvocation } from "./skills";
import { loadSessionContext } from "./context";
import { loadVaultSystemPrompt, loadVaultTools, loadVaultNorthStar, northStarPromptBlock, loadVaultMemoryIndex, vaultMemoryPromptBlock, loadVaultTelegramPrompt, loadVaultSupervisorPrompt, loadVaultAssistantPrompt } from "./meta";

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

// Compiled-in fallback for Telegram mode, used when a vault hasn't seeded
// (or the user emptied) `.vault-chat/agent/telegram.md`. The seeded file is
// the editable source of truth — kept in sync with defaults/telegram.md.
const FALLBACK_TELEGRAM = `Your reply will be sent to the user's phone via Telegram. Keep it short (1-3 sentences), plain text only — no markdown, headers, bullets, or code fences (they render as literal characters on Telegram). For images the user asks for, create the file with your tools and reference it as \`![caption](relative/path.png)\` — vault-chat uploads that as a real photo. Tool calls are fine; only your final reply text goes to Telegram. Delete any throwaway scratch files before replying.`;

// Compiled-in fallback for the phone cockpit, used when a vault hasn't seeded
// (or the user emptied) `.vault-chat/agent/assistant.md`. The seeded file is the
// editable source of truth — kept in sync with defaults/assistant.md. Distilled
// to the load-bearing behaviors; the full guidance lives in the seeded file.
const FALLBACK_ASSISTANT = `## Cockpit assistant\n\nYou are the light, conversational chat the user talks to on their phone. You answer, look things up, read/write this vault, take notes, set reminders. You do NOT grind long jobs here and you cannot spawn workers.\n\n- Talk like a person. A greeting gets a short human reply — never a status dump of what's running or what you read. Give a briefing only when asked, and keep it tight.\n- Read whose task it is: "walk me through / help me understand / I'm implementing" = coach and let them hold the pen; "do X for me / a task that'd take YOU 20 minutes / go research X" = own it yourself or propose a mission. Don't hand work back when they asked you to take it.\n- For substantial multi-part work, PROPOSE a mission: one framing line + a fenced \\\`plan\\\` block (a \`title:\` line, then one \`-\` bullet per parallel task). The app renders it as an Approve card; on approval the mission is created for you automatically — you do NOT call any tool to start it. Just propose and let them tap.\n- Don't claim you "started" something you only proposed, and don't narrate mission progress you haven't verified by reading its thread.`;

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

// --- Mid-run compaction ---------------------------------------------------
// A single agent turn runs up to 50 tool-call steps; the accumulated tool
// outputs grow the context until the provider rejects the request and the
// whole turn dies — which is what kills long / overnight runs. The AI SDK's
// prepareStep hook lets us rewrite the message list before each step, so
// when the running context crosses a threshold we summarize the older
// prefix into a single recap message and keep the recent turns verbatim.
// Guarded by the threshold so normal short turns are never touched, and
// fully fail-safe (any error → leave the messages alone), so the worst case
// is the pre-existing "dies at the limit" behavior, never something worse.
const MID_RUN_CONTEXT_LIMIT = 200_000;
const MID_RUN_COMPACT_AT = Math.floor(MID_RUN_CONTEXT_LIMIT * 0.75); // ~150k
const MID_RUN_KEEP_TAIL = 12;

// How many times a turn may auto-continue after hitting the per-call step
// cap (stepCountIs(50)) or an output-token cap before it stops on its own.
// 50 steps × (1 + 12) ≈ up to ~650 tool steps in one turn — enough for a
// genuinely long build/doc run — while still bounded so a degenerate loop
// can't run forever. The abort signal (Stop button) breaks out immediately.
const MAX_AUTO_CONTINUE = 12;

const MID_RUN_COMPACT_SYSTEM = `You compact the middle of a long, in-flight agent run so it can keep going with less context.

Preserve, in compressed form:
- The user's overall goal and any standing instructions
- File paths touched and decisions made about them
- Concrete facts/findings established, and the current state of the work
- What has been done so far and what still remains

Drop verbose tool outputs (file dumps, command output, listings) — keep only the conclusions. Output a tight recap (around 300-700 words) written so the agent can pick up mid-task without re-reading anything.`;

function estimateMessageTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    const c = (m as any).content;
    if (typeof c === "string") chars += c.length;
    else if (Array.isArray(c)) {
      for (const part of c) {
        chars += typeof part?.text === "string" ? part.text.length : JSON.stringify(part ?? "").length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

function flattenForSummary(messages: ModelMessage[]): string {
  return messages
    .map((m) => {
      const role = (m as any).role;
      const c = (m as any).content;
      let text: string;
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) {
        text = c
          .map((part: any) => {
            if (typeof part?.text === "string") return part.text;
            if (part?.type === "tool-call") return `[tool-call: ${part.toolName ?? "?"}]`;
            if (part?.type === "tool-result") {
              const out = part.output ?? part.result;
              const s = typeof out === "string" ? out : JSON.stringify(out ?? "");
              return `[tool-result: ${s.slice(0, 2000)}]`;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
      } else text = "";
      return `=== ${role} ===\n${text}`;
    })
    .join("\n\n");
}

// Index where the kept tail should begin: the first assistant message at or
// after (len - keepTail). Keeping the tail on an assistant boundary means no
// tool-result is orphaned from its tool-call, and the recap→tail handoff
// stays valid user/assistant alternation. null when there isn't a clean cut
// that leaves something to both summarize and keep.
function findTailCut(messages: ModelMessage[], keepTail: number): number | null {
  let cut = Math.max(1, messages.length - keepTail);
  while (cut < messages.length && (messages[cut] as any).role !== "assistant") cut++;
  if (cut <= 1 || cut >= messages.length) return null;
  return cut;
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
  telegramMode?: boolean;
  // Supervisor role WITHOUT the Telegram brevity contract — the always-on
  // orchestrator prompt used by mission threads (and the classic Telegram
  // channel). telegramMode implies it.
  supervisorMode?: boolean;
  // The interactive phone cockpit. A lighter, conversational role (proposes
  // missions via plan cards, doesn't orchestrate) — loads assistant.md instead
  // of the heavy supervisor.md. Takes precedence over supervisorMode (the
  // cockpit thread is role "supervisor" so supervisorMode is also set).
  cockpitMode?: boolean;
  conversationId?: string;
  isTelegramSourced?: boolean;
  reasoningEffort?: import("./store").ReasoningEffort;
}) {
  const { modelId, apiKey, vault, history, userMessage, userAttachments, onEvent, abortSignal, tavilyKey, strictVault, bashDisabled, voiceMode, telegramMode, supervisorMode, cockpitMode, conversationId, isTelegramSourced } = params;
  const reasoningEffort = params.reasoningEffort ?? "medium";

  try {
    const spec = findModel(modelId) ?? findModel(DEFAULT_MODEL_ID);
    if (!spec) throw new Error(`unknown model: ${modelId}`);
    const model = buildModel(spec, apiKey);

    const [sessionContext, skills, vaultSystem, vaultTools, northStar, memoryIndex, shellKind, vaultTelegram, vaultSupervisor, vaultAssistant] = await Promise.all([
      loadSessionContext(vault),
      loadSkills(vault),
      loadVaultSystemPrompt(vault),
      loadVaultTools(vault),
      loadVaultNorthStar(vault),
      loadVaultMemoryIndex(vault),
      getShellKind(),
      // Editable per-vault Telegram-mode prompt; only used when telegramMode
      // is on, but loaded here so the prompt assembly stays a single pass.
      telegramMode ? loadVaultTelegramPrompt(vault) : Promise.resolve(""),
      // The supervisor role layers an always-on orchestrator (persistent mind,
      // goal loop, worker steering) onto the agent. Loaded for telegramMode
      // (the classic phone channel) and mission threads (supervisorMode) — but
      // NOT the cockpit, which gets the lighter assistant prompt below.
      (telegramMode || supervisorMode) && !cockpitMode
        ? loadVaultSupervisorPrompt(vault)
        : Promise.resolve(""),
      // The lighter cockpit-assistant prompt for the interactive phone chat.
      cockpitMode ? loadVaultAssistantPrompt(vault) : Promise.resolve(""),
    ]);

    const { body: expandedMessage } = expandSkillInvocation(userMessage, skills);

    // Per-vault system prompt (synced cross-machine via git); fall back to
    // the built-in baseline if the vault hasn't been seeded yet.
    const baseSystem = vaultSystem.trim() || FALLBACK_SYSTEM;
    const customTools = { ...vaultTools };
    const customToolNames = Object.keys(customTools);

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
    const memoryBlock = vaultMemoryPromptBlock(memoryIndex);

    // Telegram-mode instructions come from the per-vault editable file
    // `.vault-chat/agent/telegram.md` (surfaced as the "Telegram" tab in the
    // agent-config modal, synced cross-machine via git), falling back to the
    // compiled-in baseline when the vault hasn't seeded it.
    const telegramNote = telegramMode
      ? `\n## Telegram mode\n\n${vaultTelegram.trim() || FALLBACK_TELEGRAM}`
      : "";

    // Supervisor role: an always-on orchestrator layered onto the Telegram /
    // mission agent. Applied for telegram + mission threads, but NOT the
    // cockpit (it gets the lighter assistant prompt below). A vault that
    // doesn't want a supervisor leaves the file empty and stays a plain agent.
    const supervisorNote =
      (telegramMode || supervisorMode) && !cockpitMode && vaultSupervisor.trim()
        ? `\n${vaultSupervisor.trim()}`
        : "";

    // Cockpit role: the lighter, conversational phone-chat prompt. Falls back
    // to the compiled-in baseline when the vault hasn't seeded assistant.md
    // (e.g. an existing vault on a fresh update, before the seed/git-sync runs)
    // so the cockpit is never left with no role at all.
    const assistantNote = cockpitMode
      ? `\n${vaultAssistant.trim() || FALLBACK_ASSISTANT}`
      : "";

    const system = [
      baseSystem,
      `\nVault root: ${vault}`,
      `\n${shellNote}`,
      northStarBlock ? `\n${northStarBlock}` : "",
      sessionContext ? `\n${sessionContext}` : "",
      memoryBlock ? `\n${memoryBlock}` : "",
      skills.length ? `\n${skillPromptIndex(skills)}` : "",
      customToolNames.length
        ? `\n## Custom tools\n\nThese tools were loaded in addition to the built-in set. They live in this vault at \`<vault>/.vault-chat/tools/\` and sync with it:\n${customToolNames
            .map((n) => `- ${n}`)
            .join("\n")}`
        : "",

      voiceNote,
      telegramNote,
      supervisorNote,
      assistantNote,
    ]
      .filter(Boolean)
      .join("\n");

    // Prompt caching (Anthropic): mark the system prompt and the prior
    // conversation prefix as cacheable. The current user turn is never
    // cached — it changes every call. On a 10-turn conversation this
    // cuts input-token cost ~10x for cached reads ($0.30/M vs $3/M on
    // Sonnet).
    //
    // Two TTL tiers:
    //  - systemCache (1h): the system prompt is stable for the whole
    //    session — vault path, north star, skills index, shell probe.
    //    Long debug sessions where the user steps away for 20 min
    //    otherwise re-bill this prefix on resume. The 1h write is 2x
    //    cost but pays for itself after one hit beyond the 5-min mark.
    //  - historyCache (5m, default): the breakpoint moves each turn
    //    (always on the last message). 1h here would just cost more
    //    to write without ever being read past one turn.
    //
    // Up to 4 breakpoints are allowed; we use 2: after the system, and
    // on the last history message. Other providers (OpenAI, Google)
    // silently ignore providerOptions.anthropic.
    const systemCache = {
      anthropic: { cacheControl: { type: "ephemeral" as const, ttl: "1h" as const } },
    };
    const historyCache = {
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
          ...(cacheable ? { providerOptions: historyCache } : {}),
        };
      });

    const systemMessage: ModelMessage = {
      role: "system",
      content: system,
      ...(system.trim().length > 0 ? { providerOptions: systemCache } : {}),
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

    // Which layer this thread sits in (assistant → missions → workers): the
    // toolset is hard-gated by it. Resolved from the conversation's source —
    // store first (hot path), disk as fallback for headless off-vault runs —
    // so every caller gets the right tools without wiring it through.
    let tier: "assistant" | "mission" | "worker" = "assistant";
    if (conversationId) {
      let src: string | undefined;
      try {
        const { useStore } = await import("./store");
        src = useStore.getState().conversations.find((c) => c.id === conversationId)?.source;
      } catch {
        /* store unavailable */
      }
      if (!src) {
        try {
          const { readConversations } = await import("./conversations");
          src = (await readConversations(vault)).find((c) => c.id === conversationId)?.source;
        } catch {
          /* default assistant */
        }
      }
      if (src === "mission") tier = "mission";
      else if (src === "worker") tier = "worker";
    }

    const builtinTools = buildTools(vault, {
      tavilyKey,
      strictVault: strictVault ?? false,
      bashDisabled: bashDisabled ?? false,
      conversationId,
      isTelegramSourced: isTelegramSourced ?? false,
      tier,
    });
    const innerTools = { ...builtinTools, ...customTools };

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
    // Reasoning / thinking hints. Each adapter takes a different shape;
    // all are driven by the user's reasoningEffort setting (low/medium/
    // high). Extended thinking on Claude 4.x, reasoning_effort on OpenAI's
    // reasoning families, thinkingConfig on Gemini 2.5. OpenRouter routes
    // through the OpenAI adapter, so the SAME reasoningEffort key reaches
    // GPT-5 / o-series via OpenRouter — it normalizes reasoning_effort to
    // the upstream. Used to be left off for OpenRouter entirely, which is
    // why a GPT-5.5-via-OpenRouter run silently ran at default (low) effort.
    const budgetForEffort = { low: 1024, medium: 3000, high: 12000 } as const;
    let providerOptions: ProviderOptions | undefined;
    if (spec.provider === "anthropic") {
      // Opus 4.7+ and the Fable/Mythos 5 tier use the new adaptive
      // reasoning API: thinking.type is "adaptive" and the budget is
      // controlled via output_config.effort instead of a raw token budget.
      // Older models (Opus 4.6, Sonnet 4.6, Haiku 4.5) still accept the
      // enabled+budgetTokens shape, and sending the new keys to them fails
      // — so branch. (Fable/Mythos ship after 4.8 and inherit its adaptive
      // API shape; revert this clause if their API ever diverges.)
      const isAdaptive = /^claude-(opus-4-(7|8)|fable-|mythos-)/i.test(spec.id);
      providerOptions = isAdaptive
        ? {
            anthropic: {
              thinking: { type: "adaptive" },
              output_config: { effort: reasoningEffort },
            },
          }
        : {
            anthropic: {
              thinking: { type: "enabled", budgetTokens: budgetForEffort[reasoningEffort] },
            },
          };
    } else if (
      (spec.provider === "openai" || spec.provider === "openrouter") &&
      // OpenAI reasoning families, by bare id (direct) or `openai/…`
      // (OpenRouter). gpt-5 / o1 / o3 / o4.
      /(^|\/)(o[134]|gpt-5)/i.test(spec.id)
    ) {
      providerOptions = { openai: { reasoningEffort } };
    } else if (
      spec.provider === "google" &&
      /^gemini-2\.5/i.test(spec.id)
    ) {
      providerOptions = {
        google: { thinkingConfig: { thinkingBudget: budgetForEffort[reasoningEffort] } },
      };
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
      | { ok: true; usage: any; finishReason?: string; responseMessages?: ModelMessage[] }
      | { ok: false; error: any; gotOutput: boolean };

    const attempt = async (msgs: ModelMessage[]): Promise<AttemptResult> => {
      let gotOutput = false;
      try {
        const result = streamText({
          model,
          messages: msgs,
          tools,
          stopWhen: stepCountIs(50),
          abortSignal,
          // Mid-run compaction: before each step, if the running context
          // has grown past the threshold, summarize the older prefix and
          // keep the recent turns so a long multi-step turn doesn't die at
          // the context limit. Threshold-guarded + fail-safe (see helpers).
          prepareStep: async ({ messages: stepMessages, steps }) => {
            try {
              const used =
                (steps?.[steps.length - 1]?.usage as any)?.totalTokens ??
                estimateMessageTokens(stepMessages as ModelMessage[]);
              if (used < MID_RUN_COMPACT_AT) return undefined;
              const msgs = stepMessages as ModelMessage[];
              const sys = (msgs[0] as any)?.role === "system" ? msgs[0] : null;
              const cut = findTailCut(msgs, MID_RUN_KEEP_TAIL);
              if (cut == null) return undefined;
              const prefix = msgs.slice(sys ? 1 : 0, cut);
              const tail = msgs.slice(cut);
              if (prefix.length === 0) return undefined;
              const summary = await generateText({
                model,
                system: MID_RUN_COMPACT_SYSTEM,
                prompt: `Summarize the work so far so the agent can continue seamlessly:\n\n${flattenForSummary(prefix)}`,
                abortSignal,
              });
              const recap: ModelMessage = {
                role: "user",
                content: `[Auto-compacted earlier context to stay within the model's window. Recap of the work so far:]\n\n${summary.text.trim()}`,
              };
              return { messages: sys ? [sys, recap, ...tail] : [recap, ...tail] };
            } catch {
              // Never let compaction break the run — fall back to the
              // unmodified messages (worst case: the limit, as before).
              return undefined;
            }
          },
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
        const finishReason = await result.finishReason;
        const responseMessages = (await result.response).messages as ModelMessage[];
        return { ok: true, usage, finishReason, responseMessages };
      } catch (e) {
        return { ok: false, error: e, gotOutput };
      }
    };

    // First try. If it fails before any token reaches the user AND the
    // failure looks transient (upstream blip, network hiccup), retry
    // exactly once after a short backoff. The user sees a brief pause
    // instead of an error toast for the common Anthropic flake.
    let runMessages = messages;
    let res = await attempt(runMessages);
    if (!res.ok && !res.gotOutput && isTransient(res.error)) {
      console.warn(
        "[agent] initial stream failed, retrying once:",
        res.error?.message ?? res.error,
      );
      await new Promise((r) => setTimeout(r, 1200));
      res = await attempt(runMessages);
    }

    // Auto-continue. The multi-step loop stops at the per-call step cap
    // (finishReason "tool-calls" — the model was still mid-tool-loop) or
    // when a single step hits the output-token cap ("length"). Both leave
    // the task UNFINISHED, and the turn used to just end silently — which
    // is why a long run "stopped for no reason" until the user typed
    // "Done?" to nudge it. Instead, feed the messages it generated back in
    // and keep going. Bounded by MAX_AUTO_CONTINUE and the abort signal so
    // it can't loop or run away; a natural finish ("stop") never continues.
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalCached = 0;
    const accumulate = (u: any) => {
      if (!u) return;
      totalPrompt += u.inputTokens ?? 0;
      totalCompletion += u.outputTokens ?? 0;
      totalCached += u.cachedInputTokens ?? 0;
    };
    let autoContinues = 0;
    if (res.ok) accumulate(res.usage);
    while (
      res.ok &&
      !abortSignal?.aborted &&
      (res.finishReason === "tool-calls" || res.finishReason === "length") &&
      autoContinues < MAX_AUTO_CONTINUE
    ) {
      autoContinues++;
      runMessages = [...runMessages, ...(res.responseMessages ?? [])];
      res = await attempt(runMessages);
      if (res.ok) accumulate(res.usage);
    }

    if (!res.ok) {
      onEvent({
        kind: "error",
        message: res.error?.message ?? String(res.error),
      });
      return;
    }

    // Report cumulative tokens across all continuations, but use the LAST
    // attempt's input+cached as the live context size (that's the window
    // actually in play now, after any mid-run compaction).
    const lastUsage = res.usage;
    if (lastUsage) {
      const lastInput = lastUsage.inputTokens ?? 0;
      const lastCached = (lastUsage as any).cachedInputTokens ?? 0;
      onEvent({
        kind: "done",
        usage: {
          prompt: totalPrompt,
          completion: totalCompletion,
          total: totalPrompt + totalCompletion + totalCached,
          context: lastInput + lastCached,
        },
      });
    } else {
      onEvent({ kind: "done" });
    }
  } catch (e: any) {
    onEvent({ kind: "error", message: e?.message ?? String(e) });
  }
}
