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

  // Stable order: provider group, then label.
  const order: Record<ProviderId, number> = {
    anthropic: 0,
    openai: 1,
    google: 2,
    openrouter: 3,
  };
  merged.sort(
    (a, b) => order[a.provider] - order[b.provider] || a.label.localeCompare(b.label),
  );

  return { models: merged, errors };
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
