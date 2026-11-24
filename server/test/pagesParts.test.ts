// box:pages lists only what is there: the vault .js plugins were removed (11-24) and their on/off records stay in the
// log, but a record of a file that is gone (a .js plugin, a deleted page) is not listed among the parts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { listedPart } from "../model/pages";

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

test("an app part and a page that is there are listed; a .js plugin record or a page that is gone is not", () => {
  dir = mkdtempSync(join(tmpdir(), "vc-pages-parts-"));
  mkdirSync(join(dir, "pages"), { recursive: true });
  writeFileSync(join(dir, "pages", "lab.html"), "<title>Lab</title>");
  expect(listedPart(dir, "app/notes")).toBe(true);
  expect(listedPart(dir, "pages/lab.html")).toBe(true);
  expect(listedPart(dir, "pages/gone.html")).toBe(false);
  expect(listedPart(dir, ".vault-chat/plugins/snail-cursor.js")).toBe(false);
  // Even with the file still in the folder: .js plugins are not mounted any more.
  mkdirSync(join(dir, ".vault-chat", "plugins"), { recursive: true });
  writeFileSync(join(dir, ".vault-chat", "plugins", "calc.js"), "export function mount(){}");
  expect(listedPart(dir, ".vault-chat/plugins/calc.js")).toBe(false);
});
