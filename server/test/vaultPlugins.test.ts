// Vault plugins on the box: the code files in .vault-chat/plugins are in the catalog as plugins (name and description
// from their meta) and the Plugins tool turns them off and on by name.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { pluginCatalog } from "../pluginCatalog";
import { resolvePlugin } from "../supervisorTools";
import { catalogText } from "../../src/pluginCatalog";

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

test("the catalog lists plugin code files and a word names one", () => {
  dir = mkdtempSync(join(tmpdir(), "vc-vpc-"));
  mkdirSync(join(dir, ".vault-chat/plugins"), { recursive: true });
  writeFileSync(join(dir, ".vault-chat/plugins/pen-cursor.js"), `export const meta = { name: "Pen cursor", description: "A navy pen." };\nexport function mount(){}`);
  writeFileSync(join(dir, ".vault-chat/plugins/plain.mjs"), "export function mount(){}");
  writeFileSync(join(dir, ".vault-chat/plugins/readme.txt"), "x");
  const c = pluginCatalog(dir);
  const mine = c.plugins.filter((p) => p.mount === "module");
  expect(mine.map((p) => [p.id, p.name, p.description])).toEqual([
    [".vault-chat/plugins/pen-cursor.js", "Pen cursor", "A navy pen."],
    [".vault-chat/plugins/plain.mjs", "plain", undefined],
  ]);
  expect(catalogText(c)).toContain("code file, mounted in the app; A navy pen.");
  for (const w of ["pen-cursor", "Pen Cursor", "pen-cursor.js", ".vault-chat/plugins/pen-cursor.js"]) expect(resolvePlugin(dir, w)).toEqual({ id: ".vault-chat/plugins/pen-cursor.js" });
  expect(resolvePlugin(dir, "plain")).toEqual({ id: ".vault-chat/plugins/plain.mjs" });
  expect("error" in resolvePlugin(dir, "nothing")).toBe(true);
});

test("no folder, no plugin files", () => {
  dir = mkdtempSync(join(tmpdir(), "vc-vpc-"));
  expect(pluginCatalog(dir).plugins).toEqual([]);
});
