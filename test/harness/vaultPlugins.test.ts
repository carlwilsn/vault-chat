// Vault plugins: a code file in .vault-chat/plugins is a plugin (src/vaultPlugins.ts, src/VaultPluginHost.tsx): found by
// scanning the folder, mounted through the host in the light DOM with the same api, reloaded on change, reverted on stop.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseHTML } from "linkedom";
import { mountPlugin, type LoadModule } from "../../src/mountHost.ts";
import { isVaultPluginFile, parseVaultPluginMeta, vaultPluginFile, vaultPluginId, vaultPluginNamed } from "../../src/vaultPlugins.ts";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const fakeVault = makeTempVault("vc-vp-fake-");
installFakeTauri(fakeVault);
const { scanVaultPlugins } = await import("../../src/VaultPluginHost.tsx");

const THEME = { mode: "dark" as const, vars: {} };
const tick = () => new Promise((r) => setTimeout(r, 15));

test("file names, ids and meta", () => {
  for (const n of ["a.js", "pen-cursor.mjs", "B.JS"]) assert.ok(isVaultPluginFile(n), n);
  for (const n of [".hidden.js", "a.html", "a.js.bak", "dir/a.js", "a"]) assert.ok(!isVaultPluginFile(n), n);
  assert.equal(vaultPluginId("pen-cursor.js"), ".vault-chat/plugins/pen-cursor.js");
  assert.equal(vaultPluginFile(".vault-chat/plugins/pen-cursor.js"), "pen-cursor.js");
  assert.equal(vaultPluginFile("app/notes"), null);
  assert.deepEqual(parseVaultPluginMeta(`export const meta = { name: "Pen cursor", description: 'A \\'pen\\'' };\nexport function mount(){}`, "pen-cursor.js"), { name: "Pen cursor", description: "A 'pen'" });
  assert.deepEqual(parseVaultPluginMeta("export function mount(){}", "x.js"), { name: "x", description: "" });
  assert.ok(vaultPluginNamed("pen-cursor", "pen-cursor.js", "Pen cursor"));
  assert.ok(vaultPluginNamed("PEN CURSOR", "pen-cursor.js", "Pen cursor"));
  assert.ok(!vaultPluginNamed("pen", "pen-cursor.js", "Pen cursor"));
});

test("scanVaultPlugins reads the folder: added, changed and removed files show on the next look; a missing folder is none", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "vc-vp-"));
  try {
    const dir = path.join(vault, ".vault-chat/plugins");
    // Same shape as the Tauri list_dir / read_text_file commands (list_dir skips dot files).
    const call = async (cmd: string, a: any): Promise<any> => {
      if (cmd === "list_dir") {
        return fs.readdirSync(a.path, { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).map((e) => ({ name: e.name, path: path.join(a.path, e.name), is_dir: e.isDirectory() }));
      }
      return fs.readFileSync(a.path, "utf8");
    };
    assert.deepEqual(await scanVaultPlugins(vault, call), []);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.js"), `export const meta = { name: "Alpha" };\nexport function mount(){}`);
    fs.writeFileSync(path.join(dir, "notes.txt"), "no");
    fs.writeFileSync(path.join(dir, ".dot.js"), "no");
    let l = await scanVaultPlugins(vault, call);
    assert.deepEqual(l.map((p) => [p.file, p.id, p.name]), [["a.js", ".vault-chat/plugins/a.js", "Alpha"]]);
    fs.writeFileSync(path.join(dir, "b.mjs"), "export function mount(){}");
    fs.writeFileSync(path.join(dir, "a.js"), "export function mount(){ /* v2 */ }");
    l = await scanVaultPlugins(vault, call);
    assert.deepEqual(l.map((p) => p.file), ["a.js", "b.mjs"]);
    assert.match(l[0]!.code, /v2/);
    fs.rmSync(path.join(dir, "a.js"));
    assert.deepEqual((await scanVaultPlugins(vault, call)).map((p) => p.file), ["b.mjs"]);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test("a code plugin mounts in the light DOM from its text, gets the api, is reverted on unmount, reloads with new code, and a throw is an error card", async () => {
  const { window, document } = parseHTML("<!doctype html><html><head></head><body><span id=host></span></body></html>");
  const listeners: Record<string, Set<unknown>> = {};
  const win = {
    DOMParser: (window as any).DOMParser,
    addEventListener: (k: string, f: unknown) => (listeners[k] ??= new Set()).add(f),
    removeEventListener: (k: string, f: unknown) => void listeners[k]?.delete(f),
  };
  const count = () => Object.values(listeners).reduce((n, s) => n + s.size, 0);
  const host = document.getElementById("host") as unknown as HTMLElement;
  const loaded: string[] = [];
  const disposed: string[] = [];
  // The code text stands in for the module: "ok:<tag>" mounts, "throw" throws on mount.
  const load: LoadModule = async (code) => {
    loaded.push(code);
    const module = {
      mount(el: HTMLElement, api: any) {
        if (code === "throw") throw new Error("boom");
        el.textContent = code;
        const mark = document.createElement("b");
        document.body.appendChild(mark);
        api.effect(() => mark.remove());
        api.listen(win as any, "mousemove", () => {});
        api.timer(() => {}, 10_000, true);
        assert.equal(typeof api.error, "function");
        assert.equal(api.theme.mode, "dark");
      },
    };
    return { module, url: "blob:x", dispose: () => void disposed.push(code) };
  };
  const base = count();
  const h = mountPlugin(host, { name: "Pen", code: "ok:1" }, { path: ".vault-chat/plugins/pen.js", theme: () => THEME, win: win as any, load });
  await h.ready;
  assert.equal(h.error, null);
  assert.equal(host.shadowRoot, null, "light DOM: no shadow root");
  assert.match(host.textContent ?? "", /ok:1/);
  assert.ok(document.querySelector("b"));
  assert.ok(count() > base);
  await h.reload();
  assert.equal(document.querySelectorAll("b").length, 1, "reload reverted the first run's effects");
  h.unmount();
  assert.equal(document.querySelectorAll("b").length, 0);
  assert.equal(count(), base, "nothing left behind");
  assert.ok(disposed.includes("ok:1"));
  const bad = mountPlugin(host, { name: "Bad", code: "throw" }, { path: ".vault-chat/plugins/bad.js", theme: () => THEME, win: win as any, load });
  await bad.ready;
  await tick();
  assert.match(bad.error ?? "", /boom/);
  assert.ok(host.querySelector('[data-el="plugin-error"]'));
  bad.unmount();
});
