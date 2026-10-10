import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export type ProviderId = "anthropic" | "openai" | "google" | "openrouter";

export type ModelSpec = {
  provider: ProviderId;
  id: string;
  label: string;
};

// The offline seed list. The live catalog (modelCatalog.ts) replaces it at
// runtime; these entries are what resolves before that fetch lands and what the
// hidden jobs pick from (compactor / pickFastModel take the FIRST entry of a
// provider whose id matches /haiku|mini|flash/ — so ORDER MATTERS: on an
// OpenRouter-only machine (the box) that is `anthropic/claude-haiku-5.5`).
// OpenRouter ids were checked against https://openrouter.ai/api/v1/models on
// 2026-10-10. Direct-provider ids are the providers' own names.
export const MODELS: ModelSpec[] = [
  // --- OpenRouter (the default path: one key reaches every family) ---
  { provider: "openrouter", id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol (flagship)" },
  { provider: "openrouter", id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5" },
  { provider: "openrouter", id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5" },
  // Cheap + current: the background model (compaction, titles, alert
  // summaries, timeline cleaning). Must stay the first OpenRouter id matching
  // /haiku|mini|flash/ — see the note above.
  { provider: "openrouter", id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5 (fast)" },
  { provider: "openrouter", id: "openai/gpt-6-luna", label: "GPT-6 Luna (efficient)" },
  { provider: "openrouter", id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { provider: "openrouter", id: "x-ai/grok-4.7", label: "Grok 4.7" },
  { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
  { provider: "openrouter", id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  // Previous generation, still served — kept so saved picks keep resolving.
  { provider: "openrouter", id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { provider: "openrouter", id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { provider: "openrouter", id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  // Fastest tier — open-weight models pinned to the highest-throughput
  // backend via OpenRouter's `:nitro` suffix (== provider.sort "throughput").
  // Text-only (no vision) — supportsVision gates that.
  { provider: "openrouter", id: "openai/gpt-oss-120b:nitro", label: "gpt-oss 120B (Nitro)" },
  { provider: "openrouter", id: "qwen/qwen3-32b:nitro", label: "Qwen3 32B (Nitro)" },
  { provider: "openrouter", id: "qwen/qwen3-coder", label: "Qwen3 Coder" },
  // --- Direct provider keys (optional; nothing in the default path needs them) ---
  { provider: "anthropic", id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { provider: "anthropic", id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { provider: "anthropic", id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { provider: "openai", id: "gpt-5.5", label: "GPT-5.5" },
  { provider: "openai", id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { provider: "google", id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { provider: "google", id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
];

// Chat default (desktop chat pane, phone assistant, the mission's
// conversational front, ask threads). Claude Sonnet 5.5 via OpenRouter: a
// current frontier tool-user with a 1M context, the same price as the mission
// model ($2/$10 per M) — and a DIFFERENT family from it, so a chat that reviews
// a mission's work isn't the same model grading itself.
export const DEFAULT_MODEL_ID = "anthropic/claude-sonnet-5.5";

// Missions (the supervisor) and their workers: long-horizon, tool-heavy grinds.
// GPT-6.1 Sol via OpenRouter (1.05M context, tools + reasoning). Decoupled from
// DEFAULT_MODEL_ID on purpose — a lighter chat default must never drag a worker
// down, and a pricey worker must never become the chat default.
export const DEFAULT_MISSION_MODEL_ID = "openai/gpt-6.1-sol";
export const DEFAULT_WORKER_MODEL_ID = DEFAULT_MISSION_MODEL_ID;

// Hidden jobs: compaction, titles, alert summaries, timeline cleaning.
export const DEFAULT_BACKGROUND_MODEL_ID = "anthropic/claude-haiku-5.5";

// Sentinel value stored in the model picker when the user selects "Auto".
// At send-time `resolveAutoModel` turns this into a concrete model:
//   • OpenRouter key present → OpenRouter's trained server-side router
//     (`openrouter/auto`, see below) — strictly better than local matching
//     and provider-neutral.
//   • otherwise → a lightweight local fast/full split over the user's
//     direct-key providers.
// Either way no EXTRA request is made — routing rides the normal call.
export const AUTO_MODEL_ID = "auto";

// OpenRouter's server-side router (NotDiamond-powered). It analyses each
// prompt and forwards to the best model from a curated pool (Claude / GPT /
// Gemini / DeepSeek / …) at no markup, supports tool calling + streaming,
// and reports the chosen model back in the response. This is the SOTA path:
// a router trained on preference data instead of keyword guesses.
export const AUTO_ROUTER_MODEL_ID = "openrouter/auto";

// Cost ⇄ quality dial for `openrouter/auto`: 0 = pure quality, 10 = cheapest
// (per OpenRouter's `cost_quality_tradeoff`). Default 7 leans toward savings
// — the whole point of Auto — while still escalating genuinely hard prompts.
// Held module-level (mirrors `setLiveCatalog`) and synced from the store so
// the fetch shim below can read it without a circular import.
let _autoRouterCostBias = 7;
export function setAutoRouterCostBias(n: number): void {
  if (Number.isFinite(n)) _autoRouterCostBias = Math.max(0, Math.min(10, Math.round(n)));
}
export function getAutoRouterCostBias(): number {
  return _autoRouterCostBias;
}

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
};

// ---------------------------------------------------------------------------
// OpenRouter base URL. Production is openrouter.ai; tests (and the headless
// server's tests) point it at a local fake via `setOpenRouterBaseURL` or the
// env var VC_OPENROUTER_BASE_URL (read once, node only).
// ---------------------------------------------------------------------------
const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
let _openRouterBaseURL: string =
  ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.VC_OPENROUTER_BASE_URL || "").trim() || OPENROUTER_DEFAULT_BASE_URL;
export function setOpenRouterBaseURL(url: string | null): void {
  _openRouterBaseURL = (url || "").trim().replace(/\/+$/, "") || OPENROUTER_DEFAULT_BASE_URL;
}
export function getOpenRouterBaseURL(): string {
  return _openRouterBaseURL;
}

// ---------------------------------------------------------------------------
// Cost metering. Every OpenRouter call made through a model built with a
// CostMeter asks OpenRouter for usage accounting (`usage: {include: true}`)
// and records the server-reported `usage.cost` (USD) — the exact number
// OpenRouter bills, not an estimate. The AI SDK's chat adapter parses usage
// into token counts only and drops `cost`, so the meter reads it at the fetch
// layer: streamed responses are teed and the SSE chunks scanned for the final
// `usage` object; JSON responses (generateText, e.g. mid-run compaction) are
// read from a clone. A call whose response carried no cost is recorded with
// `usd: null` (counted as "missing", never silently as $0).
// ---------------------------------------------------------------------------
export type ModelCallCost = {
  usd: number | null;
  model?: string;
  generationId?: string;
  promptTokens?: number;
  completionTokens?: number;
};

export type CostMeter = {
  readonly calls: ModelCallCost[];
  record(c: ModelCallCost): void;
  track(p: Promise<unknown>): void;
  /** Wait (bounded) for in-flight response scans to finish recording. */
  settle(timeoutMs?: number): Promise<void>;
  totalUsd(): number;
  missing(): number;
};

export function createCostMeter(): CostMeter {
  const calls: ModelCallCost[] = [];
  const pending = new Set<Promise<unknown>>();
  return {
    calls,
    record(c) {
      calls.push(c);
    },
    track(p) {
      const q = p.catch(() => undefined).finally(() => pending.delete(q));
      pending.add(q);
    },
    async settle(timeoutMs = 5000) {
      if (!pending.size) return;
      await Promise.race([
        Promise.all([...pending]),
        new Promise((r) => setTimeout(r, timeoutMs)),
      ]);
    },
    totalUsd() {
      return roundUsd(calls.reduce((s, c) => s + (typeof c.usd === "number" ? c.usd : 0), 0));
    },
    missing() {
      return calls.filter((c) => typeof c.usd !== "number").length;
    },
  };
}

/** USD rounded to 1e-6 (sub-cent precision without float noise). */
export function roundUsd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function costFromUsage(j: any): ModelCallCost {
  const u = j?.usage ?? {};
  const cost = typeof u.cost === "number" ? u.cost : typeof u.total_cost === "number" ? u.total_cost : null;
  return {
    usd: cost,
    model: typeof j?.model === "string" ? j.model : undefined,
    generationId: typeof j?.id === "string" ? j.id : undefined,
    promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
    completionTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
  };
}

async function scanSseForCost(body: ReadableStream<Uint8Array>): Promise<ModelCallCost> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let id: string | undefined;
  let model: string | undefined;
  let found: ModelCallCost | null = null;
  const onLine = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const data = t.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const j = JSON.parse(data);
      if (typeof j?.id === "string") id = j.id;
      if (typeof j?.model === "string") model = j.model;
      if (j?.usage) found = costFromUsage(j);
    } catch {
      /* keepalive comments / partial garbage — skip */
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf) onLine(buf);
  } catch {
    /* aborted mid-stream — record what we saw */
  }
  const f = found as ModelCallCost | null;
  return f ? { ...f, generationId: f.generationId ?? id, model: f.model ?? model } : { usd: null, generationId: id, model };
}

// One fetch wrapper for every OpenRouter request:
//  - `openrouter/auto` gets its auto-router plugin config (the AI SDK has no
//    passthrough for OpenRouter's non-standard `plugins` field);
//  - with a meter, the request asks for usage accounting and the response's
//    `usage.cost` is recorded on the meter.
function openRouterFetch(meter?: CostMeter) {
  return async (input: any, init?: any): Promise<Response> => {
    try {
      if (init && typeof init.body === "string") {
        const body = JSON.parse(init.body);
        let changed = false;
        if (body?.model === AUTO_ROUTER_MODEL_ID) {
          const existing = Array.isArray(body.plugins) ? body.plugins : [];
          body.plugins = [
            ...existing.filter((p: any) => p?.id !== "auto-router"),
            { id: "auto-router", cost_quality_tradeoff: _autoRouterCostBias },
          ];
          changed = true;
        }
        if (meter && body && typeof body === "object") {
          body.usage = { ...(body.usage && typeof body.usage === "object" ? body.usage : {}), include: true };
          changed = true;
        }
        if (changed) init = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      // Non-JSON body / parse failure — send the original request unchanged.
    }
    const res = await fetch(input, init);
    if (!meter || !res.ok || !res.body) return res;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      const [forSdk, forMeter] = res.body.tee();
      meter.track(scanSseForCost(forMeter).then((c) => meter.record(c)));
      return new Response(forSdk, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    if (ct.includes("json")) {
      meter.track(
        res
          .clone()
          .json()
          .then((j) => meter.record(costFromUsage(j)))
          .catch(() => meter.record({ usd: null })),
      );
    }
    return res;
  };
}

export function buildModel(spec: ModelSpec, apiKey: string, opts: { meter?: CostMeter } = {}): LanguageModel {
  switch (spec.provider) {
    case "anthropic": {
      // anthropic-beta:
      //  - interleaved-thinking-2025-05-14: lets Claude 4.x think
      //    BETWEEN tool calls within a turn (not just at the start).
      //  - extended-cache-ttl-2025-04-11: unlocks the 1-hour cache
      //    TTL option on cache_control blocks.
      const a = createAnthropic({
        apiKey,
        headers: {
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-beta": "interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11",
        },
      });
      return a(spec.id);
    }
    case "openai": {
      const o = createOpenAI({ apiKey });
      return o(spec.id);
    }
    case "google": {
      const g = createGoogleGenerativeAI({ apiKey });
      return g(spec.id);
    }
    case "openrouter": {
      // OpenRouter speaks the classic Chat Completions API, not
      // OpenAI's newer Responses API. Calling the factory as a function
      // (r(id)) would pick Responses and break for every non-OpenAI
      // upstream — use r.chat(id) to pin it to Chat Completions.
      const r = createOpenAI({
        apiKey,
        baseURL: _openRouterBaseURL,
        headers: {
          "HTTP-Referer": "https://github.com/carl-wilson/vault-chat",
          "X-Title": "vault-chat",
        },
        fetch: openRouterFetch(opts.meter),
      });
      return r.chat(spec.id);
    }
  }
}

// `MODELS` is the fallback seed list. At runtime the store hydrates a
// live catalog (fetched from each provider's /models endpoint) via
// `setLiveCatalog`. `findModel` searches the live list first, falling
// back to the seeds so core paths (agent / inlineEdit / compactor) keep
// working even if the fetch hasn't happened yet.
let _liveCatalog: ModelSpec[] | null = null;

export function setLiveCatalog(models: ModelSpec[] | null): void {
  _liveCatalog = models && models.length > 0 ? models : null;
}

export function getLiveCatalog(): ModelSpec[] {
  return _liveCatalog ?? MODELS;
}

// True if the model accepts image input. Anthropic/OpenAI/Google
// families are vision-capable across the board in their current
// catalogs; OpenRouter varies per upstream, so we allow-list the
// common vision families by id pattern.
export function supportsVision(spec: ModelSpec): boolean {
  if (spec.provider === "anthropic") return true;
  if (spec.provider === "openai") return true;
  if (spec.provider === "google") return true;
  // OpenRouter's auto router can land on a vision model, so allow images.
  if (spec.id === AUTO_ROUTER_MODEL_ID) return true;
  // OpenRouter: opt-in by id substring.
  return /(-vl|vision|pixtral|llava|gpt-[4-9]|claude|gemini|grok-4|llama-4|qwen.*2\.5|qwen3-vl)/i.test(spec.id);
}

export function findModel(id: string): ModelSpec | undefined {
  // OpenRouter's auto router is a virtual model — never in any catalog, but
  // a valid target the agent can send. Synthesize its spec so apiKey lookup
  // and the request path work.
  if (id === AUTO_ROUTER_MODEL_ID) {
    return { provider: "openrouter", id: AUTO_ROUTER_MODEL_ID, label: "Auto (OpenRouter)" };
  }
  const hit = (_liveCatalog ?? MODELS).find((m) => m.id === id) ?? MODELS.find((m) => m.id === id);
  if (hit) return hit;
  // A `vendor/model` id is an OpenRouter id by construction (direct-provider
  // ids never contain a slash). Resolve it even before the live catalog has
  // loaded, so a saved pick like `openai/gpt-6.1-sol` never reads as "unknown
  // model" on a fresh boot.
  if (/^[\w.-]+\/[\w.:-]+$/.test(id)) return { provider: "openrouter", id, label: id };
  return undefined;
}

// ---------------------------------------------------------------------------
// Turn model resolution — no silent no-key runs.
// ---------------------------------------------------------------------------

/** Thrown when no candidate model for a turn has a usable provider key. The
 *  message is meant for a human (thread bubble, notification). */
export class MissingKeyError extends Error {
  readonly provider: ProviderId | null;
  readonly modelId: string;
  constructor(modelId: string, provider: ProviderId | null, detail?: string) {
    super(
      provider
        ? `No ${PROVIDER_LABEL[provider]} API key is configured for model "${modelId}" — this turn did not run. ` +
            `Add the key (key name api.${provider}) and retry.${detail ? ` ${detail}` : ""}`
        : `Unknown model "${modelId}" and no fallback model has a key — this turn did not run.${detail ? ` ${detail}` : ""}`,
    );
    this.name = "MissingKeyError";
    this.provider = provider;
    this.modelId = modelId;
  }
}

// The same model, reachable through another provider. A saved direct-provider
// pick (`claude-opus-4-8`) on a machine that only holds an OpenRouter key (the
// box) runs as `anthropic/claude-opus-4.8` via OpenRouter, and an OpenRouter
// id on a machine with only that vendor's direct key runs direct. Returns null
// when there is no sensible equivalent.
export function equivalentModelId(spec: ModelSpec, target: ProviderId): string | null {
  if (spec.provider === target) return spec.id;
  if (target === "openrouter") {
    if (spec.provider === "anthropic") {
      // claude-opus-4-8 → anthropic/claude-opus-4.8 ; claude-haiku-4-5-20251001 → anthropic/claude-haiku-4.5
      const base = spec.id.replace(/-\d{8}$/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2");
      return `anthropic/${base}`;
    }
    if (spec.provider === "openai") return `openai/${spec.id}`;
    if (spec.provider === "google") return `google/${spec.id}`;
    return null;
  }
  if (spec.provider === "openrouter") {
    const m = spec.id.match(/^(anthropic|openai|google)\/(.+)$/);
    if (!m || m[1] !== target) return null;
    const rest = m[2]!.replace(/:.*$/, "");
    return target === "anthropic" ? rest.replace(/-(\d+)\.(\d+)$/, "-$1-$2") : rest;
  }
  return null;
}

/**
 * Pick the model a turn runs on: the first candidate whose provider has a key,
 * or — failing that — the same model routed through a provider that does.
 * Throws MissingKeyError (naming the FIRST candidate) when nothing can run,
 * so callers fail loudly instead of returning quietly with no reply.
 */
export function resolveTurnModel(
  candidates: Array<string | undefined | null>,
  apiKeys: Partial<Record<ProviderId, string>>,
): { modelId: string; spec: ModelSpec; apiKey: string; routedFrom?: string } {
  const ids = [...new Set(candidates.filter((c): c is string => !!c && c !== AUTO_MODEL_ID))];
  if (!ids.length) {
    // Only "auto" was asked for and it could not resolve: Auto runs on OpenRouter.
    if (candidates.includes(AUTO_MODEL_ID)) throw new MissingKeyError(AUTO_MODEL_ID, "openrouter");
    throw new MissingKeyError("(none)", null, "No model is configured.");
  }
  const orCatalog = _liveCatalog?.filter((m) => m.provider === "openrouter") ?? [];
  for (const id of ids) {
    const spec = findModel(id);
    if (!spec) continue;
    const key = apiKeys[spec.provider];
    if (key) return { modelId: spec.id, spec, apiKey: key };
    for (const p of ["openrouter", "anthropic", "openai", "google"] as ProviderId[]) {
      if (p === spec.provider || !apiKeys[p]) continue;
      const alt = equivalentModelId(spec, p);
      if (!alt) continue;
      // Only reroute to an OpenRouter id the live catalog actually lists (when
      // it is loaded) — never to a guessed id that would 404.
      if (p === "openrouter" && orCatalog.length && !orCatalog.some((m) => m.id === alt)) continue;
      const altSpec = findModel(alt) ?? { provider: p, id: alt, label: alt };
      return { modelId: alt, spec: { ...altSpec, provider: p }, apiKey: apiKeys[p]!, routedFrom: id };
    }
  }
  const first = findModel(ids[0]!);
  throw new MissingKeyError(ids[0]!, first?.provider ?? null);
}

// ---------------------------------------------------------------------------
// Auto-mode routing
// ---------------------------------------------------------------------------

// Fallback provider priority for direct-key-only users (no OpenRouter key).
// OpenRouter is handled separately and preferred whenever present — see
// resolveAutoModel — so it isn't listed here.
const PROVIDER_PRIORITY: ProviderId[] = ["anthropic", "openai", "google"];

// Fast (cheap) model ids to prefer per provider. Matched against the live
// catalog; falls back to the seed list. Pattern matched case-insensitively.
const FAST_PATTERN: Record<ProviderId, RegExp> = {
  anthropic: /haiku/i,
  openai: /mini/i,
  google: /flash/i,
  openrouter: /deepseek-chat|haiku|flash|mini|qwen3-coder/i,
};

// Full (capable) model ids per provider.
// Intentionally avoids Opus for Anthropic — Sonnet 4.6 is the sweet spot
// for complex tasks at 60% lower cost. Users can pick Opus manually when
// they genuinely need it.
const FULL_PATTERN: Record<ProviderId, RegExp> = {
  anthropic: /sonnet/i,
  openai: /gpt-4\.1$|gpt-4o$|gpt-5/i,
  google: /pro/i,
  openrouter: /235b|sonnet|gpt-4/i,
};

// Narrow set of verbs that reliably signal real work. Deliberately tight:
// the previous list included how/what/why/find/read/write/search, which
// match almost every message and forced ~everything onto the expensive
// model — defeating the point of Auto. These are strong task intents only.
const COMPLEX_KEYWORDS =
  /\b(implement|debug|refactor|rewrite|optimi[sz]e|architect|migrate|deploy|stack ?trace|traceback|exception|algorithm|regex|derive|prove|benchmark|diff)\b/i;

/**
 * Heuristic classifier for the direct-key fallback path (no OpenRouter).
 * Returns true if the request warrants the full/capable model.
 *
 * @param historyTokensApprox  Approximate tokens already in the conversation
 *   (the conversation's last known context size). This is the single
 *   strongest cost signal: long agentic threads are where spend accumulates,
 *   and a weak model tends to flail there (extra tool loops) — which costs
 *   MORE than just using the strong model. So escalate once context is real.
 */
function isComplexMessage(message: string, historyTokensApprox = 0): boolean {
  const trimmed = message.trim();
  if (historyTokensApprox > 4000) return true; // substantive ongoing thread
  if (trimmed.length > 240) return true; // was 120 — far too aggressive
  if (/```|^\s{4}/m.test(trimmed)) return true; // code block
  if (/[\/\\][\w.-]+\.[a-zA-Z]{2,5}\b/.test(trimmed)) return true; // file path
  if (COMPLEX_KEYWORDS.test(trimmed)) return true;
  return false;
}

/**
 * Resolve the "auto" sentinel to a real ModelSpec.
 *
 * @param message  The user's raw message text.
 * @param apiKeys  Map of provider → API key (only set for configured ones).
 * @param catalog  The live model catalog (or seed list as fallback).
 * @param historyTokensApprox  Tokens already in the conversation (fallback
 *   path only; OpenRouter's router judges context itself).
 * @returns A ModelSpec to run, or null if no provider has a key.
 */
export function resolveAutoModel(
  message: string,
  apiKeys: Partial<Record<ProviderId, string>>,
  catalog: ModelSpec[] = _liveCatalog ?? MODELS,
  historyTokensApprox = 0,
): ModelSpec | null {
  // SOTA path: defer to OpenRouter's trained, provider-neutral router
  // whenever a key exists. It outperforms local keyword matching and, by
  // construction, carries no single-vendor bias.
  if (apiKeys.openrouter) {
    return { provider: "openrouter", id: AUTO_ROUTER_MODEL_ID, label: "Auto (OpenRouter)" };
  }

  // Fallback for direct-key-only users: a cheap local fast/full split.
  const provider = PROVIDER_PRIORITY.find((p) => !!apiKeys[p]);
  if (!provider) return null;

  const complex = isComplexMessage(message, historyTokensApprox);
  const pattern = complex ? FULL_PATTERN[provider] : FAST_PATTERN[provider];

  // Search the live catalog first, then the seed list as a safety net.
  const candidates = [...catalog, ...MODELS].filter((m) => m.provider === provider);
  const match = candidates.find((m) => pattern.test(m.id));

  // Final fallback: first model for this provider in the catalog.
  return match ?? candidates[0] ?? null;
}
