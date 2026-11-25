// The title bar plugin (Track 1; src/appPlugins.ts TITLEBAR_PLUGIN_ID): the bar across the top of the main window
// (./Bar.tsx), mounted through the plugin host (src/mountHost.ts) under the supervisor's records like the chat list,
// the composer, the vault picker and the file tree. src/Titlebar.tsx mounts it; turned off or failing, a minimal
// built-in bar stands in there (the panel toggles, the vault picker, Settings and the window controls, which always
// work), and while the records are unknown the bar itself is drawn in the app's tree.
//
// Its slot: an in-process page adds an item to the bar live with api.host.titlebar.item({...}) (src/titlebarItems.ts), gone
// when that plugin stops.
//
// It declares what it offers (api.offer, src/pluginOffers.ts): the plugins' items, the window (maximized, minimized,
// fullscreen, focused), the open vault and file, the panels and the bar's status as state; the panel toggles, Settings,
// pop out the chat, the tree's refresh, Hidden files, the terminal, a plugin item's click, minimize
// and maximize / restore as actions (no close: closing the window is Carl's); what it did as events.
import { onUpdateChanged, updateActions, updateNow } from "../../updateState";
import { dismissLanded, landedNow, onLandedChanged } from "../../landed";
import { laterReady, onReadyChanged, pressReadyOk, pressShowReady, readyNow } from "../../coreReady";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PluginApi } from "../../mountHost";
import { useStore } from "../../store";
import { NOTES_PLUGIN_ID } from "../../appPlugins";
import { pluginDesiredNow, subscribePluginDesired } from "../../pluginSupervisorApp";
import { runningTaskCount } from "../../backgroundTasks";
import { openTerminal } from "../../terminal";
import { subscribeBoxSync, type BoxSyncState } from "../../vaultSync";
import { subscribeTitlebarItems, titlebarItemNamed, titlebarItems, type TitlebarItem } from "../../titlebarItems";
import { Bar } from "./Bar";
import { closeHidden, emitBarEvent, followWindow, onBarEvent, openHidden, openTailscaleNow, refreshTree, setSyncOpen, unhide, useBar, windowState } from "./model";
import { onTerminalsChanged, terminalsOpened } from "../../terminal";
import { diagNow, onPartFailures, partFailures, retryPart } from "../../partFailures";
import { runDiag } from "../../diag";
import { closeTracked } from "../../trackedOpen";

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
export function titlebarOffers(_api: Pick<PluginApi, "host">, sync: () => BoxSyncState | null = () => null, onSync: (fn: () => void) => () => void = () => () => {}) {
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
  return {
    watch: (fn: () => void) => {
      const offs = [useStore.subscribe(fn), useBar.subscribe(fn), onUpdateChanged(fn), onLandedChanged(fn), onReadyChanged(fn), subscribeTitlebarItems(fn), onSync(fn), onTerminalsChanged(fn), subscribePluginDesired(NOTES_PLUGIN_ID, fn), onPartFailures(fn)];
      return () => offs.forEach((f) => f());
    },
    state: {
      update: {
        description: "The update banner (src/UpdateBanner.tsx): state idle | available (version, notes) | downloading (downloaded, total) | installing | error (message). The app checks for updates by itself.",
        read: () => updateNow(),
      },
      landed: {
        description: "The Landed card (src/landed.ts), shown once after a newer core loaded: shown, revision (the core's main commit), what (the lines it lists). OK (dismissLanded) acknowledges it.",
        read: () => landedNow(),
      },
      ready: {
        description: "The Ready card (src/coreReady.ts): the box has a newer core (interface) than the window runs, fetched and checked, waiting for Carl's OK. shown, version, commit, what (the lines it lists), phase ready | switching | failed (error). Nothing swaps without OK.",
        read: () => readyNow(),
      },
      items: {
        description: "The items in-process pages put in the title bar (api.host.titlebar.item): key, id, by (the plugin), side, label, title, clickable, drawn.",
        read: () => titlebarItems().map(shownItem),
      },
      window: {
        description: "The app window now: maximized, minimized, fullscreen, focused (null where there is no native window).",
        read: () => useBar.getState().window,
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
        description: "The bar's indicators: runningTasks (the agent's background tasks), sync (the attention chip's kind, text and level, its details open, what they say, whether Open Tailscale shows, its last error; or null), hiddenFiles (the Hidden files list open, and its lines), refreshing, terminals (the terminals opened from the bar this session: where, at; a laptop one's id and open while the shell follows it; the box's own sessions: box:links terminals), crashed (app parts that failed and show Reload: part, error), diagnostics (the last bundle written: path, at).",
        read: () => {
          const s = useStore.getState();
          const b = useBar.getState();
          const att = sync()?.attention ?? null;
          return {
            runningTasks: runningTaskCount(s.conversations),
            sync: att ? { kind: att.kind, level: att.level, text: att.text, since: att.since, open: b.syncOpen, detail: b.syncOpen ? att.detail : undefined, canOpenTailscale: att.kind === "tailscale" && !!sync()?.tailscale?.canOpen, ...(b.tailscaleError ? { tailscaleError: b.tailscaleError } : {}) } : null,
            hiddenFiles: { open: b.hiddenOpen, lines: b.hiddenOpen ? b.hiddenLines : undefined },
            refreshing: b.refreshing,
            terminals: terminalsOpened(),
            crashed: partFailures(),
            diagnostics: diagNow(),
          };
        },
      },
    },
    actions: {
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
      installUpdate: {
        description: "Install the update the banner offers and restart the app (its Install & restart). It closes and reopens Carl's window: only when he asks for it now.",
        run: async () => {
          const a = updateActions();
          if (!a || updateNow().state !== "available") throw new Error(`no update is offered now (update: ${JSON.stringify(updateNow())})`);
          await a.install();
          return { update: updateNow() };
        },
      },
      dismissUpdate: {
        description: "Dismiss the update banner (the update stays offered at the next check).",
        run: async () => {
          updateActions()?.dismiss();
          return { update: updateNow() };
        },
      },
      dismissLanded: {
        description: "Press OK on the Landed card: it goes and does not come back for this core.",
        run: async () => {
          dismissLanded();
          return { landed: landedNow() };
        },
      },
      acceptReady: {
        description: "Press OK on the Ready card: swap in the box's newer core now (every window reloads, the screen is kept). Only when Carl asks.",
        run: async () => {
          return { ready: await pressReadyOk() };
        },
      },
      laterReady: {
        description: "Press Later on the Ready card: hidden until the box offers a newer version or the app starts again.",
        run: async () => {
          laterReady();
          return { ready: readyNow() };
        },
      },
      showReady: {
        description: "Bring the Ready card back (Settings' Check for update): undoes Later, asks the box now (fetches and checks, never swaps) and shows the card when the box has a newer core than the window runs. Returns ready and a note (the card is up, up to date, or why the box could not be asked). Never presses OK: that stays Carl's.",
        run: async () => pressShowReady(),
      },
      openSyncDetails: {
        description: "Open (or close) the sync chip's details (its click): what needs attention and what to do.",
        args: OPEN,
        run: (a: Record<string, unknown>) => {
          if (!sync()?.attention) throw new Error("the sync chip is not shown (nothing needs attention)");
          setSyncOpen(want(a, useBar.getState().syncOpen));
          return { open: useBar.getState().syncOpen };
        },
      },
      openTailscale: {
        description: "The sync chip's Open Tailscale (shown when Tailscale on this laptop is not connected): opens the Tailscale app, then syncs again.",
        run: async () => {
          const st = sync();
          if (!(st?.attention?.kind === "tailscale" && st.tailscale?.canOpen)) throw new Error("Open Tailscale is not offered now");
          await openTailscaleNow(st.vault);
          return { opened: true };
        },
      },
      closeTerminal: {
        description: "Close a laptop terminal opened from the bar (status.terminals: its id, while open), as closing its window does. A box terminal: box:links closeTerminal. Only when Carl asks.",
        args: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          await closeTracked(String(a.id ?? ""));
          return { closed: a.id };
        },
      },
      reloadPart: {
        description: "Reload an app part that failed (its fallback's Reload): part from status.crashed.",
        args: { type: "object", properties: { part: { type: "string" } }, required: ["part"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          if (!retryPart(String(a.part ?? ""))) throw new Error(`no failed part "${String(a.part ?? "")}" (failed: ${partFailures().map((f) => f.part).join(", ") || "none"})`);
          return { reloading: a.part };
        },
      },
      diagnostics: {
        description: "Write the diagnostics bundle (Ctrl+Shift+D): the last minutes of the laptop's and the box's logs to a file in the vault (its path; Carl sees the same note). minutes: how far back (default 30).",
        args: { type: "object", properties: { minutes: { type: "integer", minimum: 1, maximum: 240 } }, additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const p = await runDiag(typeof a.minutes === "number" ? a.minutes : undefined);
          if (!p) throw new Error("the bundle was not written (no vault open, or see the app log)");
          return { path: p };
        },
      },
      focusWindow: {
        description: "Bring the app window to the front (as the tray's Show vault-chat): shown and focused.",
        run: async () => {
          const w = getCurrentWindow();
          await w.show();
          await w.setFocus();
          return { window: await windowState() };
        },
      },
      closeWindow: {
        description: "Close the app window (the × button: to the tray when run in background, else the app quits). Only when Carl asks.",
        run: async () => {
          await getCurrentWindow().close();
          return { closed: true };
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
      updateChanged: { description: "The update banner changed: its new state (available, downloading, installing, checked, error, idle)." },
      readyChanged: { description: "The Ready card showed, changed phase or went: shown, version, commit, what, phase." },
      landedChanged: { description: "The Landed card showed or was dismissed: shown, revision, what." },
      itemAdded: { description: "A plugin put an item in the bar: key, by, side." },
      itemRemoved: { description: "An item left the bar (its plugin stopped or removed it): key, by." },
      itemClicked: { description: "A plugin's item was clicked (Carl's click or the agent's): key, by." },
      refreshed: { description: "The file list was re-read: files." },
      unhidden: { description: "Lines left the hide list: lines." },
      windowChanged: { description: "The window was maximized or restored: maximized." },
    },
  };
}

/** The offers, headless: mounted in every layout (src/places.ts "offers"), drawn or not. */
export const offers = { mount: mountOffers };

function mountOffers(_el: HTMLElement, api: PluginApi): () => void {
  let alive = true;
  let sync: BoxSyncState | null = null;
  api.effect(subscribeBoxSync((s) => void (sync = s)));
  api.effect(followWindow());
  const syncFns = new Set<() => void>();
  api.effect(subscribeBoxSync(() => syncFns.forEach((f) => f())));
  const offers = api.offer(titlebarOffers(api, () => sync, (fn) => (syncFns.add(fn), () => void syncFns.delete(fn))));
  api.effect(onBarEvent((name, data) => offers.emit(name, data)));
  api.effect(onUpdateChanged((u) => offers.emit("updateChanged", u)));
  api.effect(onLandedChanged((l) => offers.emit("landedChanged", l)));
  api.effect(onReadyChanged((r) => offers.emit("readyChanged", r)));
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
  return () => {
    alive = false;
  };
}

export function mount(el: HTMLElement, api: PluginApi): () => void {
  let alive = true;
  // A render error the bar does not catch is the plugin's failure (src/Titlebar.tsx then shows its fallback).
  const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
  // Drawn right after the app's commit (before the browser paints: the window never lacks its bar), unmounted outside it.
  queueMicrotask(() => alive && flushSync(() => root.render(<Bar />)));
  return () => {
    alive = false;
    queueMicrotask(() => root.unmount());
  };
}
