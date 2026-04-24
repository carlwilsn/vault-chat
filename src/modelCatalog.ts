import type { ModelSpec, ProviderId } from "./providers";
import { MODELS as SEED_MODELS } from "./providers";

// Each provider exposes a /models endpoint. We query them at runtime
// so the model list stays current without a code change. Failures are
// swallowed per-provider — a dead OpenAI key shouldn't wipe your
// Anthropic models.

const CATALOG_LS_KEY = "vault_chat_model_catalog";

type ApiKeys = Partial<Record<ProviderId, string>>;

async function fetchAnthropic(apiKey: string): Promise<ModelSpec[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const json = (await res.json()) as { data: Array<{ id: string; display_name?: string }> };
  return json.data.map((m) => ({
    provider: "anthropic" as const,
    id: m.id,
    label: m.display_name ?? m.id,
  }));
}

async function fetchOpenAI(apiKey: string): Promise<ModelSpec[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const json = (await res.json()) as { data: Array<{ id: string }> };
  // OpenAI returns embeddings, whisper, tts, dall-e, moderation — keep
  // only chat-capable families.
  const chat = /^(gpt-|o1|o3|o4|chatgpt)/i;
  const drop = /(embedding|whisper|tts|dall-e|moderation|audio|transcribe|image|realtime|-instruct$)/i;
  return json.data
    .filter((m) => chat.test(m.id) && !drop.test(m.id))
    .map((m) => ({ provider: "openai" as const, id: m.id, label: m.id }));
}

async function fetchGoogle(apiKey: string): Promise<ModelSpec[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`,
  );
  if (!res.ok) throw new Error(`google ${res.status}`);
  const json = (await res.json()) as {
    models: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
  };
  return json.models
    .filter(
      (m) =>
        m.name.startsWith("models/gemini-") &&
        (m.supportedGenerationMethods ?? []).includes("generateContent"),
    )
    .map((m) => {
      const id = m.name.replace(/^models\//, "");
      return { provider: "google" as const, id, label: m.displayName ?? id };
    });
}

async function fetchOpenRouter(_apiKey?: string): Promise<ModelSpec[]> {
  // OpenRouter's /models is public — no auth required just to list.
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`openrouter ${res.status}`);
  const json = (await res.json()) as { data: Array<{ id: string; name?: string }> };
  return json.data.map((m) => ({
    provider: "openrouter" as const,
    id: m.id,
    label: m.name ?? m.id,
  }));
}

/** Fetch every provider in parallel, swallowing per-provider errors.
 *  Providers without a key (except OpenRouter, which doesn't need one
 *  to list) are skipped. */
export async function fetchAllCatalog(
  apiKeys: ApiKeys,
): Promise<{ models: ModelSpec[]; errors: Partial<Record<ProviderId, string>> }> {
  const errors: Partial<Record<ProviderId, string>> = {};
  const tasks: Array<Promise<ModelSpec[]>> = [];

  const run = <P extends ProviderId>(p: P, fn: () => Promise<ModelSpec[]>) => {
    tasks.push(
      fn().catch((e) => {
        errors[p] = e instanceof Error ? e.message : String(e);
        return [] as ModelSpec[];
      }),
    );
  };

  if (apiKeys.anthropic) run("anthropic", () => fetchAnthropic(apiKeys.anthropic!));
  if (apiKeys.openai) run("openai", () => fetchOpenAI(apiKeys.openai!));
  if (apiKeys.google) run("google", () => fetchGoogle(apiKeys.google!));
  // OpenRouter always — list is public. Gives users a browse-able
  // catalog even before they paste a key.
  run("openrouter", () => fetchOpenRouter(apiKeys.openrouter));

  const results = await Promise.all(tasks);
  const merged = results.flat();

  // Fall back to seed models for any provider that returned nothing
  // (e.g. no key set, or request failed). This keeps the dropdown from
  // going empty on transient errors.
  const gotProvider = new Set(merged.map((m) => m.provider));
  for (const seed of SEED_MODELS) {
    if (!gotProvider.has(seed.provider)) merged.push(seed);
  }

  // Rank roughly by capability so the strongest frontier models show
  // up at the top of the dropdown. Ties fall back to label for a
  // stable alphabetic secondary sort.
  merged.sort((a, b) => modelPowerRank(b) - modelPowerRank(a) || a.label.localeCompare(b.label));

  return { models: merged, errors };
}

// Heuristic "how powerful is this model" score. Not benchmarks — id-
// pattern rules keyed to the naming conventions each provider uses in
// April 2026. Higher is more capable. Used only for dropdown ordering;
// updates as new model families ship are an id-pattern edit below.
function modelPowerRank(spec: ModelSpec): number {
  const id = spec.id.toLowerCase();

  if (spec.provider === "anthropic") {
    const v = versionScore(id); // e.g. 4.7 → 407
    if (id.includes("opus")) return 10_000 + v;
    if (id.includes("sonnet")) return 9_000 + v;
    if (id.includes("haiku")) return 8_000 + v;
    return 7_000 + v;
  }

  if (spec.provider === "openai") {
    if (/^gpt-5/.test(id) && /thinking|max|xhigh/.test(id)) return 9_700;
    if (/^gpt-5/.test(id)) return 9_500;
    if (/^o3.*pro/.test(id)) return 9_400;
    if (/^o3/.test(id)) return 9_200;
    if (/^o4/.test(id)) return 9_100;
    if (/^o1/.test(id)) return 8_800;
    if (/^gpt-4\.5/.test(id)) return 8_700;
    if (/^gpt-4\.1/.test(id) && !/mini/.test(id)) return 8_500;
    if (/^gpt-4o/.test(id) && !/mini/.test(id)) return 8_300;
    if (/^gpt-4/.test(id) && !/mini/.test(id)) return 8_000;
    if (/mini/.test(id)) return 7_500;
    return 7_000;
  }

  if (spec.provider === "google") {
    const v = versionScore(id); // e.g. 3.1 → 301
    if (/pro/.test(id)) return 9_000 + v;
    if (/flash/.test(id)) return 7_500 + v;
    return 7_000 + v;
  }

  if (spec.provider === "openrouter") {
    // Frontier models routed through OR inherit their native rank.
    if (/anthropic\/claude-opus/i.test(id)) return 10_000 + versionScore(id);
    if (/anthropic\/claude-sonnet/i.test(id)) return 9_000 + versionScore(id);
    if (/anthropic\/claude-haiku/i.test(id)) return 8_000 + versionScore(id);
    if (/openai\/gpt-5/i.test(id)) return 9_500;
    if (/openai\/gpt-4\.1/i.test(id)) return 8_500;
    if (/google\/gemini-.*-pro/i.test(id)) return 9_000 + versionScore(id);
    if (/google\/gemini-.*-flash/i.test(id)) return 7_500 + versionScore(id);
    // Best-in-class open weights (April 2026).
    if (/qwen3\.6/i.test(id)) return 7_400;
    if (/qwen3.*235b/i.test(id)) return 7_200;
    if (/qwen3-coder/i.test(id)) return 7_100;
    if (/deepseek.*r1/i.test(id)) return 7_000;
    if (/deepseek.*v3/i.test(id) || /deepseek.*chat/i.test(id)) return 6_800;
    if (/glm-5/i.test(id)) return 7_000;
    if (/llama-4/i.test(id)) return 6_500;
    if (/llama-3\.3/i.test(id)) return 6_000;
    // Fall back to parsed parameter count, capped.
    const sizeMatch = id.match(/(\d+(?:\.\d+)?)b(?!\w)/);
    if (sizeMatch) return 4_000 + Math.min(parseFloat(sizeMatch[1]), 500);
    return 4_000;
  }

  return 0;
}

// Extract "major.minor" from anywhere in the id; 0 if absent.
function versionScore(id: string): number {
  const m = id.match(/(\d+)[.\-](\d+)/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
}

export function loadCatalogFromLocalStorage(): ModelSpec[] | null {
  try {
    const raw = localStorage.getItem(CATALOG_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as ModelSpec[];
  } catch {
    return null;
  }
}

export function saveCatalogToLocalStorage(models: ModelSpec[]): void {
  try {
    localStorage.setItem(CATALOG_LS_KEY, JSON.stringify(models));
  } catch {
    // non-fatal — catalog is a cache
  }
}
