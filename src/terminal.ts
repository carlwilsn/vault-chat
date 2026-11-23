// The terminal button / Ctrl+J: a terminal where the chat runs.
// - A vault connected to a box (sync.json) → a shell ON THE BOX, in that
//   vault's working copy, over SSH on the tailnet (`open_box_terminal`). The
//   box's health names its user and the vault's path; the host is the box URL's.
// - A laptop-only vault → the local terminal at the vault (`open_terminal`).
// - Shift (Shift+Ctrl+J, Shift-click) → the other one, when there is a box.
// - The box unreachable, or an older server that doesn't report user/path →
//   the laptop terminal, with a quiet note.
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { boxName, readBoxConfig } from "./vaultSync";
import { boxGet, boxLinkFor } from "./boxChat";
import { shortcutHint } from "./shortcuts";

export type BoxTarget = { host: string; user: string; path: string };

export type TerminalChoice =
  | { where: "box"; target: BoxTarget }
  | { where: "laptop"; cwd: string | null; note?: string };

/** Which terminal opens. Pure: `target` is what the box reported (null + `error` when it couldn't). */
export function chooseTerminal(o: {
  vault: string | null;
  hasBox: boolean;
  shift: boolean;
  target: BoxTarget | null;
  error?: string | null;
}): TerminalChoice {
  const wantBox = o.hasBox && !o.shift;
  if (!wantBox) return { where: "laptop", cwd: o.vault };
  if (o.target) return { where: "box", target: o.target };
  return {
    where: "laptop",
    cwd: o.vault,
    note: `Box terminal unavailable${o.error ? ` (${o.error})` : ""} — opened one on this laptop`,
  };
}

/** The ssh target from the box's health: its host (from the box URL), user and this vault's working copy. */
export function boxTargetFromHealth(boxUrl: string, vaultName: string | null, health: any): BoxTarget {
  let host = "";
  try {
    host = new URL(boxUrl).hostname;
  } catch {
    /* not a URL */
  }
  const user = typeof health?.user === "string" ? health.user : "";
  let path = typeof health?.vaultPath === "string" ? health.vaultPath : "";
  if (!path && Array.isArray(health?.vaults)) {
    const v = health.vaults.find((x: any) => x?.name === vaultName) ?? (vaultName ? null : health.vaults[0]);
    if (typeof v?.path === "string") path = v.path;
  }
  if (!host) throw new Error("no box host");
  if (!user || !path) throw new Error("the box doesn't report its user and vault path (older server)");
  return { host, user, path };
}

/** The button's tooltip. */
export function terminalTitle(box: string | null): string {
  return box ? `Terminal on ${box} (${shortcutHint("view.terminal")}) · Shift: this laptop` : `Terminal (${shortcutHint("view.terminal")})`;
}

/** The box's short name for this vault's tooltip, or null (laptop-only). */
export async function terminalBoxName(vault: string | null): Promise<string | null> {
  if (!vault) return null;
  const cfg = await readBoxConfig(vault).catch(() => null);
  return cfg?.box ? boxName(cfg) : null;
}

type NoteListener = (note: string | null) => void;
const noteListeners = new Set<NoteListener>();
/** A quiet note when the box terminal fell back to the laptop (the Titlebar shows it briefly). */
export function subscribeTerminalNote(fn: NoteListener): () => void {
  noteListeners.add(fn);
  return () => noteListeners.delete(fn);
}
function note(text: string): void {
  console.warn(`[terminal] ${text}`);
  for (const fn of noteListeners) fn(text);
}

async function openLaptop(cwd: string | null): Promise<string | null> {
  await invoke("open_terminal", { cwd: cwd ?? undefined });
  return null;
}

/** Open the terminal for the current vault (Ctrl+J / the titlebar button). Resolves to what opened. */
/** The terminals opened from the app this session (where, when): what the app can know of them (whether one is still
 *  open is the OS's: it is a separate program). The title bar's status reads it. */
const opened: { where: "box" | "laptop"; at: string; id?: string }[] = [];
const openedFns = new Set<() => void>();
/** The terminals opened this session: a laptop one with whether it is still open (when the shell follows it), a box
 *  one by when (box:links terminals has the box's sessions, open or closed). */
export const terminalsOpened = () => opened.slice(-5).map((t) => ({ where: t.where, at: t.at }));
export function onTerminalsChanged(fn: () => void): () => void {
  openedFns.add(fn);
  return () => void openedFns.delete(fn);
}
function noteOpened(where: "box" | "laptop", id?: string | null): void {
  opened.push({ where, at: new Date().toISOString(), ...(id ? { id } : {}) });
  for (const f of [...openedFns]) f();
}

export async function openTerminal(opts: { shift?: boolean } = {}): Promise<TerminalChoice> {
  const vault = useStore.getState().vaultPath ?? null;
  const shift = !!opts.shift;
  const cfg = vault ? await readBoxConfig(vault).catch(() => null) : null;
  const hasBox = !!cfg?.box;
  let target: BoxTarget | null = null;
  let error: string | null = null;
  if (hasBox && !shift) {
    try {
      const link = await boxLinkFor(vault);
      if (!link) throw new Error("no box link");
      const health = await boxGet(link, "/api/v1/health", 5_000);
      target = boxTargetFromHealth(link.url, link.vault ?? null, health);
    } catch (e) {
      error = String((e as Error)?.message ?? e).slice(0, 160);
    }
  }
  let choice = chooseTerminal({ vault, hasBox, shift, target, error });
  if (choice.where === "box") {
    try {
      await invoke("open_box_terminal", { ...choice.target });
      noteOpened("box");
      return choice;
    } catch (e) {
      choice = chooseTerminal({ vault, hasBox, shift, target: null, error: String((e as Error)?.message ?? e).slice(0, 160) });
    }
  }
  if (choice.where === "laptop" && choice.note) note(choice.note);
  noteOpened("laptop", await openLaptop(choice.where === "laptop" ? choice.cwd : vault));
  return choice;
}
