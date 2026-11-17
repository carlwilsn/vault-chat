// The title bar plugin (Track 1; src/appPlugins.ts TITLEBAR_PLUGIN_ID): the bar across the top of the main window
// (./Bar.tsx), mounted through the plugin host (src/mountHost.ts) under the supervisor's records like the chat list,
// the composer, the vault picker and the file tree. src/Titlebar.tsx mounts it; turned off or failing, a minimal
// built-in bar stands in there (the panel toggles, the vault picker, Settings and the window controls, which always
// work), and while the records are unknown the bar itself is drawn in the app's tree.
//
// Its slot: a vault plugin adds an item to the bar live with api.host.titlebar.item({...}) (src/titlebarItems.ts), gone
// when that plugin stops.
//
// It declares what it offers (api.offer, src/pluginOffers.ts): the plugins' items, the window (maximized, minimized,
// fullscreen, focused), the open vault and file, the panels and the bar's status as state; the panel toggles, Settings,
// pop out the chat, the tree's refresh, Hidden files, the terminal, a plugin item's click, minimize
// and maximize / restore as actions (no close: closing the window is Carl's); what it did as events.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PluginApi } from "../../mountHost";
import { useStore } from "../../store";
import { NOTES_PLUGIN_ID } from "../../appPlugins";
import { pluginDesiredNow } from "../../pluginSupervisorApp";
import { runningTaskCount } from "../../backgroundTasks";
import { openChatPopout } from "../../sync";
import { openTerminal } from "../../terminal";
import { subscribeBoxSync, type BoxSyncState } from "../../vaultSync";
import { subscribeTitlebarItems, titlebarItemNamed, titlebarItems, type TitlebarItem } from "../../titlebarItems";
import { Bar } from "./Bar";
import { closeHidden, emitBarEvent, onBarEvent, openHidden, refreshTree, unhide, useBar, windowState } from "./model";

const shownItem = (i: TitlebarItem) => ({
  key: i.key,
  id: i.id,
  by: i.by,
  side: i.side,
  ...(i.label ? { label: i.label } : {}),
  ...(i.title ? { title: i.title } : {}),
  clickable: !!i.onClick,
  drawn: !!i.render,
});

const name = (p: string | null) => (p ? p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p : null);
const OPEN = { type: "object", properties: { open: { type: "boolean", description: "true: open it, false: close it; left out: toggle." } }, additionalProperties: false };
const want = (a: Record<string, unknown>, now: boolean) => (typeof a.open === "boolean" ? a.open : !now);

/** The plugin's offers (exported for tests). `sync` reads the vault sync's last state. */
export function titlebarOffers(api: Pick<PluginApi, "host">, sync: () => BoxSyncState | null = () => null) {
  const panels = () => {
    const s = useStore.getState();
    return {
      left: !s.leftCollapsed,
      chat: !s.rightCollapsed && !s.popoutOpen,
      chatPoppedOut: s.popoutOpen,
      chatFullscreen: s.chatFullscreen,
      notes: s.showNotesPanel,
      notesAvailable: pluginDesiredNow(NOTES_PLUGIN_ID)?.state === "running",
      settings: s.showSettings,
    };
  };
  const layoutPanel = async (open: boolean, which: "Left" | "Right") => {
    const r = await api.host.layout.apply({ op: `${open ? "open" : "close"}${which}Panel` } as never);
    if (!r.ok) throw new Error(r.results.map((x) => x.error).filter(Boolean).join("; ") || "it did not work");
    return r;
  };
  return {
    state: {
      items: {
        description: "The items vault plugins put in the title bar (api.host.titlebar.item): key, id, by (the plugin), side, label, title, clickable, drawn.",
        read: () => titlebarItems().map(shownItem),
      },
      window: {
        description: "The app window now: maximized, minimized, fullscreen, focused (null where there is no native window).",
        read: () => windowState(),
      },
      vault: {
        description: "The vault open as the workspace (name, path) and the file open in the viewer (path), or nulls.",
        read: () => {
          const s = useStore.getState();
          return { name: name(s.vaultPath), path: s.vaultPath, file: s.currentFile };
        },
      },
      panels: {
        description: "What is open: left (file panel), chat (docked chat panel), chatPoppedOut, chatFullscreen, notes (Notes panel; notesAvailable: the Notes plugin runs), settings.",
        read: panels,
      },
      status: {
        description: "The bar's indicators: runningTasks (the agent's background tasks), sync (the attention chip's text and level, or null), hiddenFiles (the Hidden files list open, and its lines), refreshing.",
        read: () => {
          const s = useStore.getState();
          const b = useBar.getState();
          const att = sync()?.attention ?? null;
          return {
            runningTasks: runningTaskCount(s.conversations),
            sync: att ? { kind: att.kind, level: att.level, text: att.text } : null,
            hiddenFiles: { open: b.hiddenOpen, lines: b.hiddenOpen ? b.hiddenLines : undefined },
            refreshing: b.refreshing,
          };
        },
      },
    },
    actions: {
      toggleLeftPanel: {
        description: "Show or hide the file panel (the bar's left button, Ctrl+B).",
        args: OPEN,
        run: async (a: Record<string, unknown>) => {
          await layoutPanel(want(a, panels().left), "Left");
          return { left: panels().left };
        },
      },
      toggleChatPanel: {
        description: "Show or hide the docked chat panel (the bar's right button, Ctrl+Shift+B). Not while the chat is popped out.",
        args: OPEN,
        run: async (a: Record<string, unknown>) => {
          if (useStore.getState().popoutOpen) throw new Error("the chat is popped out: close the pop-out window to dock it");
          await layoutPanel(want(a, panels().chat), "Right");
          return { chat: panels().chat };
        },
      },
      toggleNotes: {
        description: "Open or close the Notes panel (the bar's Notes button). Only while the Notes plugin runs.",
        args: OPEN,
        run: (a: Record<string, unknown>) => {
          if (!panels().notesAvailable) throw new Error("the Notes plugin is turned off");
          const s = useStore.getState();
          s.setShowNotesPanel(want(a, s.showNotesPanel));
          return { notes: useStore.getState().showNotesPanel };
        },
      },
      toggleSettings: {
        description: "Open or close Settings (the bar's gear).",
        args: OPEN,
        run: (a: Record<string, unknown>) => {
          const s = useStore.getState();
          s.setShowSettings(want(a, s.showSettings));
          return { settings: useStore.getState().showSettings };
        },
      },
      popOutChat: {
        description: "Pop the chat out into its own window (the bar's pop-out button).",
        run: async () => {
          if (useStore.getState().popoutOpen) return { poppedOut: true, note: "already popped out" };
          await openChatPopout();
          return { poppedOut: true };
        },
      },
      refreshTree: {
        description: "Re-list the open vault's files (the bar's refresh button).",
        run: async () => {
          const r = await refreshTree();
          if (!r.ok) throw new Error(r.error);
          return { files: r.files };
        },
      },
      openHiddenFiles: {
        description: "Open the Hidden files list on screen (the vault's .vaultchatignore lines); its lines.",
        run: async () => ({ lines: await openHidden() }),
      },
      closeHiddenFiles: {
        description: "Close the Hidden files list.",
        run: () => {
          closeHidden();
          return { open: false };
        },
      },
      unhide: {
        description: "Unhide these lines of the hide list (as ticking them in Hidden files and Unhide). Only when Carl asks.",
        args: { type: "object", properties: { lines: { type: "array", items: { type: "string" }, description: "Lines as Hidden files lists them." } }, required: ["lines"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const lines = Array.isArray(a.lines) ? a.lines.map(String) : [];
          if (!lines.length) throw new Error("say which lines");
          return { unhidden: await unhide(lines) };
        },
      },
      openTerminal: {
        description: "Open the terminal where the chat runs (the bar's terminal button): the box's for a box vault; laptop true: this laptop's.",
        args: { type: "object", properties: { laptop: { type: "boolean" } }, additionalProperties: false },
        run: async (a: Record<string, unknown>) => ({ opened: await openTerminal({ shift: a.laptop === true }) }),
      },
      clickItem: {
        description: "Click a plugin's title bar item (its key, or its id or label when that names one item).",
        args: { type: "object", properties: { item: { type: "string" } }, required: ["item"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          const it = titlebarItemNamed(String(a.item ?? ""));
          if (!it) {
            const all = titlebarItems();
            throw new Error(`no title bar item "${String(a.item ?? "")}"${all.length ? ` (items: ${all.map((i) => i.key).join(", ")})` : " (no plugin has put one there)"}`);
          }
          if (!it.onClick) throw new Error(`${it.key} has no click (it draws itself)`);
          it.onClick();
          emitBarEvent("itemClicked", { key: it.key, by: it.by });
          return { clicked: it.key };
        },
      },
      minimize: {
        description: "Minimize the app window (the – button). Only when Carl asks.",
        run: async () => {
          await getCurrentWindow().minimize();
          return { window: await windowState() };
        },
      },
      toggleMaximize: {
        description: "Maximize the app window, or restore it when maximized (the □ button).",
        run: async () => {
          await getCurrentWindow().toggleMaximize();
          return { window: await windowState() };
        },
      },
    },
    events: {
      itemAdded: { description: "A plugin put an item in the bar: key, by, side." },
      itemRemoved: { description: "An item left the bar (its plugin stopped or removed it): key, by." },
      itemClicked: { description: "The agent clicked a plugin's item: key, by." },
      refreshed: { description: "The file list was re-read: files." },
      unhidden: { description: "Lines left the hide list: lines." },
      windowChanged: { description: "The window was maximized or restored: maximized." },
    },
  };
}

export function mount(el: HTMLElement, api: PluginApi): () => void {
  let alive = true;
  let sync: BoxSyncState | null = null;
  api.effect(subscribeBoxSync((s) => void (sync = s)));
  const offers = api.offer(titlebarOffers(api, () => sync));
  api.effect(onBarEvent((name, data) => offers.emit(name, data)));
  // Items coming and going, as events.
  let known = new Map(titlebarItems().map((i) => [i.key, i] as const));
  api.effect(
    subscribeTitlebarItems(() => {
      const now = new Map(titlebarItems().map((i) => [i.key, i] as const));
      for (const [k, i] of now) if (known.get(k) !== i) offers.emit("itemAdded", { key: k, by: i.by, side: i.side });
      for (const [k, i] of known) if (!now.has(k)) offers.emit("itemRemoved", { key: k, by: i.by });
      known = now;
    }),
  );
  // The window maximized or restored.
  void (async () => {
    try {
      const w = getCurrentWindow();
      let was = await w.isMaximized();
      const off = await w.onResized(async () => {
        const m = await w.isMaximized().catch(() => was);
        if (m !== was) offers.emit("windowChanged", { maximized: m });
        was = m;
      });
      if (alive) api.effect(off);
      else off();
    } catch {
      /* no native window here */
    }
  })();
  // A render error the bar does not catch is the plugin's failure (src/Titlebar.tsx then shows its fallback).
  const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
  // Drawn right after the app's commit (before the browser paints: the window never lacks its bar), unmounted outside it.
  queueMicrotask(() => alive && flushSync(() => root.render(<Bar />)));
  return () => {
    alive = false;
    queueMicrotask(() => root.unmount());
  };
}
