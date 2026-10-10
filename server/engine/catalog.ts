// OpenRouter model metadata for Codex. Codex knows nothing about OpenRouter
// model ids and falls back to a generic 258k window, so the server reads the
// catalog (cached on disk, refreshed at boot) and hands Codex each model's real
// window and an auto-compaction limit.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ModelMeta = { id: string; contextLength: number };

const FALLBACK_WINDOW = 200_000;
/** Codex compacts at this fraction of the window… */
const COMPACT_FRACTION = 0.8;
/** …but never later than this many tokens: a 1M-window model re-reading 800k
 * tokens on every call costs dollars per call. VC_CODEX_COMPACT_CAP overrides. */
const DEFAULT_COMPACT_CAP = 200_000;

let byId = new Map<string, ModelMeta>();

function parseCatalog(json: any): Map<string, ModelMeta> {
  const out = new Map<string, ModelMeta>();
  const rows: any[] = Array.isArray(json?.data) ? json.data : [];
  for (const r of rows) {
    if (typeof r?.id !== "string") continue;
    const ctx = Number(r.context_length ?? r.top_provider?.context_length);
    if (Number.isFinite(ctx) && ctx > 0) out.set(r.id, { id: r.id, contextLength: ctx });
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
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch("https://openrouter.ai/api/v1/models", { signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) {
      const json = await r.json();
      const live = parseCatalog(json);
      if (live.size) {
        byId = live;
        source = "live";
        try {
          mkdirSync(dirname(cachePath), { recursive: true });
          writeFileSync(cachePath, JSON.stringify({ data: [...live.values()].map((m) => ({ id: m.id, context_length: m.contextLength })) }));
        } catch {
          /* cache is best effort */
        }
      }
    }
  } catch {
    /* offline: keep the cache */
  }
  return { models: byId.size, source };
}

export function modelMeta(id: string): ModelMeta | undefined {
  return byId.get(id);
}

/** Codex's per-model limits for `model`, from the catalog. */
export function codexLimits(model: string): { model_context_window: number; model_auto_compact_token_limit: number } {
  const ctx = byId.get(model)?.contextLength ?? FALLBACK_WINDOW;
  const capEnv = Number(process.env.VC_CODEX_COMPACT_CAP);
  const cap = Number.isFinite(capEnv) && capEnv > 0 ? capEnv : DEFAULT_COMPACT_CAP;
  return {
    model_context_window: ctx,
    model_auto_compact_token_limit: Math.max(8_000, Math.min(Math.floor(ctx * COMPACT_FRACTION), cap)),
  };
}

/** Test hook. */
export function setCatalogForTests(models: ModelMeta[]): void {
  byId = new Map(models.map((m) => [m.id, m]));
}
