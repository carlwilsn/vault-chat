// The Settings plugin (Track 1; src/appPlugins.ts SETTINGS_PLUGIN_ID): the Settings pane (./Pane.tsx: the Claude sign-in,
// keys, the vault-chat folder, the box, appearance, keyboard shortcuts), mounted through the plugin host under the
// supervisor's records like the title bar. src/SettingsPane.tsx mounts it where Settings shows (in the chat pane's place,
// or the viewer's when the chat is hidden); turned off or failing, a plain pane stands in (back, Keyboard shortcuts, one
// line that says what happened with Turn on / Reload), and while the records are unknown the pane itself is drawn in the
// app's tree.
//
// It declares what it offers (api.offer, src/pluginOffers.ts): whether Settings is open, its sections and the app's
// settings (the same records the Settings tool reads) as state; open (at a section), close, go to a section, change a
// setting and open the shortcut sheet as actions; what happened as events.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PluginApi } from "../../mountHost";
import { useStore } from "../../store";
import { saveSetting, setting } from "../../settings";
import { SETTING_KEYS, isSettingKey, settingTakes, type SettingValue } from "../../settingsRecords";
import { openShortcutSheet } from "../../ShortcutSheet";
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
        description: "Settings is open: open, and where (chat: in the chat pane's place; viewer: in the viewer's, when the chat is hidden).",
        read: () => {
          const s = S();
          return { open: s.showSettings, where: s.showSettings ? (s.rightCollapsed && !s.popoutOpen && !s.chatFullscreen ? "viewer" : "chat") : null };
        },
      },
      sections: {
        description: "The pane's sections, top to bottom: id, title.",
        read: () => SETTINGS_SECTIONS.map((s) => ({ ...s })),
      },
      values: {
        description: "The app's settings as this app knows them now (the box's setting records): theme, model, effort, voice, pushAutomatic, chatSidebar, ...; each with what it takes.",
        read: () => Object.fromEntries(SETTING_KEYS.map((k) => [k, { value: setting(k), takes: settingTakes(k) }])),
      },
    },
    actions: {
      open: {
        description: "Open Settings on screen, at a section when one is named.",
        args: { type: "object", properties: { section: SECTION }, additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const sec = a.section === undefined ? null : sectionOf(a.section);
          if (a.section !== undefined && !sec) throw new Error(`no section "${String(a.section)}" (sections: ${SETTINGS_SECTIONS.map((s) => s.id).join(", ")})`);
          if (!S().showSettings) {
            S().setShowSettings(true);
            emit("opened", sec ? { section: sec.id } : undefined);
          }
          const shown = sec ? await goTo(root, sec.id) : true;
          return { open: true, ...(sec ? { section: sec.id, shown } : {}) };
        },
      },
      close: {
        description: "Close Settings (back to the chat, or the viewer).",
        run: () => {
          if (S().showSettings) {
            S().setShowSettings(false);
            emit("closed");
          }
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
      set: {
        description: "Change one of the app's settings (a setting record on the box, as Carl's pick in the pane; value null: its default). Only when Carl asks.",
        args: { type: "object", properties: { key: { type: "string", enum: SETTING_KEYS as unknown as string[] }, value: { type: ["string", "boolean", "null"] } }, required: ["key", "value"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          if (!isSettingKey(a.key)) throw new Error(`no setting "${String(a.key)}" (settings: ${SETTING_KEYS.join(", ")})`);
          const why = await saveSetting(a.key, a.value as SettingValue);
          if (why) throw new Error(why);
          emit("changed", { key: a.key, value: setting(a.key) });
          return { key: a.key, value: setting(a.key) };
        },
      },
      openShortcuts: {
        description: "Open the keyboard shortcut sheet (Ctrl+/), as the pane's Keyboard shortcuts.",
        run: () => {
          openShortcutSheet();
          return { opened: true };
        },
      },
    },
    events: {
      opened: { description: "Settings opened: section (when the agent named one)." },
      closed: { description: "Settings closed." },
      changed: { description: "The agent changed a setting: key, value." },
    },
  };
}

export function mount(el: HTMLElement, api: PluginApi): () => void {
  let alive = true;
  const offers = api.offer(settingsOffers((name, data) => offers.emit(name, data), () => el));
  // A render error the pane does not catch is the plugin's failure (src/SettingsPane.tsx then shows its fallback).
  const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
  queueMicrotask(() => alive && flushSync(() => root.render(<Pane />)));
  return () => {
    alive = false;
    queueMicrotask(() => root.unmount());
  };
}
