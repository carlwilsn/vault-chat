// The models a chat can run on, and how hard it thinks.
//
// Both are one global setting, set in the composer beside Send. The box stores
// them once, so every chat on every device runs on and shows the same choice and
// it survives a restart. The box applies a model change to the running session and
// restarts the session for an effort change (server/engine/engine.ts setChatModel).
//
// The names are the runtime's own: Claude Code reports what each model is
// called ("Opus 5.5"), so there is no table in here to go stale, and a raw id
// (`opus`, `claude-opus-5-5`) is never shown to Carl.
import { useEffect, useState } from "react";
import { useStore } from "./store";
import { boxGet, boxLinkFor, boxPost } from "./boxChat";

export const EFFORTS = ["low", "medium", "high", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const EFFORT_LABEL: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", max: "Max" };
export const isEffort = (e: unknown): e is Effort => typeof e === "string" && (EFFORTS as readonly string[]).includes(e);

export type ChatModel = { id: string; name: string; efforts: Effort[] };

// ONE setting for the whole box, the same in every chat and on every device
// (Carl, 2026-11-10): the box stores it, the laptop reads it back on a timer and
// on focus, and a copy in localStorage keeps the picker showing the last known
// value while the box is slow or away — so the picker always renders.
const CACHE = "vault-chat.model-picker";
type Snapshot = { models: ChatModel[]; model: string; effort: Effort | null };
const loadCache = (): Snapshot => {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE) ?? "null") as Partial<Snapshot> | null;
    if (c && Array.isArray(c.models)) return { models: c.models, model: typeof c.model === "string" ? c.model : "", effort: isEffort(c.effort) ? c.effort : null };
  } catch {
    /* no cache yet */
  }
  return { models: [], model: "", effort: null };
};
let snap: Snapshot = loadCache();
const subs = new Set<(s: Snapshot) => void>();
const publish = (next: Snapshot) => {
  snap = next;
  try {
    localStorage.setItem(CACHE, JSON.stringify(next));
  } catch {
    /* the box is the record */
  }
  for (const f of subs) f(snap);
};

/** Read the box's list and the global model/effort. A failed read keeps what is shown. */
export async function refreshChatModels(vault: string): Promise<void> {
  const l = await boxLinkFor(vault);
  if (!l) return;
  const r = await boxGet(l, "/api/v1/models", 15_000).catch(() => null);
  if (!r || !Array.isArray(r.models)) return;
  const list = (r.models as Record<string, unknown>[])
    .map((m) => ({
      id: String(m.id ?? ""),
      name: String(m.name ?? ""),
      efforts: (Array.isArray(m.efforts) ? m.efforts : []).filter(isEffort),
    }))
    .filter((m) => m.id && m.name);
  const model = typeof r.default === "string" ? r.default : snap.model;
  const effort = isEffort(r.effort) ? r.effort : null;
  const same = (a: Snapshot) => a.model === model && a.effort === effort && JSON.stringify(a.models) === JSON.stringify(list);
  if (!same(snap)) publish({ models: list.length ? list : snap.models, model, effort });
}

/** Set the model and/or effort for every chat, on the box. Null effort: the model decides. */
export async function setChatModel(vault: string, _convId: string | null, patch: { model?: string; effort?: Effort | null }): Promise<string | null> {
  const l = await boxLinkFor(vault);
  if (!l) return "no box is connected";
  const before = snap;
  // Show the pick at once; the box's answer corrects it if it refuses.
  publish({ ...snap, ...(patch.model ? { model: patch.model } : {}), ...(patch.effort !== undefined ? { effort: patch.effort } : {}) });
  const r = await boxPost(l, "/api/v1/model", patch);
  if (!r.ok) publish(before);
  return r.ok ? null : (r.error ?? "the box refused");
}

/** The global model, effort and list, kept fresh: read on mount, every 15 s (every 5 s until a list arrives), and when the window regains focus. */
export function useChatModels(): Snapshot {
  const vault = useStore((s) => s.vaultPath);
  const on = useStore((s) => !!s.boxChat?.on);
  const [s, setS] = useState(snap);
  useEffect(() => {
    subs.add(setS);
    setS(snap);
    return () => {
      subs.delete(setS);
    };
  }, []);
  useEffect(() => {
    if (!vault) return;
    const go = () => void refreshChatModels(vault);
    go();
    const t = setInterval(go, 15_000);
    // Until a list has arrived (box starting, engine not up) look again every 5 s.
    const quick = setInterval(() => snap.models.length || go(), 5_000);
    window.addEventListener("focus", go);
    return () => {
      clearInterval(t);
      clearInterval(quick);
      window.removeEventListener("focus", go);
    };
  }, [on, vault]);
  return s;
}

/** This chat's model as Carl reads it, from the box's list. */
export const nameOf = (list: readonly ChatModel[], id: string | undefined): string | null => (id ? (list.find((m) => m.id === id)?.name ?? null) : null);

/**
 * A Claude id read as a name, for the one case the box's list cannot cover: a
 * chat still on a model the picker no longer offers (the generation before the
 * current one). "claude-opus-4-6" → "Opus 4.6". Carl is told what his chat is
 * really on rather than the name of a model it is not.
 */
export function readableId(id: string): string {
  const parts = id.replace(/^claude-/, "").split("-").filter(Boolean);
  const family = parts.shift();
  if (!family) return id;
  const name = family[0]!.toUpperCase() + family.slice(1);
  const version = parts.filter((p) => /^\d+$/.test(p)).join(".");
  return version ? `${name} ${version}` : name;
}

/** What to show for the model a chat is on: the box's name for it, or the id read as one. */
export const labelFor = (list: readonly ChatModel[], id: string | undefined): string | null => (id ? (nameOf(list, id) ?? readableId(id)) : null);

