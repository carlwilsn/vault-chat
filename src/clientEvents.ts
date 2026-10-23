// What the screen did, for rebuilding a UI bug from the logs alone (summer's
// client-events.jsonl had this; the rebuild lost it). One JSONL line per event
// in `<vault>/.vault-chat/client-events.jsonl` (machine-local, gitignored,
// capped and rotated by lib.rs client_event_append):
//
//   {"at":"2026-10-17T21:03:11.123Z","v":"0.6.45","ev":"file.open","path":"notes/a.md"}
//
// Recorded: the file opened, view/edit mode, the chat opened, fullscreen chat,
// the popout, the sidebars, settings, notes, the chats panel, voice on
// / off / errors, the box's reachability, window focus, and every keyboard
// shortcut (the combination only, e.g. "Ctrl+K" — never a typed character).
// Most come from one subscription to the store (what changed, not who changed
// it), so no component has to remember to log. Written in batches (every 2 s);
// never throws, never blocks the UI.
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { APP_VERSION } from "./debugLog";
import { safeData } from "./logRedact";

const FLUSH_MS = 2000;
const MAX_QUEUE = 500;

let queue: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

/** One client event. `data`: names, ids, flags — made safe (src/logRedact.ts). */
export function cev(ev: string, data: Record<string, unknown> = {}): void {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), v: APP_VERSION, ev, ...(safeData(data) as Record<string, unknown>) });
    queue.push(line);
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    if (!timer) timer = setTimeout(() => void flushClientEvents(), FLUSH_MS);
  } catch {
    /* logging never surfaces */
  }
}

/** Write what is queued (the diag bundle calls it first). */
export async function flushClientEvents(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const vault = useStore.getState().vaultPath;
  if (!vault || !queue.length) return;
  const lines = queue;
  queue = [];
  try {
    await invoke("client_event_append", { vault, line: lines.join("\n") });
  } catch {
    // Not written: back in front of anything newer, for the next flush.
    queue = [...lines, ...queue].slice(-MAX_QUEUE);
  }
}

/** A keyboard event as its shortcut ("Ctrl+Shift+F"), or null for plain typing (never recorded). */
export function shortcutOf(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  const named = e.key.length > 1 && /^(Escape|F\d{1,2}|Tab|Enter)$/.test(e.key);
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !named) return null;
  if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return null;
  // Plain Enter / Tab are typing (send, indent): only with a modifier.
  if ((e.key === "Enter" || e.key === "Tab") && !e.ctrlKey && !e.metaKey && !e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [e.ctrlKey && "Ctrl", e.metaKey && "Meta", e.altKey && "Alt", e.shiftKey && "Shift", k].filter(Boolean).join("+");
}

type Snap = ReturnType<typeof snap>;
function snap(s: ReturnType<typeof useStore.getState>, prev?: { box: string; boxDownAt: number | null }, now = Date.now()) {
  const box = s.boxChat?.on ? (s.boxChat.reachable === null ? "connecting" : s.boxChat.reachable ? "up" : "down") : "off";
  const pane = s.panes?.find((p) => p.id === s.activePaneId);
  return {
    file: s.currentFile,
    mode: s.mode,
    panes: s.panes?.length ?? 0,
    paneFile: (pane as { path?: string } | undefined)?.path ?? null,
    conv: s.activeConversationId,
    fullscreen: s.chatFullscreen,
    popout: s.popoutOpen,
    left: s.leftCollapsed,
    right: s.rightCollapsed,
    chatSidebar: s.chatSidebarOpen,
    settings: s.showSettings,
    notes: s.showNotesPanel,
    chats: s.showChatsPanel,
    voice: s.voiceMode,
    voiceConnecting: s.voiceConnecting,
    voiceMuted: s.voiceMicMuted,
    voiceError: s.voiceError,
    voiceText: s.voiceTextPanelOpen,
    follow: s.followAlong,
    box,
    /** Why the box is out of reach (the feed's error), and since when (a "box" event says both). */
    boxReason: box === "down" ? s.boxChat?.reason || null : null,
    boxDownAt: box !== "down" ? null : prev?.box === "down" ? prev.boxDownAt : now,
    vault: s.vaultPath ? s.vaultPath.replace(/\\/g, "/").split("/").pop() : null,
  };
}

/** What changed between two snapshots, as events. Pure (the tests drive it). */
export function diffSnap(a: Snap, b: Snap, now = Date.now()): { ev: string; data: Record<string, unknown> }[] {
  const out: { ev: string; data: Record<string, unknown> }[] = [];
  const flag = (k: keyof Snap, ev: string) => {
    if (a[k] !== b[k]) out.push({ ev, data: { on: !!b[k] } });
  };
  if (a.vault !== b.vault) out.push({ ev: "vault.open", data: { vault: b.vault } });
  if (a.file !== b.file) out.push({ ev: "file.open", data: { path: b.file } });
  if (a.paneFile !== b.paneFile && b.paneFile !== b.file) out.push({ ev: "pane.file", data: { path: b.paneFile, panes: b.panes } });
  else if (a.panes !== b.panes) out.push({ ev: "pane.count", data: { panes: b.panes } });
  if (a.mode !== b.mode) out.push({ ev: "mode", data: { mode: b.mode } });
  if (a.conv !== b.conv) out.push({ ev: "chat.open", data: { conv: b.conv } });
  flag("fullscreen", "chat.fullscreen");
  flag("popout", "chat.popout");
  flag("left", "sidebar.left.collapsed");
  flag("right", "sidebar.right.collapsed");
  flag("chatSidebar", "chat.sidebar");
  flag("settings", "settings");
  flag("notes", "notes.panel");
  flag("chats", "chats.panel");
  flag("voice", "voice");
  flag("voiceConnecting", "voice.connecting");
  flag("voiceMuted", "voice.muted");
  flag("voiceText", "voice.text");
  flag("follow", "follow.along");
  if (a.voiceError !== b.voiceError && b.voiceError) out.push({ ev: "voice.error", data: { error: b.voiceError } });
  if (a.box !== b.box)
    out.push({ ev: "box", data: { state: b.box, ...(b.box === "down" && b.boxReason ? { err: b.boxReason } : {}), ...(a.box === "down" && a.boxDownAt !== null ? { downMs: now - a.boxDownAt } : {}) } });
  return out;
}

/** Start recording (main.tsx, the main window only). Idempotent. */
export function installClientEvents(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  let prev = snap(useStore.getState());
  cev("app.start", { vault: prev.vault, file: prev.file, conv: prev.conv });
  useStore.subscribe((s) => {
    const next = snap(s, prev);
    // A vault switch: what was queued belongs to the old vault's file.
    if (next.vault !== prev.vault) void flushClientEvents();
    for (const e of diffSnap(prev, next)) cev(e.ev, e.data);
    prev = next;
  });
  window.addEventListener(
    "keydown",
    (e) => {
      const k = shortcutOf(e);
      if (k && !e.repeat) cev("key", { combo: k, where: (e.target as HTMLElement | null)?.closest?.(".cm-editor") ? "editor" : (e.target as HTMLElement | null)?.tagName?.toLowerCase() ?? null });
    },
    { capture: true },
  );
  window.addEventListener("focus", () => cev("window.focus"));
  window.addEventListener("blur", () => cev("window.blur"));
  document.addEventListener("visibilitychange", () => cev("window.visibility", { hidden: document.hidden }));
  window.addEventListener("pagehide", () => void flushClientEvents());
}
