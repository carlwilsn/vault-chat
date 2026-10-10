// What each model can do, for the small capability view in Settings → Models.
//
// Two sources, merged per model:
//  • catalog — OpenRouter's public /api/v1/models (tools, image and file
//    input, cache pricing). Cached here for 24 h.
//  • learned — what the box has seen in real use (Phase 2's capability table:
//    helpers, plus corrections to the catalog). Nothing writes it yet; the box
//    will, and the preview seeds it. It wins over the catalog.
// A model in neither is "untested". `helpers` (subagents) is never in the
// catalog: it is known only once learned.

export type CapKey = "tools" | "images" | "pdf" | "caching" | "helpers";
export const CAP_KEYS: CapKey[] = ["tools", "images", "pdf", "caching", "helpers"];
export type CapSource = "catalog" | "learned" | "untested";
/** true = yes, false = no, missing = unknown. */
export type Caps = Partial<Record<CapKey, boolean>>;
export type ModelCaps = { id: string; caps: Caps; source: CapSource };

const CATALOG_CACHE = "vault_chat_model_caps";
const LEARNED = "vault_chat_model_caps_learned";
const TTL_MS = 24 * 60 * 60 * 1000;

type OrModel = {
  id: string;
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
  pricing?: { input_cache_read?: string };
};

function fromOpenRouter(m: OrModel): Caps {
  const inMods = m.architecture?.input_modalities ?? [];
  return {
    tools: (m.supported_parameters ?? []).includes("tools"),
    images: inMods.includes("image"),
    pdf: inMods.includes("file"),
    caching: Number(m.pricing?.input_cache_read ?? 0) > 0,
  };
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function catalogCaps(): Promise<Record<string, Caps>> {
  const cached = readJson<{ fetchedAt: number; models: Record<string, Caps> }>(CATALOG_CACHE);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.models;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) throw new Error(`openrouter ${res.status}`);
    const json = (await res.json()) as { data: OrModel[] };
    const models: Record<string, Caps> = {};
    for (const m of json.data) models[m.id] = fromOpenRouter(m);
    try {
      localStorage.setItem(CATALOG_CACHE, JSON.stringify({ fetchedAt: Date.now(), models }));
    } catch {
      /* a cache */
    }
    return models;
  } catch {
    return cached?.models ?? {};
  }
}

/** Ids as the pickers store them: OpenRouter's "vendor/model", or a direct
 *  provider's bare id, which matches the catalog's "<any>/<id>". */
function lookup<T>(map: Record<string, T>, id: string): T | undefined {
  if (map[id]) return map[id];
  const k = Object.keys(map).find((x) => x.endsWith("/" + id));
  return k ? map[k] : undefined;
}

export async function loadModelCaps(ids: string[]): Promise<ModelCaps[]> {
  const catalog = await catalogCaps();
  const learned = readJson<Record<string, Caps>>(LEARNED) ?? {};
  return ids.map((id) => {
    const c = lookup(catalog, id);
    const l = lookup(learned, id);
    if (l) return { id, caps: { ...c, ...l }, source: "learned" };
    if (c) return { id, caps: c, source: "catalog" };
    return { id, caps: {}, source: "untested" };
  });
}
