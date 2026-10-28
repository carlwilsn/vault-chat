// OpenRouter model metadata (cached on disk, refreshed at boot and daily):
// context windows and capabilities for models pi's bundled catalog may lack.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ModelMeta = {
  id: string;
  contextLength: number;
  supportedParameters?: string[];
  inputModalities?: string[];
  cacheRead?: number;
};


let byId = new Map<string, ModelMeta>();

function parseCatalog(json: any): Map<string, ModelMeta> {
  const out = new Map<string, ModelMeta>();
  const rows: any[] = Array.isArray(json?.data) ? json.data : [];
  for (const r of rows) {
    if (typeof r?.id !== "string") continue;
    const ctx = Number(r.context_length ?? r.top_provider?.context_length);
    if (!(Number.isFinite(ctx) && ctx > 0)) continue;
    const cr = Number(r.pricing?.input_cache_read);
    out.set(r.id, {
      id: r.id,
      contextLength: ctx,
      supportedParameters: Array.isArray(r.supported_parameters) ? r.supported_parameters : undefined,
      inputModalities: Array.isArray(r.architecture?.input_modalities) ? r.architecture.input_modalities : undefined,
      cacheRead: Number.isFinite(cr) ? cr : undefined,
    });
  }
  return out;
}

/** Load the cached catalog, then try to refresh it (bounded wait). Never throws. */
export async function loadCatalog(cachePath: string, timeoutMs = 15_000): Promise<{ models: number; source: "live" | "cache" | "none" }> {
  try {
    byId = parseCatalog(JSON.parse(readFileSync(cachePath, "utf8")));
  } catch {
    byId = new Map();
  }
  let source: "live" | "cache" | "none" = byId.size ? "cache" : "none";
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // Keep the deadline through body consumption: headers alone do not mean
    // the catalog arrived, and engine startup awaits this refresh.
    const r = await fetch("https://openrouter.ai/api/v1/models", { signal: ctl.signal });
    if (r.ok) {
      const json = await r.json();
      const live = parseCatalog(json);
      if (live.size) {
        byId = live;
        source = "live";
        try {
          mkdirSync(dirname(cachePath), { recursive: true });
          writeFileSync(
            cachePath,
            JSON.stringify({
              data: [...live.values()].map((m) => ({
                id: m.id,
                context_length: m.contextLength,
                supported_parameters: m.supportedParameters,
                architecture: { input_modalities: m.inputModalities },
                pricing: m.cacheRead !== undefined ? { input_cache_read: String(m.cacheRead) } : {},
              })),
            }),
          );
        } catch {
          /* cache is best effort */
        }
      }
    }
  } catch {
    /* offline: keep the cache */
  } finally {
    clearTimeout(t);
  }
  return { models: byId.size, source };
}

export function allModels(): ModelMeta[] {
  return [...byId.values()];
}

export function modelMeta(id: string): ModelMeta | undefined {
  return byId.get(id);
}

/** Test hook. */
export function setCatalogForTests(models: ModelMeta[]): void {
  byId = new Map(models.map((m) => [m.id, m]));
}
