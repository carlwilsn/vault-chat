// A plugin turned off is never painted when the app starts (src/pluginSupervisorApp.ts): until its records are known no
// view mounts it, and the records last seen are kept per vault and folded before the first render.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-pluginstartup-");
const other = makeTempVault("vc-pluginstartup-b-");
const fake = installFakeTauri(vault);
(globalThis as any).React = React;
after(() => {
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

const word = (seq: number, plugin: string, state: "running" | "stopped") => ({ seq, at: seq, type: "signal", signal: { type: "plugin.desired", plugin, state, at: seq, by: "carl" } });
// The last session saw app/notes turned off; the app starts in that vault.
globalThis.localStorage.setItem("vault_chat_last_vault", vault);
globalThis.localStorage.setItem(`vc.supervisor:${vault}`, JSON.stringify([word(5, "app/notes", "stopped")]));

const { AppPluginMount } = await import("../../src/PluginMount.tsx");
const app = await import("../../src/pluginSupervisorApp.ts");
const { useStore } = await import("../../src/store.ts");
const mod = { mount: () => () => {} };
const view = (id: string) => renderToStaticMarkup(createElement(AppPluginMount, { plugin: { id, name: id }, module: mod }));

test("the first render already follows the cached records: the plugin turned off is not mounted, the others are", () => {
  assert.equal(view("app/notes"), "", "never painted, not even for a moment");
  assert.match(view("app/other"), /data-vc-plugin="app\/other"/);
});

test("no records known yet (no copy): nothing mounts until the box answers, then what runs mounts and what is off stays off", async () => {
  let answer: (v: unknown) => void = () => {};
  fake.setHandler("vault_box_config", () => ({ box: "http://127.0.0.1:1" }));
  fake.setHandler("box_get_json", () => new Promise((r) => (answer = r)));
  useStore.setState({ vaultPath: other });
  assert.equal(view("app/other"), "", "another vault chosen: the first one's records do not answer for it");
  const loaded = app.loadSupervisor();
  assert.equal(view("app/notes"), "", "unknown: not mounted");
  assert.equal(view("app/other"), "", "unknown: not mounted either (it might be off)");
  await new Promise((r) => setTimeout(r, 20));
  answer({ status: 200, body: JSON.stringify({ records: [word(7, "app/other", "stopped")] }) });
  await loaded;
  assert.equal(view("app/other"), "", "off: never shown");
  assert.match(view("app/notes"), /data-vc-plugin="app\/notes"/, "running here: mounted once known");
  // Kept for the next start.
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem(`vc.supervisor:${other}`)!).map((r: { seq: number }) => r.seq), [7]);
});
