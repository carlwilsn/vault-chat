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

export const MODELS: ModelSpec[] = [
  { provider: "anthropic", id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { provider: "anthropic", id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { provider: "anthropic", id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { provider: "anthropic", id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { provider: "anthropic", id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { provider: "openai", id: "gpt-4.1", label: "GPT-4.1" },
  { provider: "openai", id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { provider: "google", id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { provider: "google", id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { provider: "google", id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { provider: "openrouter", id: "qwen/qwen3-235b-a22b", label: "Qwen3 235B" },
  { provider: "openrouter", id: "qwen/qwen3-coder", label: "Qwen3 Coder" },
  { provider: "openrouter", id: "deepseek/deepseek-chat", label: "DeepSeek V3" },
  { provider: "openrouter", id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { provider: "openrouter", id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];

export const DEFAULT_MODEL_ID = "claude-opus-4-8";

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

// The Vercel AI SDK has no passthrough for OpenRouter's non-standard
// `plugins` body field, so we patch it in at the fetch layer. Only touches
// requests whose model is `openrouter/auto`; every other request (including
// concrete OpenRouter models) passes through untouched.
const autoRouterFetch = async (input: any, init?: any): Promise<Response> => {
  try {
    if (init && typeof init.body === "string") {
      const body = JSON.parse(init.body);
      if (body?.model === AUTO_ROUTER_MODEL_ID) {
        const existing = Array.isArray(body.plugins) ? body.plugins : [];
        body.plugins = [
          ...existing.filter((p: any) => p?.id !== "auto-router"),
          { id: "auto-router", cost_quality_tradeoff: _autoRouterCostBias },
        ];
        init = { ...init, body: JSON.stringify(body) };
      }
    }
  } catch {
    // Non-JSON body / parse failure — send the original request unchanged.
  }
  return fetch(input, init);
};

export function buildModel(spec: ModelSpec, apiKey: string): LanguageModel {
  switch (spec.provider) {
    case "anthropic": {
      // anthropic-beta:
      //  - interleaved-thinking-2025-05-14: lets Claude 4.x think
      //    BETWEEN tool calls within a turn (not just at the start).
      //    Big lift on multi-step debug / search-then-act flows.
      //    Auto-on for Opus 4.7 adaptive, beta-flagged for 4.5/4.6.
      //  - extended-cache-ttl-2025-04-11: unlocks the 1-hour cache
      //    TTL option on cache_control blocks. We use it on the
      //    stable system prompt so long sessions stop re-billing the
      //    prefix every time the 5-min idle window lapses.
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
        baseURL: "https://openrouter.ai/api/v1",
        headers: {
          "HTTP-Referer": "https://github.com/carl-wilson/vault-chat",
          "X-Title": "vault-chat",
        },
        // Injects the auto-router plugin config for `openrouter/auto`.
        fetch: autoRouterFetch,
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
  return /(-vl|vision|pixtral|llava|gpt-4|claude|gemini|llama-4|qwen.*2\.5|qwen3-vl)/i.test(spec.id);
}

export function findModel(id: string): ModelSpec | undefined {
  // OpenRouter's auto router is a virtual model — never in any catalog, but
  // a valid target the agent can send. Synthesize its spec so apiKey lookup
  // and the request path work.
  if (id === AUTO_ROUTER_MODEL_ID) {
    return { provider: "openrouter", id: AUTO_ROUTER_MODEL_ID, label: "Auto (OpenRouter)" };
  }
  return (_liveCatalog ?? MODELS).find((m) => m.id === id) ?? MODELS.find((m) => m.id === id);
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
