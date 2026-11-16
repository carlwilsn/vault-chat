// The vault picker plugin (Track 1; src/appPlugins.ts VAULTS_PLUGIN_ID): the title bar's vault menu (./Picker.tsx),
// mounted through the plugin host (src/mountHost.ts) under the supervisor's records like the chat list and the
// composer. The title bar mounts it (src/VaultPicker.tsx); turned off or failing, a minimal built-in picker stands in
// there (open a vault, nothing else), and while the records are unknown the picker itself is drawn in the app's tree.
//
// It declares what it offers (api.offer, src/pluginOffers.ts): the vaults (name, path, open, whether it is a project)
// and the menu as state; open a vault, a new vault, rename, delete (recoverable through git), make a vault a project,
// and open / close the menu as actions; what it did as events. The agent reaches them through PluginRead / PluginAct.
// Vaults only: Main and the projects' chats are the chat list's (app/chats).
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PluginApi } from "../../mountHost";
import { useStore } from "../../store";
import { joinPath, masterPath } from "../../master";
import { Picker } from "./Picker";
import { createVault, isOpenRow, loadRows, makeProject, onPickerEvent, removeRow, renameRow, setPickerOpen, switchTo, usePicker, type FolderRow } from "./model";

const shown = (r: FolderRow) => {
  const m = masterPath();
  return { name: r.name, path: m ? joinPath(m, r.repo) : r.repo, open: isOpenRow(r), ...(r.project ? { project: { slug: r.project.slug, name: r.project.name } } : {}) };
};

/** A vault by its name (or its path), from the rows read now. */
async function vaultNamed(want: unknown): Promise<FolderRow> {
  const w = String(want ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!w) throw new Error("a vault's name is needed");
  const rows = await loadRows();
  const low = w.toLowerCase();
  const m = masterPath();
  const r =
    rows.find((x) => x.name === w) ??
    rows.find((x) => x.name.toLowerCase() === low) ??
    rows.find((x) => !!m && joinPath(m, x.repo).toLowerCase() === low);
  if (!r) throw new Error(`no vault "${w}"${rows.length ? ` (vaults: ${rows.map((x) => x.name).join(", ")})` : masterPath() ? "" : " (the vault-chat folder is not set in Settings)"}`);
  return r;
}

const must = <T extends { ok: boolean; error?: string }>(r: T): T => {
  if (!r.ok) throw new Error(r.error ?? "it did not work");
  return r;
};

const NAME = { type: "object", properties: { name: { type: "string", description: "The vault's name (as the vaults state lists it)." } }, required: ["name"], additionalProperties: false };

/** The plugin's offers (exported for tests). */
export function vaultsOffers() {
  return {
    state: {
      vaults: {
        description: "The vault folders the picker lists (vaults only; Main and projects' chats are app/chats'): name, path, open (the workspace now), project (slug, name) when the vault is itself a project. Read afresh.",
        read: async () => (await loadRows()).map(shown),
      },
      current: {
        description: "The vault open now as the workspace (its name and path), or null.",
        read: () => {
          const p = useStore.getState().vaultPath;
          return p ? { name: p.split("/").filter(Boolean).pop() ?? p, path: p } : null;
        },
      },
      menu: {
        description: "Whether the picker's menu is open on screen.",
        read: () => ({ open: usePicker.getState().open }),
      },
    },
    actions: {
      open: {
        description: "Open a vault as the workspace (file tree, viewer, editor), as clicking its row does. Chats do not change with it.",
        args: NAME,
        run: async (a: Record<string, unknown>) => {
          const r = await vaultNamed(a.name);
          setPickerOpen(false);
          must(await switchTo(r));
          return { opened: r.name, path: useStore.getState().vaultPath };
        },
      },
      create: {
        description: "Make a new vault folder and open it (New vault).",
        args: NAME,
        run: async (a: Record<string, unknown>) => {
          const r = await createVault(String(a.name ?? ""));
          if (!r.ok) throw new Error(r.error);
          setPickerOpen(false);
          return { created: r.path };
        },
      },
      rename: {
        description: "Rename a vault (a vault that is a project: the project). Only when Carl asks.",
        args: { type: "object", properties: { name: { type: "string" }, to: { type: "string", description: "The new name." } }, required: ["name", "to"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const r = await vaultNamed(a.name);
          must(await renameRow(r, String(a.to ?? "")));
          return { renamed: r.name, to: String(a.to ?? "").trim() };
        },
      },
      delete: {
        description:
          "Delete a vault, only when Carl asks; git keeps a copy (recoverable). A plain vault: its folder goes. A vault that is a project: folder false removes its conversation and keeps the folder (a plain vault again), folder true deletes everything; say which (Carl's two choices).",
        args: { type: "object", properties: { name: { type: "string" }, folder: { type: "boolean", description: "A project vault: the folder too." } }, required: ["name"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const r = await vaultNamed(a.name);
          if (r.project && typeof a.folder !== "boolean") throw new Error(`${r.name} is a project: say folder false (remove the conversation, keep the folder) or folder true (delete everything)`);
          must(await removeRow(r, r.project ? a.folder === true : true));
          return { deleted: r.name, folder: !r.project || a.folder === true };
        },
      },
      makeProject: {
        description: "Give a plain vault its own conversation (Make this a project): a project thread in the chat pane. Only when Carl asks.",
        args: NAME,
        run: async (a: Record<string, unknown>) => {
          const r = await vaultNamed(a.name);
          must(await makeProject(r));
          return { project: r.name };
        },
      },
      openMenu: {
        description: "Open the picker's menu on screen.",
        run: () => {
          setPickerOpen(true);
          return { open: true };
        },
      },
      closeMenu: {
        description: "Close the picker's menu on screen.",
        run: () => {
          setPickerOpen(false);
          return { open: false };
        },
      },
    },
    events: {
      switched: { description: "A vault was opened as the workspace: name." },
      created: { description: "A new vault was made: name." },
      renamed: { description: "A vault was renamed: name, to." },
      deleted: { description: "A vault was deleted (recoverably): name, folder (whether its folder went)." },
      madeProject: { description: "A vault became a project: name." },
    },
  };
}

export function mount(el: HTMLElement, api: PluginApi): () => void {
  const offers = api.offer(vaultsOffers());
  api.effect(onPickerEvent((name, data) => offers.emit(name, data)));
  // A render error the picker does not catch is the plugin's failure (src/VaultPicker.tsx then shows its fallback).
  const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
  // Drawn right after the app's commit (before the browser paints: the title bar never lacks it), unmounted outside it.
  let alive = true;
  queueMicrotask(() => alive && flushSync(() => root.render(<Picker />)));
  return () => {
    alive = false;
    queueMicrotask(() => root.unmount());
  };
}
