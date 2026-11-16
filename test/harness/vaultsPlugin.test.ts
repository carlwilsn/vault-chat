// Track 1: the title bar's vault picker is a plugin (src/plugins/vaults, app/vaults). It mounts through the plugin host
// under the supervisor's records like the chat list and the composer; it offers the vaults, the open one and its menu as
// state, and open / create / rename / delete / makeProject / openMenu / closeMenu as actions, so the agent reaches it
// through PluginRead / PluginAct. Turned off or failing, a minimal built-in picker stands in (src/VaultPicker.tsx
// VaultPickerFallback: open a vault, nothing else); while the records are unknown the picker itself is drawn.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-vaultsplugin-");
const fake = installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
(globalThis as any).React = React;
const G = globalThis as any;
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body><div id=app>the app</div></body></html>");
G.window ??= G;
G.window.addEventListener ??= () => {};
G.window.removeEventListener ??= () => {};
G.window.dispatchEvent ??= () => true;
G.CustomEvent ??= class extends Event { detail: unknown; constructor(t: string, o?: { detail?: unknown }) { super(t); this.detail = o?.detail; } };
G.document = document;
(document as any).defaultView ??= lw;
(lw as any).getComputedStyle ??= () => ({ getPropertyValue: () => "" });
G.MutationObserver ??= class { observe() {} disconnect() {} };
G.requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);

// The vault-chat folder with three vaults; opening one lists its files.
const M = "C:/Users/carl/vc";
localStorage.setItem("vault_chat_master_path", M);
fake.setHandler("list_dir", ({ path }: any) => (path === `${M}/vaults` ? ["physics", "school2", "vault-chat"].map((name) => ({ name, path: `${path}/${name}`, is_dir: true })) : []));
const opened: string[] = [];
fake.setHandler("list_markdown_files", ({ vault: v }: any) => (opened.push(v), []));

const { useStore } = await import("../../src/store.ts");
const { mountPlugin } = await import("../../src/mountHost.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const { listOffers, readOffers, actOffers, _resetOffers } = await import("../../src/pluginOffers.ts");
const { VAULTS_PLUGIN, VAULTS_PLUGIN_ID, appPluginNamed, APP_PLUGINS } = await import("../../src/appPlugins.ts");
const vaults = await import("../../src/plugins/vaults/index.tsx");
const { usePicker } = await import("../../src/plugins/vaults/model.ts");
const { VaultPickerFallback } = await import("../../src/VaultPicker.tsx");
const THEME = { mode: "dark" as const, vars: {} };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const el = () => document.createElement("div") as unknown as HTMLElement;
const html = (e: HTMLElement) => (e as any).innerHTML as string;

test("the vault picker is a registered app plugin, mounted by the title bar only through the host", () => {
  assert.equal(VAULTS_PLUGIN.id, VAULTS_PLUGIN_ID);
  assert.equal(VAULTS_PLUGIN_ID, "app/vaults");
  assert.ok(APP_PLUGINS.includes(VAULTS_PLUGIN));
  for (const w of ["vaults", "vault picker", "app/vaults", "Vault picker", "vault dropdown"]) assert.equal(appPluginNamed(w)?.id, "app/vaults", w);
  const slot = fs.readFileSync("src/VaultPicker.tsx", "utf8");
  assert.match(slot, /<AppPluginMount plugin=\{VAULTS_PLUGIN\} module=\{vaultsPlugin\} fallback=/);
  assert.doesNotMatch(slot, /picker-rename|picker-delete|MoreHorizontal/, "rename / delete are the plugin's, not the shell's");
  assert.match(fs.readFileSync("src/Titlebar.tsx", "utf8"), /<VaultPicker \/>/);
});

let handle: ReturnType<typeof mountPlugin> | null = null;
let host: HTMLElement;

test("mounted through the host, it draws the picker and declares its offers", async () => {
  _resetOffers();
  useStore.setState({ vaultPath: `${M}/vaults/school2` } as any);
  host = el();
  handle = mountPlugin(host, { name: "Vault picker", module: vaults }, { path: VAULTS_PLUGIN_ID, theme: () => THEME, host: appHostBackend });
  await handle.ready;
  await tick();
  assert.equal(handle.error, null);
  assert.match(html(host), /data-el="vault-picker"/);
  assert.match(html(host), /school2/);
  const d = listOffers().find((p) => p.id === "app/vaults")!;
  assert.ok(d, "listed while it runs");
  assert.deepEqual(d.state.map((s) => s.name), ["vaults", "current", "menu"]);
  assert.deepEqual(d.actions.map((a) => a.name), ["open", "create", "rename", "delete", "makeProject", "openMenu", "closeMenu"]);
  assert.deepEqual(d.events.map((e) => e.name), ["switched", "created", "renamed", "deleted", "madeProject"]);
});

test("read: the vaults with the open one marked, the current vault, the menu", async () => {
  const r = await readOffers("vaults");
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.state!.vaults, [
    { name: "physics", path: `${M}/vaults/physics`, open: false },
    { name: "school2", path: `${M}/vaults/school2`, open: true },
    { name: "vault-chat", path: `${M}/vaults/vault-chat`, open: false },
  ]);
  assert.deepEqual(r.state!.current, { name: "school2", path: `${M}/vaults/school2` });
  assert.deepEqual(r.state!.menu, { open: false });
});

test("act: open the menu on screen, open a vault by name, and refusals say why", async () => {
  let r = await actOffers("vaults", "openMenu", {});
  assert.equal(r.ok, true, r.error);
  await tick();
  assert.match(html(host), /data-el="vault-picker-menu"/);
  assert.match(html(host), /data-el="picker-row-menu"/, "each row's ⋯ (Rename / Delete) is there");
  r = await actOffers("vaults", "open", { name: "Physics" });
  assert.equal(r.ok, true, r.error);
  assert.equal(useStore.getState().vaultPath, `${M}/vaults/physics`);
  assert.deepEqual(opened, [`${M}/vaults/physics`]);
  assert.equal(usePicker.getState().open, false, "the menu closes");
  r = await actOffers("vaults", "open", { name: "nope" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /no vault "nope" \(vaults: physics, school2, vault-chat\)/);
  // No box here: a rename says so, and nothing changed.
  r = await actOffers("vaults", "rename", { name: "physics", to: "phys" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /box is not connected/);
});

test("turned off or failed: the plain picker opens a vault and says what happened; no rename or delete", () => {
  usePicker.setState({ open: true });
  const draw = (info: any) => {
    const e = el();
    const root = createRoot(e);
    flushSync(() => root.render(createElement(VaultPickerFallback, { info })));
    const out = html(e);
    flushSync(() => root.unmount());
    return out;
  };
  const off = draw({ off: { state: "stopped", by: "agent", at: 1 }, error: null, pending: false, retry: () => {} });
  assert.match(off, /data-el="plugin-off"/);
  assert.match(off, /data-el="vault-picker-item"/);
  assert.match(off, /school2/);
  assert.doesNotMatch(off, /picker-rename|picker-delete/);
  const failed = draw({ off: null, error: "boom", pending: false, retry: () => {} });
  assert.match(failed, /The vault picker stopped/);
  assert.match(failed, /data-el="plugin-reload"/);
  usePicker.setState({ open: false });
});

test("unmounted: its offers are gone", async () => {
  handle?.unmount();
  await tick();
  assert.equal(listOffers().find((p) => p.id === "app/vaults"), undefined);
});
