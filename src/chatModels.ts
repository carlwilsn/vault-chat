// The models a chat can run on, and how hard it thinks.
//
// Both are per chat, set in the composer beside Send, and they live on the
// conversation itself — so the phone and the laptop show the same choice, and it
// survives a restart. The box applies a model change to the running session and
// restarts the session for an effort change (server/engine/engine.ts
// setChatModel); a NEW chat starts from the last choice made.
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

let models: ChatModel[] = [];
/** The model a chat that has not chosen runs on (the box's last choice). */
let fallback = "";
let link = "";
const subs = new Set<(m: ChatModel[]) => void>();
const publish = (m: ChatModel[]) => {
  models = m;
  for (const f of subs) f(models);
};

/** The box's list, read once per box. Nothing to pick without one. */
export async function refreshChatModels(vault: string): Promise<void> {
  const l = await boxLinkFor(vault);
  if (!l) {
    link = "";
    return publish([]);
  }
  if (l.url === link && models.length) return;
  const r = await boxGet(l, "/api/v1/models", 15_000).catch(() => null);
  if (!r || !Array.isArray(r.models)) return;
  link = l.url;
  if (typeof r.default === "string") fallback = r.default;
  publish(
    (r.models as Record<string, unknown>[])
      .map((m) => ({
        id: String(m.id ?? ""),
        name: String(m.name ?? ""),
        efforts: (Array.isArray(m.efforts) ? m.efforts : []).filter(isEffort),
      }))
      .filter((m) => m.id && m.name),
  );
}

/** Set this chat's model and/or effort on the box. Null effort: the model decides. */
export async function setChatModel(vault: string, convId: string, patch: { model?: string; effort?: Effort | null }): Promise<string | null> {
  const l = await boxLinkFor(vault);
  if (!l) return "no box is connected";
  const r = await boxPost(l, `/api/v1/conversations/${encodeURIComponent(convId)}/model`, patch);
  return r.ok ? null : (r.error ?? "the box refused");
}

export function useChatModels(): ChatModel[] {
  const vault = useStore((s) => s.vaultPath);
  const on = useStore((s) => !!s.boxChat?.on);
  const [s, setS] = useState(models);
  useEffect(() => {
    subs.add(setS);
    return () => {
      subs.delete(setS);
    };
  }, []);
  useEffect(() => {
    if (on && vault) void refreshChatModels(vault);
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

/** What a chat that has chosen nothing is running on, as the box last said. */
export const defaultModel = (): string => fallback;
