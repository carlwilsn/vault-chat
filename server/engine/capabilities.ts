// What each model can do on the engine (pi). Free by default:
//  - from the OpenRouter catalog (refreshed daily): tools, images, pdf, caching, context;
//  - subagents: a subagent is a pi process driven through tools, so they are on
//    wherever tool calls work;
//  - learned from real use: a request rejected over tools turns tools (and so
//    subagents) off; a subagent that ran turns subagents on.
// Learned entries live in $VC_STATE_DIR/capabilities.json, stamped with the pi
// version; after a pi upgrade they are `stale` and the defaults apply until
// re-learned.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { allModels, modelMeta } from "./catalog";

export type Capabilities = { tools: boolean; subagents: boolean; images: boolean; pdf: boolean; caching: boolean; context: number };
export type LearnedEntry = {
  model: string;
  version: string;
  testedAt: number;
  results: Partial<Record<"tools" | "subagents" | "images" | "pdf" | "caching", boolean>>;
  evidence: Record<string, string>;
};

let path = "";
let version = "";
let learned: Record<string, LearnedEntry> = {};

export function initCapabilities(statePath: string, runtimeVersion: string): void {
  path = statePath;
  version = runtimeVersion;
  try {
    learned = JSON.parse(readFileSync(path, "utf8")) ?? {};
  } catch {
    learned = {};
  }
}

function save(): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(learned, null, 1));
  } catch {
    /* best effort */
  }
}

const fresh = (e: LearnedEntry | undefined) => (e && e.version === version ? e : undefined);

export function capabilitiesOf(model: string): Capabilities & { source: "catalog" | "learned" | "untested"; status: "untested" | "tested" | "stale"; checkedAt: number | null } {
  const m = modelMeta(model);
  const raw = learned[model];
  const l = fresh(raw);
  const tools = l?.results.tools ?? (m?.supportedParameters ? m.supportedParameters.includes("tools") : true);
  const caps: Capabilities = {
    tools,
    images: !!m?.inputModalities?.includes("image"),
    pdf: !!m?.inputModalities?.includes("file"),
    caching: (m?.cacheRead ?? 0) > 0,
    context: m?.contextLength ?? 0,
    subagents: tools,
    ...(l?.results ?? {}),
  };
  if (!caps.tools) caps.subagents = false;
  return { ...caps, source: l ? "learned" : m ? "catalog" : "untested", status: l ? "tested" : raw ? "stale" : "untested", checkedAt: l?.testedAt ?? null };
}

/** Record an outcome of real use. Returns true when it changed something. */
export function learn(model: string, key: keyof LearnedEntry["results"], ok: boolean, evidence: string): boolean {
  const cur = fresh(learned[model]) ?? { model, version, testedAt: Date.now(), results: {}, evidence: {} };
  const changed = cur.results[key] !== ok;
  cur.results[key] = ok;
  cur.evidence[key] = evidence.slice(0, 300);
  cur.testedAt = Date.now();
  learned[model] = cur;
  save();
  return changed;
}

/** /api/v1/models: every catalog model plus anything learned. */
export function modelsList(): { id: string; capabilities: Capabilities; source: string; status: string; checkedAt: number | null }[] {
  const ids = new Set<string>([...allModels().map((m) => m.id), ...Object.keys(learned)]);
  return [...ids].sort().map((id) => {
    const { source, status, checkedAt, ...capabilities } = capabilitiesOf(id);
    return { id, capabilities, source, status, checkedAt };
  });
}

/** The developer-instruction note so the agent never promises what it can't do. */
export function capabilityNote(model: string): string {
  const c = capabilitiesOf(model);
  const lines: string[] = [];
  if (!c.subagents) lines.push("Subagents (helpers that work in parallel) are not available with this model: do the work yourself, one step at a time, and never promise fan-out.");
  if (!c.images) lines.push("This model cannot see images.");
  return lines.length ? `<capabilities model="${model}">\n${lines.join("\n")}\n</capabilities>` : "";
}

/** What each model the box itself runs needs (the box's side of Settings →
 *  Models): the chat agent (tools; images go to the vision model), the vision
 *  fallback for turns that carry images (a full turn: tools and images), and
 *  the subagent child model. Free: the catalog plus what real use taught. */
const CONTEXT_FLOOR = 64_000;
type BoxNeed = "tools" | "toolChoice" | "images" | "context";
const BOX_NEEDS: Record<"chat" | "vision" | "subagent", BoxNeed[]> = {
  chat: ["tools", "toolChoice", "context"],
  vision: ["tools", "toolChoice", "images", "context"],
  subagent: ["tools", "context"],
};

export type BoxModelCheck = { id: string; state: "passed" | "missing" | "unknown"; missing?: BoxNeed[]; context?: number };

export function boxModelChecks(ids: { chat: string; vision: string; subagent: string }): Record<"chat" | "vision" | "subagent", BoxModelCheck> {
  const one = (role: "chat" | "vision" | "subagent"): BoxModelCheck => {
    const id = ids[role];
    const m = modelMeta(id);
    const c = capabilitiesOf(id);
    if (!m && c.source === "untested") return { id, state: "unknown" };
    const have: Record<BoxNeed, boolean | undefined> = {
      tools: c.tools,
      toolChoice: m?.supportedParameters ? m.supportedParameters.includes("tool_choice") : undefined,
      images: c.images,
      context: c.context > 0 ? c.context >= CONTEXT_FLOOR : undefined,
    };
    const missing = BOX_NEEDS[role].filter((n) => have[n] === false);
    return { id, state: missing.length ? "missing" : "passed", ...(missing.length ? { missing } : {}), ...(c.context ? { context: c.context } : {}) };
  };
  return { chat: one("chat"), vision: one("vision"), subagent: one("subagent") };
}
