// What each model can do through Codex. Free by default:
//  - from the OpenRouter catalog (refreshed daily): tools, images, pdf, caching, context;
//  - learned from real use: subagents (Codex multi_agent) start ON for openai/*
//    and OFF-unverified for everything else; a real subagent spawn turns them on,
//    a request rejected over the `namespace` tool type turns them off (the turn
//    is retried once without them). A tool-call failure turns tools off.
// Learned entries live in $VC_STATE_DIR/capabilities.json, stamped with the
// Codex version; after a Codex upgrade they are `stale` and the defaults apply
// until re-learned. server/engine/capabilities.json is the shipped seed (the
// measured probes, with evidence). A paid probe runs only on request.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { allModels, modelMeta } from "./catalog";
import SEED from "./capabilities.json";

export type Capabilities = { tools: boolean; subagents: boolean; images: boolean; pdf: boolean; caching: boolean; context: number };
export type LearnedEntry = {
  model: string;
  codexVersion: string;
  testedAt: number;
  results: Partial<Record<"tools" | "subagents" | "images" | "pdf" | "caching", boolean>>;
  evidence: Record<string, string>;
};

let path = "";
let codexVersion = "";
let learned: Record<string, LearnedEntry> = {};
const probing = new Set<string>();

export function initCapabilities(statePath: string, version: string): void {
  path = statePath;
  codexVersion = version;
  try {
    learned = JSON.parse(readFileSync(path, "utf8")) ?? {};
  } catch {
    learned = {};
  }
  // The shipped seed counts as learned for its Codex version.
  for (const e of (SEED as { entries?: LearnedEntry[] }).entries ?? []) {
    if (!learned[e.model]) learned[e.model] = e;
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

function fresh(e: LearnedEntry | undefined): LearnedEntry | undefined {
  return e && e.codexVersion === codexVersion ? e : undefined;
}

export function capabilitiesOf(model: string): Capabilities & { source: "catalog" | "learned" | "untested"; status: "probing" | "untested" | "tested" | "stale"; checkedAt: number | null } {
  const m = modelMeta(model);
  const raw = learned[model];
  const l = fresh(raw);
  const cat: Capabilities = {
    tools: m?.supportedParameters ? m.supportedParameters.includes("tools") : true,
    images: !!m?.inputModalities?.includes("image"),
    pdf: !!m?.inputModalities?.includes("file"),
    caching: (m?.cacheRead ?? 0) > 0,
    context: m?.contextLength ?? 0,
    subagents: model.startsWith("openai/"),
  };
  const caps = { ...cat, ...(l?.results ?? {}) } as Capabilities;
  return {
    ...caps,
    source: l ? "learned" : m ? "catalog" : "untested",
    status: probing.has(model) ? "probing" : l ? "tested" : raw ? "stale" : "untested",
    checkedAt: l?.testedAt ?? null,
  };
}

/** Record an outcome of real use (or a probe). Returns true when it changed something. */
export function learn(model: string, key: keyof LearnedEntry["results"], ok: boolean, evidence: string): boolean {
  const cur = fresh(learned[model]) ?? { model, codexVersion, testedAt: Date.now(), results: {}, evidence: {} };
  const changed = cur.results[key] !== ok;
  cur.results[key] = ok;
  cur.evidence[key] = evidence.slice(0, 300);
  cur.testedAt = Date.now();
  learned[model] = cur;
  save();
  return changed;
}

export function setProbing(model: string, on: boolean): void {
  if (on) probing.add(model);
  else probing.delete(model);
}

/** /api/v1/models: every catalog model plus anything learned. */
export function modelsList(): { id: string; capabilities: Capabilities; source: string; status: string; checkedAt: number | null }[] {
  const ids = new Set<string>([...allModels().map((m) => m.id), ...Object.keys(learned)]);
  return [...ids].sort().map((id) => {
    const c = capabilitiesOf(id);
    const { source, status, checkedAt, ...capabilities } = c;
    return { id, capabilities, source, status, checkedAt };
  });
}

/** A namespace-type rejection (Codex #32318) in an error from the provider. */
export function isNamespaceRejection(err: string): boolean {
  return /namespace/i.test(err) && /(tool type|support|not supported|No endpoints)/i.test(err);
}

/** The developer-instruction note so the agent never promises what it can't do. */
export function capabilityNote(model: string): string {
  const c = capabilitiesOf(model);
  const lines: string[] = [];
  if (!c.subagents) lines.push("Subagents (helpers that work in parallel) are not available with this model: do the work yourself, one step at a time, and never promise fan-out.");
  if (!c.images) lines.push("This model cannot see images.");
  return lines.length ? `<capabilities model="${model}">\n${lines.join("\n")}\n</capabilities>` : "";
}
