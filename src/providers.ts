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
];

export const DEFAULT_MODEL_ID = "claude-opus-4-8";

// Sentinel value stored in the model picker when the user selects "Auto".
// Auto mode classifies each message at send-time and routes to either a
// fast/cheap model (short conversational messages) or the full frontier
// model (complex/task-heavy requests) using whichever providers the user
// has API keys for. No extra API call is made — classification is local.
export const AUTO_MODEL_ID = "auto";

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
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
  // OpenRouter: opt-in by id substring.
  return /(-vl|vision|pixtral|llava|gpt-4|claude|gemini|llama-4|qwen.*2\.5|qwen3-vl)/i.test(spec.id);
}

export function findModel(id: string): ModelSpec | undefined {
  return (_liveCatalog ?? MODELS).find((m) => m.id === id) ?? MODELS.find((m) => m.id === id);
}

// ---------------------------------------------------------------------------
// Auto-mode routing
// ---------------------------------------------------------------------------

// Provider priority order when deciding which provider to use in auto mode.
// Earlier = preferred (typically whichever the user has a key for).
const PROVIDER_PRIORITY: ProviderId[] = ["anthropic", "openai", "google", "openrouter"];

// Fast (cheap) model ids to prefer per provider. Matched against the live
// catalog; falls back to the seed list. Pattern matched case-insensitively.
const FAST_PATTERN: Record<ProviderId, RegExp> = {
  anthropic: /haiku/i,
  openai: /mini/i,
  google: /flash/i,
  openrouter: /deepseek-chat|haiku|flash|mini|qwen3-coder/i,
};

// Full (capable) model ids per provider.
const FULL_PATTERN: Record<ProviderId, RegExp> = {
  anthropic: /sonnet|opus/i,
  openai: /gpt-4\.1$|gpt-4o$|gpt-5/i,
  google: /pro/i,
  openrouter: /235b|sonnet|opus|gpt-4/i,
};

// Keywords that suggest the request needs the full model. Keep it
// concise — false positives (routing heavy work to haiku) cost quality,
// false negatives (routing simple greetings to opus) just waste money.
const COMPLEX_KEYWORDS =
  /\b(code|implement|build|debug|refactor|analyze|analyse|write|create|edit|fix|read|explain|generate|script|function|class|test|deploy|search|find|how|why|what|compare|review|summarize|plan|design|improve|update|rename|delete|move)\b/i;

/**
 * Classify the user message as "simple" (conversational) or "complex"
 * (task-heavy). Returns true if the full model should be used.
 */
function isComplexMessage(message: string): boolean {
  const trimmed = message.trim();
  // Long messages almost certainly need the full model.
  if (trimmed.length > 120) return true;
  // Code fences or indented code blocks.
  if (/```|^\s{4}/m.test(trimmed)) return true;
  // File-path-like fragments.
  if (/[\/\\][a-zA-Z0-9_.-]+\.[a-zA-Z]{2,5}/.test(trimmed)) return true;
  // Task-oriented keywords.
  if (COMPLEX_KEYWORDS.test(trimmed)) return true;
  // Questions that are too short to be substantive are simple greetings.
  return false;
}

/**
 * Resolve the "auto" sentinel to a real ModelSpec.
 *
 * @param message  The user's raw message text.
 * @param apiKeys  Map of provider → API key (only set for providers that
 *                 the user has configured).
 * @param catalog  The live model catalog (or seed list as fallback).
 * @returns A ModelSpec to actually run, or null if no provider has a key.
 */
export function resolveAutoModel(
  message: string,
  apiKeys: Partial<Record<ProviderId, string>>,
  catalog: ModelSpec[] = _liveCatalog ?? MODELS,
): ModelSpec | null {
  // Pick the highest-priority provider that has a key.
  const provider = PROVIDER_PRIORITY.find((p) => !!apiKeys[p]);
  if (!provider) return null;

  const complex = isComplexMessage(message);
  const pattern = complex ? FULL_PATTERN[provider] : FAST_PATTERN[provider];

  // Search the live catalog first, then the seed list as a safety net.
  const candidates = [...catalog, ...MODELS].filter((m) => m.provider === provider);
  const match = candidates.find((m) => pattern.test(m.id));

  // Final fallback: first model for this provider in the catalog.
  return match ?? candidates[0] ?? null;
}
