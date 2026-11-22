// The title bar (src/plugins/titlebar, app/titlebar): the panel toggles, the vault picker (its own plugin, app/vaults),
// the tree's refresh and Hidden files, Notes, the mic, plugins' items (src/titlebarItems.ts),
// the sync chip, background tasks, the chat toggle and pop-out, the terminal, Settings and the window controls (core,
// src/WindowControls.tsx). Mounted through the plugin host by src/Titlebar.tsx; off or failing, a minimal built-in bar
// stands in there. Ctrl+B / Ctrl+Shift+B are App.tsx's (they work with the bar off too).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Settings, PanelLeft, PanelRight, ExternalLink, Eye, Terminal, RefreshCw, StickyNote, GitMerge, CloudOff, FileWarning, AlertTriangle, WifiOff } from "lucide-react";
import { useStore } from "../../store";
import { NOTES_PLUGIN_ID } from "../../appPlugins";
import { usePluginDesired } from "../../pluginSupervisorApp";
import { runningTaskCount } from "../../backgroundTasks";
import { openChatPopout } from "../../sync";
import { VoiceCockpit, VoiceMicGroup } from "../../voiceParts";
import { VaultPicker } from "../../VaultPicker";
import { WindowControls } from "../../WindowControls";
import { subscribeBoxSync, openTailscale, boxSyncNow, type BoxSyncState } from "../../vaultSync";
import { openTerminal, subscribeTerminalNote, terminalBoxName, terminalTitle } from "../../terminal";
import { subscribeTitlebarItems, titlebarItems, type TitlebarItem, type TitlebarSide } from "../../titlebarItems";
import { closeHidden, openHidden, refreshTree, toggleSelected, unhide, useBar } from "./model";
import { shortcutHint } from "../../shortcuts";
import { macBarInset } from "../../macChrome";

/** With the chat closed: "1 running" while the agent's background tasks work; a click opens the chat. */
function TasksRunning({ hidden, onOpen }: { hidden: boolean; onOpen: () => void }) {
  const n = useStore((s) => runningTaskCount(s.conversations));
  if (hidden || !n) return null;
  return (
    <button onClick={onOpen} data-el="titlebar-tasks" title="Background tasks running — open the chat" className="h-6 mr-2 px-2 flex items-center gap-1.5 rounded-full border border-border/60 text-[11px] text-titlebar-muted hover:text-titlebar-foreground hover:bg-titlebar-hover">
      <span className="relative inline-flex h-1.5 w-1.5">
        <span className="absolute inset-0 rounded-full bg-primary opacity-60 animate-ping" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
      </span>
      <span className="tabular-nums">{n} running</span>
    </button>
  );
}

export function Bar() {
  const vaultPath = useStore((s) => s.vaultPath);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const showSettings = useStore((s) => s.showSettings);
  const leftCollapsed = useStore((s) => s.leftCollapsed);
  const rightCollapsed = useStore((s) => s.rightCollapsed);
  const popoutOpen = useStore((s) => s.popoutOpen);
  const toggleLeft = useStore((s) => s.toggleLeft);
  const toggleRight = useStore((s) => s.toggleRight);
  const setShowNotesPanel = useStore((s) => s.setShowNotesPanel);
  const showNotesPanel = useStore((s) => s.showNotesPanel);
  const openNotes = useStore((s) => s.notes.some((n) => n.status === "open"));
  // The Notes panel is a plugin (src/plugins/notes): turned off, its button goes with it.
  const notesOn = usePluginDesired(NOTES_PLUGIN_ID)?.state === "running";
  const hiddenOpen = useBar((s) => s.hiddenOpen);
  const hiddenLines = useBar((s) => s.hiddenLines);
  const selected = useBar((s) => s.selected);
  const refreshSpin = useBar((s) => s.refreshing);

  useEffect(() => {
    if (!hiddenOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHidden();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hiddenOpen]);

  // The mic button; Ctrl+D (App.tsx, so it works in fullscreen chat too) runs
  // the same toggleVoice.
  return (
    <>
    <div
      data-tauri-drag-region
      data-el="titlebar"
      className="h-9 flex items-center bg-titlebar border-b border-titlebar-border select-none shrink-0 relative"
    >
      <VoiceCockpit />
      <div
        className="flex items-center gap-1 px-2"
        style={macBarInset}
      >
        <button
          onClick={toggleLeft}
          className={`h-7 w-7 flex items-center justify-center rounded hover:bg-titlebar-hover ${leftCollapsed ? "text-titlebar-muted" : "text-titlebar-foreground"}`}
          title={`${leftCollapsed ? "Show" : "Hide"} file panel (${shortcutHint("view.files")})`}
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </button>
        <VaultPicker />
        {vaultPath && (
          <>
            <button
              onClick={() => void refreshTree()}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-titlebar-hover text-titlebar-muted disabled:opacity-50"
              title="Refresh file tree"
              disabled={refreshSpin}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshSpin ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={() => void openHidden().catch((e) => console.error(e))}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-titlebar-hover text-titlebar-muted"
              title="Hidden files"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
            {notesOn && <button
              onClick={() => setShowNotesPanel(!showNotesPanel)}
              className={`h-7 w-7 flex items-center justify-center rounded relative ${
                showNotesPanel
                  ? "bg-titlebar-hover text-titlebar-foreground"
                  : "hover:bg-titlebar-hover text-titlebar-muted"
              }`}
              title={`Notes (${shortcutHint("files.note")} to create)`}
            >
              <StickyNote className="h-3.5 w-3.5" />
              {openNotes && (
                <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
              )}
            </button>}
            <VoiceMicGroup />
          </>
        )}
        <TitlebarItems side="left" />
      </div>

      <div data-tauri-drag-region className="flex-1 h-full" />

      <TitlebarItems side="right" />

      <SyncChip />

      <TasksRunning hidden={!rightCollapsed || popoutOpen} onOpen={toggleRight} />

      <div className="flex items-center">
        <button
          onClick={toggleRight}
          disabled={popoutOpen}
          className={`h-7 w-7 flex items-center justify-center rounded hover:bg-titlebar-hover mr-1 disabled:opacity-40 disabled:cursor-not-allowed ${rightCollapsed ? "text-titlebar-muted" : "text-titlebar-foreground"}`}
          title={
            popoutOpen
              ? "Chat is popped out — close the popout window to dock"
              : `${rightCollapsed ? "Show" : "Hide"} chat panel (${shortcutHint("view.chat")})`
          }
        >
          <PanelRight className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => openChatPopout().catch((err) => console.error("[popout] failed:", err))}
          disabled={popoutOpen}
          className="h-7 w-7 flex items-center justify-center rounded hover:bg-titlebar-hover text-titlebar-muted mr-1 disabled:opacity-40 disabled:cursor-not-allowed"
          title={popoutOpen ? "Chat is popped out" : "Pop out chat"}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
        <TerminalButton vaultPath={vaultPath} />
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="h-7 w-7 flex items-center justify-center rounded hover:bg-titlebar-hover text-titlebar-muted mr-1"
          title="Settings"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        <WindowControls onBar />
      </div>
    </div>
    {hiddenOpen && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) closeHidden();
        }}
      >
        <div
          className="w-[420px] max-h-[70vh] flex flex-col rounded-md border border-border bg-card shadow-xl"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-4 pt-4 pb-2">
            <div className="text-[13px] font-semibold text-foreground">Hidden files</div>
            <div className="text-[11.5px] text-muted-foreground mt-0.5">
              {hiddenLines.length === 0
                ? "Nothing hidden in this vault."
                : "Select entries to unhide. The agent can still see hidden files."}
            </div>
          </div>
          <div className="flex-1 overflow-auto px-2 py-1 min-h-0">
            {hiddenLines.map((line) => (
              <label
                key={line}
                className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/60 cursor-pointer text-[12.5px]"
              >
                <input
                  type="checkbox"
                  checked={selected.has(line)}
                  onChange={() => toggleSelected(line)}
                  className="vc-checkbox shrink-0"
                />
                <span className="truncate font-mono text-[11.5px] text-foreground/90">{line}</span>
              </label>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border/60">
            <div className="text-[11px] text-muted-foreground">
              {selected.size > 0 ? `${selected.size} selected` : ""}
            </div>
            <div className="flex gap-2">
              <button
                className="px-3 py-1 rounded text-[12px] hover:bg-accent/60 text-foreground"
                onClick={closeHidden}
              >
                Close
              </button>
              <button
                className="px-3 py-1 rounded text-[12px] bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={selected.size === 0}
                onClick={() => void unhide().catch((e) => console.error(e))}
              >
                Unhide
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// Box sync chip: shown ONLY when something needs attention (a conflict that
// closed the merge gate, Tailscale on this laptop not connected (at once, with
// Open Tailscale), the box unreachable for over a minute, a file over 50 MB
// whose bytes failed to reach the box's LFS store, a GitHub backup failing for 10 min).
// Amber, red after 10 minutes. Click for the details.
function SyncChip() {
  const [st, setSt] = useState<BoxSyncState | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => subscribeBoxSync(setSt), []);
  const att = st?.attention ?? null;
  useEffect(() => {
    if (!att) setOpen(false);
  }, [att]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const [tsError, setTsError] = useState<string | null>(null);
  if (!att || !st) return null;
  const canOpenTs = att.kind === "tailscale" && !!st.tailscale?.canOpen;
  const openTs = async () => {
    setTsError(null);
    try {
      await openTailscale();
      // Once it's connected the next cycle clears the chip; nudge one sooner.
      window.setTimeout(() => void boxSyncNow(st.vault), 8000);
    } catch (e) {
      setTsError(String(e));
    }
  };
  const kind = att.kind;
  const Icon = kind === "conflict" ? GitMerge : kind === "tailscale" ? WifiOff : kind === "offline" ? CloudOff : kind === "big" ? FileWarning : AlertTriangle;
  const color = att.level === "red" ? "text-destructive" : "text-amber-500";
  const since = new Date(att.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const hint =
    kind === "conflict"
      ? "Ask the agent: resolve the sync conflict"
      : kind === "tailscale"
        ? "Connect Tailscale; sync picks up again by itself."
        : kind === "offline"
        ? "Edits are committed here and go up when the box is back."
        : kind === "big"
          ? "They are safe on this machine; sync sends them as soon as the box takes them."
          : kind === "github"
            ? "The box still has everything; only the GitHub copy is behind."
            : "Ask the agent to look at this sync error.";
  return (
    <div ref={ref} className="relative mr-1 flex items-center">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`h-7 flex items-center gap-1.5 px-2 rounded hover:bg-titlebar-hover text-[11.5px] ${color}`}
        title="Vault sync needs attention"
      >
        <Icon className="h-3.5 w-3.5" />
        <span className="max-w-[260px] truncate">{att.text}</span>
      </button>
      {canOpenTs && (
        <button
          onClick={() => void openTs()}
          className="h-7 px-1.5 rounded hover:bg-titlebar-hover text-[11.5px] text-titlebar-foreground underline underline-offset-2"
          data-testid="open-tailscale"
        >
          Open Tailscale
        </button>
      )}
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-[360px] rounded-md border border-border bg-card text-card-foreground shadow-xl p-3 space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <div className={`text-[12px] font-semibold ${color}`}>{att.text}</div>
            <div className="text-[10.5px] text-muted-foreground shrink-0">since {since}</div>
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
            {att.detail}
          </pre>
          <div className="text-[11.5px] text-foreground/90 border-t border-border/60 pt-2">
            {hint}
            {kind === "conflict" && (
              <span className="text-muted-foreground"> (or type /resolve-sync-conflict)</span>
            )}
            {tsError && <div className="mt-1 text-[11px] text-amber-500/90 break-words">{tsError}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** The terminal where the chat runs: on the box for a box vault (Shift: this laptop), else here. */
function TerminalButton({ vaultPath }: { vaultPath: string | null }) {
  const [box, setBox] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setBox(null);
    void terminalBoxName(vaultPath).then((n) => live && setBox(n));
    return () => {
      live = false;
    };
  }, [vaultPath]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = subscribeTerminalNote((n) => {
      setNote(n);
      if (t) clearTimeout(t);
      t = setTimeout(() => setNote(null), 6000);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, []);
  return (
    <>
      {note && (
        <span className="text-[11px] text-titlebar-muted mr-1 max-w-[280px] truncate" title={note} data-testid="terminal-note">
          {note}
        </span>
      )}
      <button
        onClick={(e) => {
          void openTerminal({ shift: e.shiftKey }).catch((err) => console.error("[terminal] failed:", err));
        }}
        className="h-7 w-7 flex items-center justify-center rounded hover:bg-titlebar-hover text-titlebar-muted mr-1"
        title={terminalTitle(box)}
        aria-label={terminalTitle(box)}
      >
        <Terminal className="h-3.5 w-3.5" />
      </button>
    </>
  );
}

/** Plugins' items on one side of the bar (src/titlebarItems.ts). */
function TitlebarItems({ side }: { side: TitlebarSide }) {
  const all = useSyncExternalStore(subscribeTitlebarItems, titlebarItems, titlebarItems);
  const items = all.filter((i) => i.side === side);
  if (!items.length) return null;
  return (
    <div data-el="titlebar-items" data-side={side} className="flex items-center gap-1 mx-1">
      {items.map((i) => (i.render ? <DrawnItem key={i.key} item={i} /> : <ButtonItem key={i.key} item={i} />))}
    </div>
  );
}

function ButtonItem({ item }: { item: TitlebarItem }) {
  const svg = !!item.icon && /^\s*<svg[\s>]/i.test(item.icon);
  const name = item.title || item.label || item.id;
  return (
    <button
      type="button"
      data-el="titlebar-item"
      data-item={item.key}
      title={name}
      aria-label={name}
      onClick={() => item.onClick?.()}
      className={`h-7 ${item.icon ? "min-w-7 px-1" : "px-2"} flex items-center justify-center gap-1 rounded hover:bg-titlebar-hover text-titlebar-muted hover:text-titlebar-foreground text-[11.5px]`}
    >
      {item.icon ? (
        svg ? <span className="h-3.5 w-3.5 flex items-center justify-center [&>svg]:h-3.5 [&>svg]:w-3.5" dangerouslySetInnerHTML={{ __html: item.icon }} /> : <span className="leading-none">{item.icon}</span>
      ) : (
        <span className="truncate max-w-[160px]">{item.label}</span>
      )}
    </button>
  );
}

function DrawnItem({ item }: { item: TitlebarItem }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !item.render) return;
    const undo = item.render(el);
    return () => {
      if (typeof undo === "function") undo();
      el.replaceChildren();
    };
  }, [item]);
  return <span ref={ref} data-el="titlebar-item" data-item={item.key} title={item.title} className="h-7 inline-flex items-center text-titlebar-foreground" />;
}
