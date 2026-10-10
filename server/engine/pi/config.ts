// pi's files under $VC_STATE_DIR/pi/: the agent dir (settings.json with
// per-model compaction, models.json for models pi's bundled catalog lacks),
// the extension and its tool list, per-session instruction files, sessions.
// The agent can read none of the key store and write none of this (the
// sandbox makes $VC_STATE_DIR read-only, the extension's guard denies it).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renameRetry } from "../../atomic";
import { modelMeta } from "../catalog";
import { rollThreshold } from "../context";
import EXT_SOURCE from "./ext/vc.mjs?raw";
import POLICY_SOURCE from "./ext/policy.mjs?raw";
import type { PiInstall } from "./install";

export type PiPaths = {
  root: string;
  agentDir: string;
  extDir: string;
  ext: string;
  toolsJson: string;
  sessionsDir: string;
  instrDir: string;
  pidsFile: string;
};

export function piPaths(stateDir: string): PiPaths {
  const root = join(stateDir, "pi");
  const extDir = join(root, "ext");
  return {
    root,
    agentDir: join(root, "agent"),
    extDir,
    ext: join(extDir, "vc.mjs"),
    toolsJson: join(extDir, "tools.json"),
    sessionsDir: join(root, "sessions"),
    instrDir: join(root, "instr"),
    pidsFile: join(root, "pids.json"),
  };
}

function writeAtomic(p: string, s: string): void {
  writeFileSync(p + ".tmp", s);
  renameRetry(p + ".tmp", p);
}

/** pi's own catalog (openrouter): id → {context, images}. Read once per boot with an empty agent dir. */
export type PiCatalogRow = { context: number | null; images: boolean };
export function listPiModels(inst: PiInstall): Map<string, PiCatalogRow> {
  const out = new Map<string, PiCatalogRow>();
  const dir = mkdtempSync(join(tmpdir(), "vc-pi-list-"));
  try {
    const r = spawnSync(inst.node, [inst.cli, "--list-models", "openrouter"], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
      // A placeholder key only so pi lists the provider; offline, no network.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", OPENROUTER_API_KEY: "listing-only" },
    });
    for (const line of (r.stdout ?? "").split("\n")) {
      const m = /^openrouter\s+(\S+)\s+(\S+)\s+\S+\s+\S+\s+(\S+)/.exec(line.trim());
      if (!m) continue;
      out.set(m[1]!, { context: parseSize(m[2]!), images: m[3] === "yes" });
    }
  } catch {
    /* empty: every model gets defined from OpenRouter's catalog */
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

function parseSize(s: string): number | null {
  const m = /^([\d.]+)([KM]?)$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(n * (m[2]!.toUpperCase() === "M" ? 1_000_000 : m[2] ? 1000 : 1));
}

export function modelWindow(model: string, cat: Map<string, PiCatalogRow>): number {
  return modelMeta(model)?.contextLength ?? cat.get(model)?.context ?? 200_000;
}

/** pi compacts at this many tokens: a quarter above CONTEXT's roll threshold, so roll-over (a recap + new session) wins. */
export function compactAt(model: string, window: number): number {
  return Math.max(8_000, Math.min(window - 16_384, Math.floor(rollThreshold(model, window) * 1.25)));
}

export type PiConfigInput = {
  paths: PiPaths;
  install: PiInstall;
  catalog: Map<string, PiCatalogRow>;
  /** The models this boot may use (agent, vision). */
  models: string[];
  /** OpenRouter base override (tests: the fake). */
  baseUrl?: string;
  toolSpecs: unknown[];
};

/** Write settings.json, models.json, the extension and tools.json. */
export function writePiConfig(c: PiConfigInput): void {
  const p = c.paths;
  for (const d of [p.root, p.agentDir, p.extDir, p.sessionsDir, p.instrDir]) mkdirSync(d, { recursive: true });
  const openaiBase = (c.baseUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const anthropicBase = openaiBase.replace(/\/v1$/, "");
  const overrides: Record<string, { reserveTokens: number; keepRecentTokens: number }> = {};
  const defined: any[] = [];
  for (const m of [...new Set(c.models.filter(Boolean))]) {
    const w = modelWindow(m, c.catalog);
    overrides[`openrouter/${m}`] = { reserveTokens: Math.max(16_384, w - compactAt(m, w)), keepRecentTokens: 20_000 };
    if (!c.catalog.has(m)) {
      const meta = modelMeta(m);
      defined.push({
        id: m,
        name: m,
        api: /^anthropic\//.test(m) ? "anthropic-messages" : "openai-completions",
        baseUrl: /^anthropic\//.test(m) ? anthropicBase : openaiBase,
        reasoning: true,
        input: (meta?.inputModalities ?? ["text", "image"]).includes("image") ? ["text", "image"] : ["text"],
        contextWindow: w,
        maxTokens: 32_000,
        // pi's own price is never used for the ledger (OpenRouter's cost is).
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    }
  }
  const settings = {
    compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, modelOverrides: overrides },
    retry: { enabled: true, maxRetries: 4, baseDelayMs: 2000, maxAgentDelayMs: 60_000 },
    quietStartup: true,
  };
  writeAtomic(join(p.agentDir, "settings.json"), JSON.stringify(settings, null, 2));
  const provider: Record<string, unknown> = {};
  if (c.baseUrl) provider.baseUrl = c.baseUrl;
  if (defined.length) provider.models = defined;
  writeAtomic(join(p.agentDir, "models.json"), JSON.stringify({ providers: Object.keys(provider).length ? { openrouter: provider } : {} }, null, 2));
  writeAtomic(p.ext, EXT_SOURCE);
  writeAtomic(join(p.extDir, "policy.mjs"), POLICY_SOURCE);
  writeAtomic(p.toolsJson, JSON.stringify(c.toolSpecs));
}
