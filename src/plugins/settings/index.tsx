// The Settings plugin (Track 1; src/appPlugins.ts SETTINGS_PLUGIN_ID): the Settings pane (./Pane.tsx: the Claude sign-in,
// keys, the vault-chat folder, the box, appearance, keyboard shortcuts), mounted through the plugin host under the
// supervisor's records like the title bar. src/SettingsPane.tsx mounts it where Settings shows (in the chat pane's place,
// or the viewer's when the chat is hidden); turned off or failing, a plain pane stands in (back, Keyboard shortcuts, one
// line that says what happened with Turn on / Reload), and while the records are unknown the pane itself is drawn in the
// app's tree.
//
// It declares what it offers (api.offer, src/pluginOffers.ts): whether Settings is open, its sections and the app's
// settings (the same records box:settings reads) as state; open (at a section), close, go to a section, change a
// setting and open the shortcut sheet as actions; what happened as events.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PluginApi } from "../../mountHost";
import { useStore } from "../../store";
import { closeShortcutSheet, openShortcutSheet, useShortcutSheet } from "../../ShortcutSheet";
import { boxStatusNow, checkBox, disconnectFromBox, findBoxes, folderNow, onSettingsBoxChanged, refreshFolder, setFolder, syncBoxNow, syncWithBox } from "../../settingsBox";
import { Pane, SETTINGS_SECTIONS } from "./Pane";

const sectionOf = (w: unknown) => {
  const s = String(w ?? "").trim().toLowerCase();
  return SETTINGS_SECTIONS.find((x) => x.id === s || x.title.toLowerCase() === s) ?? null;
};
const SECTION = { type: "string", description: `A section's id or title: ${SETTINGS_SECTIONS.map((s) => s.id).join(", ")}.` };

/** Scroll the pane in `root` to a section; false when it is not drawn there yet (the pane renders on the next commit). */
function scrollToSection(root: () => ParentNode | null, id: string): boolean {
  const el = root()?.querySelector(`[data-settings="${id}"]`) as HTMLElement | null;
  if (!el) return false;
  el.scrollIntoView?.({ block: "start" });
  return true;
}

/** The section at the top of the pane as it is scrolled (null when the pane is not drawn). */
function sectionInView(root: () => ParentNode | null): string | null {
  const els = [...(root()?.querySelectorAll<HTMLElement>("[data-settings]") ?? [])];
  if (!els.length) return null;
  const top = els[0]!.parentElement?.getBoundingClientRect().top ?? 0;
  let cur = els[0]!.dataset.settings ?? null;
  for (const el of els) if (el.getBoundingClientRect().top - top <= 24) cur = el.dataset.settings ?? cur;
  return cur;
}

/** Wait a few frames for the section to be drawn, then scroll to it. */
function goTo(root: () => ParentNode | null, id: string): Promise<boolean> {
  return new Promise((done) => {
    let tries = 0;
    const go = () => {
      if (scrollToSection(root, id)) return done(true);
      if (++tries >= 20) return done(false);
      (typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f: () => void) => setTimeout(f, 16))(go);
    };
    go();
  });
}

/** The plugin's offers (exported for tests). `root`: where the pane is drawn (the document by default). */
export function settingsOffers(emit: (event: string, data?: unknown) => void = () => {}, root: () => ParentNode | null = () => (typeof document === "undefined" ? null : document)) {
  const S = () => useStore.getState();
  return {
    state: {
      open: {
        description: "Settings is open: open, where (chat: in the chat pane's place; viewer: in the viewer's, when the chat is hidden) and section (the one at the top of the pane as it is scrolled).",
        read: () => {
          const s = S();
          return { open: s.showSettings, where: s.showSettings ? (s.rightCollapsed && !s.popoutOpen && !s.chatFullscreen ? "viewer" : "chat") : null, section: s.showSettings ? sectionInView(root) : null };
        },
      },
      sections: {
        description: "The pane's sections, top to bottom: id, title.",
        read: () => SETTINGS_SECTIONS.map((s) => ({ ...s })),
      },
      shortcuts: {
        description: "The keyboard shortcut sheet (Ctrl+/): open.",
        read: () => ({ open: useShortcutSheet.getState().open }),
      },
      box: {
        description: "Settings → Box for the open vault: connected (name, box, vault) or null; syncing, lastSyncOk, error, waitingForBox (commits), mergeGate (open, or closedSince + files), notOnBoxYet (files over 50 MB not sent), github (the backup), keysDidNotReach.",
        read: () => boxStatusNow(),
      },
      folder: {
        description: "Settings → vault-chat folder: path (the laptop's), boxFolder, repos (kind vault | project, name, onBox).",
        read: () => folderNow(),
      },
    },
    // The settings' values and their change are box:settings (one route, the pane's controls call it).
    watch: (fn: () => void) => {
      void refreshFolder().catch(() => {});
      // Carl scrolling the pane moves its section (a scroll inside it, heard on the document).
      const onScroll = (e: Event) => {
        if ((e.target as Element | null)?.querySelector?.("[data-settings]")) fn();
      };
      const doc = typeof document !== "undefined" && typeof document.addEventListener === "function" ? document : null;
      doc?.addEventListener("scroll", onScroll, true);
      const offs = [useStore.subscribe(fn), useShortcutSheet.subscribe(fn), onSettingsBoxChanged(fn), () => doc?.removeEventListener("scroll", onScroll, true)];
      return () => offs.forEach((f) => f());
    },
    actions: {
      open: {
        description: "Open Settings on screen, at a section when one is named.",
        args: { type: "object", properties: { section: SECTION }, additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const sec = a.section === undefined ? null : sectionOf(a.section);
          if (a.section !== undefined && !sec) throw new Error(`no section "${String(a.section)}" (sections: ${SETTINGS_SECTIONS.map((s) => s.id).join(", ")})`);
          if (!S().showSettings) S().setShowSettings(true);
          emit("opened", sec ? { section: sec.id } : undefined);
          const shown = sec ? await goTo(root, sec.id) : true;
          return { open: true, ...(sec ? { section: sec.id, shown } : {}) };
        },
      },
      close: {
        description: "Close Settings (back to the chat, or the viewer).",
        run: () => {
          if (S().showSettings) S().setShowSettings(false);
          return { open: false };
        },
      },
      scrollTo: {
        description: "Scroll the open Settings pane to a section.",
        args: { type: "object", properties: { section: SECTION }, required: ["section"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const sec = sectionOf(a.section);
          if (!sec) throw new Error(`no section "${String(a.section)}" (sections: ${SETTINGS_SECTIONS.map((s) => s.id).join(", ")})`);
          if (!S().showSettings) throw new Error("Settings is not open (open it first, or open with a section)");
          const shown = await goTo(root, sec.id);
          if (!shown) throw new Error(`the ${sec.title} section is not on screen`);
          return { section: sec.id };
        },
      },
      findBoxes: {
        description: "Connect a box, step 1 (its Connect a box): the boxes on Carl's tailnet (name, url, online, version), or why none answered.",
        run: async () => findBoxes(),
      },
      connectBox: {
        description: "Connect the open vault to a box (its pick or address, then Sync this vault with it): checks it answers as a vault-chat server, makes the vault there, gives it this laptop's keys; the chat then runs on it. Only when Carl asks.",
        args: { type: "object", properties: { url: { type: "string", description: "A box's url from findBoxes, or its address." } }, required: ["url"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const vault = S().vaultPath;
          if (!vault) throw new Error("no vault is open");
          const c = await checkBox(String(a.url ?? ""));
          if (!c.ok) throw new Error(c.error);
          await syncWithBox(vault, String(a.url ?? ""), c.name);
          return boxStatusNow();
        },
      },
      syncBoxNow: {
        description: "Settings → Box's sync now: a sync cycle with the box at once.",
        run: async () => {
          await syncBoxNow();
          return boxStatusNow();
        },
      },
      disconnectBox: {
        description: "Settings → Box's disconnect (after its confirm): the chat goes back to running on this laptop; the box keeps its copy. Only when Carl asks.",
        run: async () => {
          await disconnectFromBox();
          return boxStatusNow();
        },
      },
      setFolder: {
        description: "Set the laptop's vault-chat folder (its Set / Change): what the box has that the laptop doesn't is brought over. Only when Carl asks.",
        args: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const msg = await setFolder(String(a.path ?? ""));
          return { ...folderNow(), ...(msg ? { note: msg } : {}) };
        },
      },
      openShortcuts: {
        description: "Open the keyboard shortcut sheet (Ctrl+/), as the pane's Keyboard shortcuts.",
        run: () => {
          openShortcutSheet();
          return { opened: true };
        },
      },
      closeShortcuts: {
        description: "Close the keyboard shortcut sheet (Esc).",
        run: () => {
          closeShortcutSheet();
          return { open: false };
        },
      },
    },
    events: {
      opened: { description: "The agent opened Settings (or went to a section): section. Carl's own opening and closing: stateChanged." },
    },
  };
}

/** The offers, headless: mounted in every layout (src/places.ts "offers"), whether Settings is open or not. */
export const offers = {
  mount: (el: HTMLElement, api: PluginApi) => {
    // The pane is wherever Settings draws (the document); a detached host (a test's) holds it itself.
    const o = api.offer(settingsOffers((name, data) => o.emit(name, data), () => (el.isConnected ? el.ownerDocument : el)));
  },
};

export function mount(el: HTMLElement, api: PluginApi): () => void {
  let alive = true;
  // A render error the pane does not catch is the plugin's failure (src/SettingsPane.tsx then shows its fallback).
  const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
  queueMicrotask(() => alive && flushSync(() => root.render(<Pane />)));
  return () => {
    alive = false;
    queueMicrotask(() => root.unmount());
  };
}
