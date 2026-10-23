// The agent's model: the one model pi runs on the box, for everything (typed and spoken). One setting,
// changed from Settings → Models or the composer's picker (both use this), kept on the box
// (POST /api/v1/models/agent); the list is the box's (GET /api/v1/models).
import { useEffect, useState } from "react";
import { useStore } from "./store";
import { boxGet, boxLinkFor, boxPost } from "./boxChat";

export type AgentModelState = { current: string | null; options: string[]; error: string | null };

let state: AgentModelState = { current: null, options: [], error: null };
const subs = new Set<(s: AgentModelState) => void>();
const set = (patch: Partial<AgentModelState>) => {
  state = { ...state, ...patch };
  for (const f of subs) f(state);
};

/** Read the box's model and its list (no box: nothing to pick). */
export async function refreshAgentModel(): Promise<void> {
  const link = await boxLinkFor(useStore.getState().vaultPath);
  if (!link) return set({ current: null, options: [] });
  const r = await boxGet(link, "/api/v1/models", 15_000).catch(() => null);
  if (!r) return;
  const options = (Array.isArray(r.models) ? r.models : []).map((m: { id?: unknown }) => String(m?.id ?? "")).filter(Boolean);
  const current = typeof r.box?.chat?.id === "string" ? r.box.chat.id : state.current;
  set({ current, options, error: null });
}

/** Change the agent's model on the box (every thread's next turn runs on it). */
export async function setAgentModel(id: string): Promise<boolean> {
  const link = await boxLinkFor(useStore.getState().vaultPath);
  if (!link) return false;
  const before = state.current;
  set({ current: id, error: null });
  const r = await boxPost(link, "/api/v1/models/agent", { model: id });
  if (!r.ok) {
    set({ current: before, error: r.error ?? "the box refused" });
    return false;
  }
  return true;
}

/** A model id as a short name ("openai/gpt-6.1-sol" → "gpt-6.1-sol"). */
export const modelLabel = (id: string | null): string => (id ? (id.split("/").pop() ?? id) : "Model");

export function useAgentModel(): AgentModelState {
  const vault = useStore((s) => s.vaultPath);
  const on = useStore((s) => !!s.boxChat?.on);
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    return () => {
      subs.delete(setS);
    };
  }, []);
  useEffect(() => {
    if (on && vault) void refreshAgentModel();
  }, [on, vault]);
  return s;
}
