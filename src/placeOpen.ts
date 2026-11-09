// Which places (Main, a project) Carl has opened or shut in the chats list.
//
// His own click is kept on this machine, per vault, so a place he collapsed
// stays collapsed when the panel closes and opens again, across the chat pane's
// list and the fullscreen sidebar (one store, both read it), and across a
// restart. A place he never touched follows where he is: open when he is in it.
import { useSyncExternalStore } from "react";
import { useStore } from "./store";

const KEY = "vault_chat_place_open";
type Saved = Record<string, Record<string, boolean>>;

let saved: Saved | null = null;
const subs = new Set<() => void>();

function read(): Saved {
  if (saved) return saved;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    saved = v && typeof v === "object" ? (v as Saved) : {};
  } catch {
    saved = {};
  }
  return saved;
}

/** Carl's choice for this place, or null when he has not made one. */
export function placeOpen(vault: string | null, place: string): boolean | null {
  const v = read()[vault ?? ""]?.[place];
  return typeof v === "boolean" ? v : null;
}

export function setPlaceOpen(vault: string | null, place: string, open: boolean): void {
  const all = read();
  const k = vault ?? "";
  saved = { ...all, [k]: { ...(all[k] ?? {}), [place]: open } };
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    /* localStorage unavailable: it holds for this session */
  }
  for (const f of subs) f();
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

/** Re-render when any place is opened or shut (a list that reads placeOpen for several). */
export function usePlaceOpenVersion(): unknown {
  return useSyncExternalStore(subscribe, read, read);
}

/** [Carl's choice or null, set it] for one place in the current vault. */
export function usePlaceOpen(place: string): [boolean | null, (open: boolean) => void] {
  const vault = useStore((s) => s.vaultPath);
  const snap = () => placeOpen(vault, place);
  const v = useSyncExternalStore(subscribe, snap, snap);
  return [v, (open) => setPlaceOpen(vault, place, open)];
}
