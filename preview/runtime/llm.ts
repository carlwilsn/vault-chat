// The fake model providers. Every model call the app makes goes through
// `fetch` (the AI SDK in the webview), so the network guard hands these
// requests here and they are answered from the scenario's scripts — never the
// network, never a real key.
//
// Wire formats served:
//   • OpenRouter / OpenAI Chat Completions — SSE `chat.completion.chunk`s or a
//     JSON `chat.completion` (generateText/generateObject).
//   • Anthropic Messages — SSE (thinking, text, tool_use blocks) or JSON.
//   • The model-list endpoints (OpenRouter's from the saved public catalog).
//
// A script is picked by matching the newest real user message (or the system
// prompt) and walked one step per model call: the step index is the number of
// assistant turns after that user message, so a multi-step tool chain needs
// no state of its own.

import catalog from "../fixtures/synthetic/openrouter-models.json";

export type ToolCallSpec = { name: string; args: Record<string, unknown> };
export type Step = {
  reasoning?: string;
  text?: string;
  tools?: ToolCallSpec[];
  /** HTTP error instead of a stream. */
  error?: { status: number; message: string };
  /** Fail mid-stream after the text so far (connection drop). */
  dropAfterText?: boolean;
  /** Keep the stream open (a "running" state) until __preview.release(). */
  hold?: boolean;
  /** ms between chunks (default from the scenario, else 18). */
  chunkMs?: number;
  /** Extra prompt tokens on top of the request's own size (context dial). */
  promptPad?: number;
  /** Share of the prompt reported as served from the provider's prompt cache
   *  (OpenRouter `prompt_tokens_details.cached_tokens`, Anthropic
   *  `cache_read_input_tokens`), like a real cached long chat. */
  cachedFraction?: number;
};
export type Script = {
  id: string;
  /** Matched against the newest real user message text. */
  match?: RegExp;
  /** Matched against the system prompt instead. */
  system?: RegExp;
  steps: Step[];
};
export type LlmConfig = {
  scripts?: Script[];
  chunkMs?: number;
  /** Added to every reported prompt size (the context dial reads this). */
  promptPad?: number;
  /** Default Step.cachedFraction for every call. */
  cachedFraction?: number;
};

let config: LlmConfig = {};
let vaultPath = "";
/** Tool args may say "{vault}/…"; the model sees absolute paths, like the real agent uses. */
export function setLlmVault(v: string): void {
  vaultPath = v;
}
function withVault<T>(x: T): T {
  return JSON.parse(JSON.stringify(x).replace(/\{vault\}/g, vaultPath));
}
const holds = new Set<() => void>();
export const llmLog: Array<{ at: number; url: string; model: string; script: string; step: number; stream: boolean }> = [];

export function setLlmConfig(c: LlmConfig): void {
  config = c ?? {};
}
export function releaseHolds(): number {
  const n = holds.size;
  for (const r of [...holds]) r();
  holds.clear();
  return n;
}

// ---------------------------------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p: any) => (p?.type === "text" ? p.text : p?.type === "tool_result" ? "" : ""))
      .join("\n");
  return "";
}

type Parsed = {
  provider: "openai-chat" | "anthropic";
  model: string;
  stream: boolean;
  system: string;
  lastUser: string;
  stepIndex: number;
  approxPromptTokens: number;
  hasTools: boolean;
  wantsJson: boolean;
};

function parseOpenAI(body: any): Parsed {
  const msgs: any[] = Array.isArray(body.messages) ? body.messages : [];
  const system = msgs.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { lastUserIdx = i; break; }
  const stepIndex = msgs.slice(lastUserIdx + 1).filter((m) => m.role === "assistant").length;
  return {
    provider: "openai-chat",
    model: String(body.model ?? ""),
    stream: !!body.stream,
    system,
    lastUser: lastUserIdx >= 0 ? textOf(msgs[lastUserIdx].content) : "",
    stepIndex,
    approxPromptTokens: Math.round(JSON.stringify(msgs).length / 3.8),
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
    wantsJson: !!body.response_format && body.response_format.type !== "text",
  };
}

function parseAnthropic(body: any): Parsed {
  const msgs: any[] = Array.isArray(body.messages) ? body.messages : [];
  const isReal = (m: any) =>
    m.role === "user" &&
    (typeof m.content === "string" || (Array.isArray(m.content) && m.content.some((p: any) => p.type !== "tool_result")));
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (isReal(msgs[i])) { lastUserIdx = i; break; }
  const system = Array.isArray(body.system) ? body.system.map((b: any) => b.text ?? "").join("\n") : String(body.system ?? "");
  return {
    provider: "anthropic",
    model: String(body.model ?? ""),
    stream: !!body.stream,
    system,
    lastUser: lastUserIdx >= 0 ? textOf(msgs[lastUserIdx].content) : "",
    stepIndex: msgs.slice(lastUserIdx + 1).filter((m) => m.role === "assistant").length,
    approxPromptTokens: Math.round((JSON.stringify(msgs).length + system.length) / 3.8),
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
    wantsJson: false,
  };
}

// ---- fallbacks: what the fake says when no script matches --------------------

function fallbackSteps(p: Parsed): { id: string; steps: Step[] } {
  const sys = p.system;
  if (/compact a long agent conversation/i.test(sys) || /^Compact this conversation/m.test(p.lastUser))
    return {
      id: "fallback:compaction",
      steps: [
        {
          text:
            "## Summary so far\n\nThe user is working through their notes on spectral methods and the BitNet reproduction. " +
            "Established: the 160M runs are stable across three seeds (eval loss 1.559 ± 0.001); the remaining gap is a token-count " +
            "decision. Files touched: `notes/spectral-clustering.md`, `projects/bitnet/writeup.md`. Open: re-fit the cosine schedule for 3.2B tokens.",
        },
      ],
    };
  if (/estimate how long|seconds/i.test(sys) && /Command:/i.test(p.lastUser)) return { id: "fallback:eta", steps: [{ text: "3" }] };
  if (/inline editor/i.test(sys)) {
    const sel = /SELECTION:\n([\s\S]*?)\nBEFORE \(/.exec(p.lastUser)?.[1] ?? "";
    const instr = /INSTRUCTION:\n([\s\S]*?)\n(?:SELECTION|FILE_LANGUAGE)/.exec(p.lastUser)?.[1]?.trim() ?? "";
    const base = sel && !sel.startsWith("(empty") ? sel.trim() : "";
    const out = base
      ? base.replace(/\s+/g, " ").replace(/^./, (c) => c.toUpperCase())
      : `<!-- preview: inserted for “${instr}” -->`;
    return { id: "fallback:inline-edit", steps: [{ text: out }] };
  }
  if (p.wantsJson) return { id: "fallback:json", steps: [{ text: "{}" }] };
  if (!p.stream)
    return { id: "fallback:text", steps: [{ text: "Preview summary: nothing notable." }] };
  const q = p.lastUser.trim().split("\n").pop()?.slice(0, 140) ?? "";
  return {
    id: "fallback:chat",
    steps: [
      {
        text:
          `This is the preview's scripted model (no network). You asked: “${q}”.\n\n` +
          "No script in this scenario matches that message, so this generic reply streams instead. " +
          "Pick a scenario in the harness to see a scripted conversation with tools, reasoning and errors.",
      },
    ],
  };
}

function pick(p: Parsed): { id: string; step: Step; index: number } {
  for (const s of config.scripts ?? []) {
    const hit = (s.match && s.match.test(p.lastUser)) || (s.system && s.system.test(p.system));
    if (!hit) continue;
    if (p.stepIndex < s.steps.length) return { id: s.id, step: s.steps[p.stepIndex], index: p.stepIndex };
    return { id: s.id, step: { text: "" }, index: p.stepIndex };
  }
  const fb = fallbackSteps(p);
  const i = Math.min(p.stepIndex, fb.steps.length - 1);
  return { id: fb.id, step: p.stepIndex < fb.steps.length ? fb.steps[i] : { text: "" }, index: p.stepIndex };
}

// ---- streaming helpers -------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chunksOf(s: string): string[] {
  // Word-ish chunks like a real model stream (2–4 chars to a few words).
  const out: string[] = [];
  const re = /\s*\S+\s*/g;
  let m: RegExpExecArray | null;
  let buf = "";
  while ((m = re.exec(s))) {
    buf += m[0];
    if (buf.length > 6 || Math.random() < 0.4) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf) out.push(buf);
  if (!out.length && s) out.push(s);
  return out;
}

function sseResponse(gen: (send: (obj: unknown, event?: string) => void) => Promise<void>, signal?: AbortSignal): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown, event?: string) => {
        if (closed) return;
        const head = event ? `event: ${event}\n` : "";
        controller.enqueue(enc.encode(`${head}data: ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n\n`));
      };
      signal?.addEventListener("abort", () => {
        if (closed) return;
        closed = true;
        try {
          controller.error(new DOMException("The user aborted a request.", "AbortError"));
        } catch {
          /* already closed */
        }
      });
      try {
        await gen(send);
        if (!closed) {
          closed = true;
          controller.close();
        }
      } catch (e) {
        if (!closed) {
          closed = true;
          controller.error(e);
        }
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function holdIfAsked(step: Step, signal?: AbortSignal): Promise<void> {
  if (!step.hold) return;
  await new Promise<void>((resolve) => {
    const r = () => resolve();
    holds.add(r);
    signal?.addEventListener("abort", () => {
      holds.delete(r);
      resolve();
    });
  });
}

function usageFor(p: Parsed, step: Step, completion: number) {
  const prompt = p.approxPromptTokens + (config.promptPad ?? 0) + (step.promptPad ?? 0);
  const cached = Math.round(prompt * Math.min(1, Math.max(0, step.cachedFraction ?? config.cachedFraction ?? 0)));
  return { prompt, cached, completion: Math.max(1, completion) };
}

let idSeq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

// ---- OpenAI-compatible (OpenRouter) ------------------------------------------

async function serveOpenAI(p: Parsed, step: Step, signal?: AbortSignal): Promise<Response> {
  if (step.error)
    return new Response(JSON.stringify({ error: { message: step.error.message, code: step.error.status } }), {
      status: step.error.status,
      headers: { "content-type": "application/json" },
    });
  const id = newId("gen-preview-");
  const created = Math.floor(Date.now() / 1000);
  const model = p.model || "preview/model";
  const text = step.text ?? "";
  const tools = withVault(step.tools ?? []);
  const u = usageFor(p, step, Math.round((text.length + JSON.stringify(tools).length) / 4));
  const usage = {
    prompt_tokens: u.prompt,
    completion_tokens: u.completion,
    total_tokens: u.prompt + u.completion,
    ...(u.cached ? { prompt_tokens_details: { cached_tokens: u.cached } } : {}),
    cost: +(u.prompt * 2e-6 + u.completion * 1e-5).toFixed(6),
  };
  if (!p.stream) {
    const message: any = { role: "assistant", content: text };
    if (tools.length)
      message.tool_calls = tools.map((t, i) => ({
        id: `call_${id}_${i}`,
        type: "function",
        function: { name: t.name, arguments: JSON.stringify(t.args) },
      }));
    return new Response(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message, finish_reason: tools.length ? "tool_calls" : "stop" }],
        usage,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  const ms = step.chunkMs ?? config.chunkMs ?? 18;
  return sseResponse(async (send) => {
    const chunk = (delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}) =>
      send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
    chunk({ role: "assistant", content: "" });
    // OpenRouter streams reasoning as delta.reasoning; today's app (AI SDK
    // openai-chat adapter) drops it — sent anyway so the preview is faithful.
    if (step.reasoning) for (const c of chunksOf(step.reasoning)) { chunk({ reasoning: c }); await sleep(ms); }
    for (const c of chunksOf(text)) {
      chunk({ content: c });
      await sleep(ms);
    }
    await holdIfAsked(step, signal);
    if (step.dropAfterText) throw new TypeError("network error (preview: stream dropped)");
    tools.forEach((t, i) => {
      chunk({
        tool_calls: [{ index: i, id: `call_${id}_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }],
      });
    });
    chunk({}, tools.length ? "tool_calls" : "stop");
    send({ id, object: "chat.completion.chunk", created, model, choices: [], usage });
    send("[DONE]");
  }, signal);
}

// ---- Anthropic Messages --------------------------------------------------------

async function serveAnthropic(p: Parsed, step: Step, signal?: AbortSignal): Promise<Response> {
  if (step.error)
    return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: step.error.message } }), {
      status: step.error.status,
      headers: { "content-type": "application/json" },
    });
  const id = newId("msg_preview_");
  const text = step.text ?? "";
  const tools = withVault(step.tools ?? []);
  const u = usageFor(p, step, Math.round((text.length + (step.reasoning ?? "").length) / 4));
  const stop = tools.length ? "tool_use" : "end_turn";
  if (!p.stream) {
    const content: any[] = [];
    if (step.reasoning) content.push({ type: "thinking", thinking: step.reasoning, signature: "preview" });
    if (text) content.push({ type: "text", text });
    tools.forEach((t, i) => content.push({ type: "tool_use", id: `toolu_${id}_${i}`, name: t.name, input: t.args }));
    return new Response(
      JSON.stringify({ id, type: "message", role: "assistant", model: p.model, content, stop_reason: stop, usage: { input_tokens: u.prompt - u.cached, cache_read_input_tokens: u.cached, output_tokens: u.completion } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  const ms = step.chunkMs ?? config.chunkMs ?? 18;
  return sseResponse(async (send) => {
    send({ type: "message_start", message: { id, type: "message", role: "assistant", model: p.model, content: [], stop_reason: null, usage: { input_tokens: u.prompt - u.cached, cache_read_input_tokens: u.cached, output_tokens: 1 } } }, "message_start");
    let idx = 0;
    if (step.reasoning) {
      send({ type: "content_block_start", index: idx, content_block: { type: "thinking", thinking: "" } }, "content_block_start");
      for (const c of chunksOf(step.reasoning)) {
        send({ type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: c } }, "content_block_delta");
        await sleep(ms);
      }
      send({ type: "content_block_delta", index: idx, delta: { type: "signature_delta", signature: "preview-signature" } }, "content_block_delta");
      send({ type: "content_block_stop", index: idx }, "content_block_stop");
      idx++;
    }
    if (text) {
      send({ type: "content_block_start", index: idx, content_block: { type: "text", text: "" } }, "content_block_start");
      for (const c of chunksOf(text)) {
        send({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text: c } }, "content_block_delta");
        await sleep(ms);
      }
      send({ type: "content_block_stop", index: idx }, "content_block_stop");
      idx++;
    }
    await holdIfAsked(step, signal);
    if (step.dropAfterText) throw new TypeError("network error (preview: stream dropped)");
    for (const [i, t] of tools.entries()) {
      send({ type: "content_block_start", index: idx, content_block: { type: "tool_use", id: `toolu_${id}_${i}`, name: t.name, input: {} } }, "content_block_start");
      send({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(t.args) } }, "content_block_delta");
      send({ type: "content_block_stop", index: idx }, "content_block_stop");
      idx++;
    }
    send({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: u.completion } }, "message_delta");
    send({ type: "message_stop" }, "message_stop");
  }, signal);
}

// ---- the box's side threads (POST /api/v1/side, src/complete.ts) ---------------

/** Answer a side request from the scenario's scripts: the instructions are its
 *  rules, the text the user message. An error step throws (the box's 502). */
export async function answerComplete(req: { instructions?: string; text?: string; images?: string[] }): Promise<string> {
  const text = String(req.text ?? "");
  const p: Parsed = {
    provider: "openai-chat",
    model: "box",
    stream: false,
    system: String(req.instructions ?? ""),
    lastUser: text,
    stepIndex: 0,
    approxPromptTokens: Math.round(text.length / 3.8),
    hasTools: false,
    wantsJson: false,
  };
  const { id, step } = pick(p);
  llmLog.push({ at: Date.now(), url: "box:/api/v1/side", model: "box", script: id, step: 0, stream: false });
  await holdIfAsked(step);
  await sleep(Math.min(1200, 200 + (step.text?.length ?? 0) * 2));
  if (step.error) throw new Error(`OpenRouter ${step.error.status}: ${step.error.message}`);
  return step.text ?? "";
}

// ---- entry point ---------------------------------------------------------------

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

/** Answer a model-provider request, or return null if `url` isn't one. */
export async function answerModelRequest(url: URL, init: RequestInit | undefined): Promise<Response | null> {
  const host = url.hostname;
  const path = url.pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  const bodyText = typeof init?.body === "string" ? init.body : "";
  const signal = init?.signal ?? undefined;

  if (host === "openrouter.ai") {
    if (path.endsWith("/models") && method === "GET") return json(catalog);
    if (path.endsWith("/chat/completions")) {
      const raw = JSON.parse(bodyText || "{}");
      // Settings' one model test (two tools to call at once, usage on; an
      // image when the catalog doesn't know the model): answered like OpenRouter.
      if (raw.tools?.[0]?.function?.name === "vc_check_a") return answerModelTest(raw.model, raw);
      const p = parseOpenAI(raw);
      const { id, step, index } = pick(p);
      llmLog.push({ at: Date.now(), url: url.href, model: p.model, script: id, step: index, stream: p.stream });
      return serveOpenAI(p, step, signal);
    }
    if (path.includes("/generation")) return json({ data: { total_cost: 0.0012 } });
    if (path.endsWith("/key") || path.endsWith("/auth/key")) return json({ data: { label: "sk-or-PREVIEW", usage: 1.23, limit: null } });
    if (path.endsWith("/credits")) return json({ data: { total_credits: 50, total_usage: 12.34 } });
    return null;
  }
  if (host === "api.elevenlabs.io") {
    if (path === "/v1/voices") return json({ voices: EL_VOICES });
    // The voice library (Settings → Voice → Browse the voice library…).
    if (path === "/v1/shared-voices" && method === "GET") return json(sharedVoices(url.searchParams));
    const add = /^\/v1\/voices\/add\/([^/]+)\/([^/]+)$/.exec(path);
    if (add && method === "POST") return addLibraryVoice(decodeURIComponent(add[1]), decodeURIComponent(add[2]), bodyText);
    if (path.startsWith("/v1/text-to-speech/")) return new Response(chime(), { headers: { "content-type": "audio/wav" } });
    if (path === "/v1/convai/agents/create") return json({ agent_id: "preview-agent" });
    // A picked voice becomes the agent's own (src/voice-elevenlabs setAgentVoice).
    if (/^\/v1\/convai\/agents\/[^/]+$/.test(path) && method === "PATCH") return json({});
    // One voice's record (Settings checks a pick fits the agent's model).
    const one = /^\/v1\/voices\/([^/]+)$/.exec(path);
    if (one && method === "GET") {
      const v = EL_VOICES.find((x) => x.voice_id === decodeURIComponent(one[1]));
      return v ? json(v) : json({ detail: { status: "voice_not_found" } }, 404);
    }
    // The voice models ElevenLabs runs and what each takes (src/voiceLlms.ts reads it). Faked.
    if (path === "/v1/convai/llm/list")
      return json({
        llms: [
          { llm: "gpt-6-luna", supports_image_input: true, supports_document_input: false, available_reasoning_efforts: ["none", "low", "medium", "high"] },
          { llm: "gpt-6.1-sol", supports_image_input: true, supports_document_input: true, available_reasoning_efforts: ["low", "medium", "high"] },
          { llm: "claude-sonnet-5-5", supports_image_input: true, supports_document_input: true, available_reasoning_efforts: [] },
          { llm: "claude-sonnet-4-6", supports_image_input: true, supports_document_input: true, available_reasoning_efforts: [] },
          { llm: "claude-haiku-5-5", supports_image_input: true, supports_document_input: true, available_reasoning_efforts: [] },
          { llm: "claude-haiku-4-5", supports_image_input: true, supports_document_input: true, available_reasoning_efforts: [] },
          { llm: "gemini-3.8-flash", supports_image_input: true, supports_document_input: true, available_reasoning_efforts: ["none", "low", "high"] },
          { llm: "gemini-3.5-flash", supports_image_input: true, supports_document_input: true, available_reasoning_efforts: ["none", "low", "high"] },
          { llm: "glm-52", supports_image_input: false, supports_document_input: false, available_reasoning_efforts: ["none", "high"] },
        ],
      });
    return null;
  }
  if (host === "api.anthropic.com") {
    if (path.endsWith("/models")) {
      const data = (catalog as any).data
        .filter((m: any) => m.id.startsWith("anthropic/") && !m.id.includes(":"))
        .map((m: any) => ({ id: m.id.slice("anthropic/".length).replace(/\./g, "-"), display_name: m.name.replace(/^Anthropic: /, ""), type: "model" }));
      return json({ data, has_more: false });
    }
    if (path.endsWith("/messages")) {
      const p = parseAnthropic(JSON.parse(bodyText || "{}"));
      const { id, step, index } = pick(p);
      llmLog.push({ at: Date.now(), url: url.href, model: p.model, script: id, step: index, stream: p.stream });
      return serveAnthropic(p, step, signal);
    }
    return null;
  }
  if (host === "api.openai.com") {
    if (path.endsWith("/models"))
      return json({ data: ["gpt-5.5", "gpt-5.5-mini", "gpt-4.1-mini", "o4-mini"].map((id) => ({ id, object: "model" })) });
    if (path.endsWith("/chat/completions")) {
      const p = parseOpenAI(JSON.parse(bodyText || "{}"));
      const { id, step, index } = pick(p);
      llmLog.push({ at: Date.now(), url: url.href, model: p.model, script: id, step: index, stream: p.stream });
      return serveOpenAI(p, step, signal);
    }
    return null; // Responses API: not faked — refused loudly by the guard.
  }
  if (host === "generativelanguage.googleapis.com" && path.endsWith("/models"))
    return json({ models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] }] });
  return null;
}

// ---- Settings: the model test, ElevenLabs voices -------------------------------

function answerModelTest(model: string, raw: any): Response {
  const m = (catalog as any).data.find((x: any) => x.id === model);
  const images = m ? (m.architecture?.input_modalities ?? []).includes("image") : !/deepseek/.test(model);
  const hasImage = JSON.stringify(raw.messages ?? []).includes("image_url");
  if (!images && hasImage)
    return json({ error: { code: 400, message: "No endpoints found that support image input" } }, 400);
  // Qwen3 Coder answers one tool at a time (the preview's "can't call tools in parallel").
  const names = /qwen3-coder/.test(model) ? ["vc_check_a"] : ["vc_check_a", "vc_check_b"];
  const reasons = !!raw.reasoning && !!m && (m.supported_parameters ?? []).includes("reasoning");
  return json({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          ...(reasons ? { reasoning: "Two tools to call; calling both at once." } : {}),
          tool_calls: names.map((name, i) => ({ id: `t${i}`, type: "function", function: { name, arguments: '{"ok":true}' } })),
        },
      },
    ],
    usage: { prompt_tokens: 180, completion_tokens: 40, total_tokens: 220, cost: 0.00031 },
  });
}

const EL_VOICES = [
  ["nPczCjzI2devNBz1zQrb", "Brian", "american", "male", "deep"],
  ["JBFqnCBsd6RMkjVDRZzb", "George", "british", "male", "warm"],
  ["EXAVITQu4vr4xnSDxMaL", "Sarah", "american", "female", "soft"],
  ["XB0fDUnXU5powFXDhCwa", "Charlotte", "swedish", "female", "seductive"],
  ["onwK4e9ZLuTAKqWW03F9", "Daniel", "british", "male", "authoritative"],
  ["pFZP5JQG7iQjIQuC4Bku", "Lily", "british", "female", "warm"],
  ["TX3LPaxmHKxFdv7VOQHJ", "Liam", "american", "male", "articulate"],
  ["XrExE9yKIg1WjnnlVkGX", "Matilda", "american", "female", "friendly"],
  // A second Brian, as on Carl's account: told apart by accent and description.
  ["bR1anTw0xxxxxxxxxxxx", "Brian", "british", "male", "calm"],
].map(([voice_id, name, accent, gender, description]) => ({ voice_id, name, category: "premade", labels: { accent, gender, description } }));

// ---- The ElevenLabs voice library (GET /v1/shared-voices, POST /v1/voices/add) --
// A few English voices, each with a silent preview (a data: WAV — nothing
// leaves the page). Adding one puts it in EL_VOICES; the scenario's library
// limit (localStorage preview_el_voice_limit) refuses adds past it like
// ElevenLabs does.

const SILENT_WAV = (() => {
  const n = 2205;
  const buf = new Uint8Array(44 + n * 2);
  const v = new DataView(buf.buffer);
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 22050, true); v.setUint32(28, 44100, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 2, true);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(bin)}`;
})();

const LIB = [
  ["lIbJun1perxxxxxxxxxx", "Juniper", "female", "young", "american", "conversational", true, "Warm, upbeat and clear; made for back-and-forth talk."],
  ["lIbMarcusxxxxxxxxxxx", "Marcus", "male", "middle_aged", "american", "conversational", true, "Steady, friendly tutor voice with an easy pace."],
  ["lIbAmeliaxxxxxxxxxxx", "Amelia", "female", "young", "british", "conversational", false, "Bright British voice, crisp and expressive."],
  ["lIbHarlanxxxxxxxxxxx", "Harlan", "male", "old", "american", "narrative_story", false, "Gravelly storyteller for long reads."],
  ["lIbPriyaxxxxxxxxxxxx", "Priya", "female", "middle_aged", "indian", "conversational", false, "Calm and precise, good for explanations."],
  ["lIbTheoxxxxxxxxxxxxx", "Theo", "male", "young", "australian", "conversational", false, "Relaxed and casual, like a study buddy."],
].map(([voice_id, name, gender, age, accent, use_case, featured, description]) => ({
  voice_id: voice_id as string,
  public_owner_id: `owner${(voice_id as string).slice(3, 9)}`,
  name: name as string,
  gender,
  age,
  accent,
  use_case,
  featured: featured as boolean,
  description,
  language: "en",
  category: "professional",
  preview_url: SILENT_WAV,
}));

function sharedVoices(q: URLSearchParams) {
  const size = Number(q.get("page_size") ?? 30);
  const page = Number(q.get("page") ?? 0);
  const terms = (q.get("search") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const list = LIB.filter(
    (v) =>
      (q.get("featured") !== "true" || v.featured) &&
      (!q.get("use_cases") || q.get("use_cases") === v.use_case) &&
      terms.every((t) => `${v.name} ${v.description}`.toLowerCase().includes(t)),
  ).map((v) => ({ ...v, is_added_by_user: EL_VOICES.some((a) => a.voice_id === v.voice_id) }));
  return { voices: list.slice(page * size, (page + 1) * size), has_more: (page + 1) * size < list.length, total_count: list.length };
}

function addLibraryVoice(owner: string, id: string, bodyText: string): Response {
  const v = LIB.find((x) => x.voice_id === id && x.public_owner_id === owner);
  if (!v) return json({ detail: { status: "voice_not_found", message: "A voice with that id was not found." } }, 400);
  const limit = Number(localStorage.getItem("preview_el_voice_limit") ?? "30");
  const custom = EL_VOICES.filter((x) => x.category !== "premade").length;
  if (custom >= limit)
    return json({ detail: { status: "voice_limit_reached", message: `You have reached your maximum amount of custom voices (${custom} / ${limit}). You can upgrade your subscription to increase your custom voice limit.` } }, 400);
  const name = (JSON.parse(bodyText || "{}") as { new_name?: string }).new_name ?? v.name;
  if (!EL_VOICES.some((x) => x.voice_id === id))
    EL_VOICES.push({
      voice_id: id,
      name,
      category: "professional",
      // The models it was trained for (a library clone runs on Flash v2, the agent's).
      high_quality_base_model_ids: ["eleven_flash_v2", "eleven_turbo_v2", "eleven_multilingual_v2"],
      labels: { accent: v.accent as string, gender: v.gender as string, description: v.description as string },
    } as (typeof EL_VOICES)[number]);
  return json({ voice_id: id });
}

/** A short two-note chime as a WAV: what "Test" plays in the preview. */
function chime(): Blob {
  const rate = 22050;
  const n = Math.floor(rate * 0.7);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = t < 0.35 ? 660 : 880;
    const env = Math.exp(-((t % 0.35) * 6));
    v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * f * t) * env * 9000, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
