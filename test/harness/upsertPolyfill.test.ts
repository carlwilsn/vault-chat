// pdf.js 5.6 calls Map/WeakMap getOrInsertComputed, which macOS 15's WebKit lacks (no PDF drew on a Mac):
// src/upsertPolyfill.ts adds the methods only where missing, with the proposal's semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addUpsert } from "../../src/upsertPolyfill";

test("getOrInsert / getOrInsertComputed: insert once, return the stored value, compute lazily", () => {
  class Bare<K, V> {
    m = new Map<K, V>();
    has(k: K) { return this.m.has(k); }
    get(k: K) { return this.m.get(k); }
    set(k: K, v: V) { this.m.set(k, v); return this; }
  }
  assert.equal(addUpsert(Bare.prototype as never), 2);
  assert.equal(addUpsert(Bare.prototype as never), 0, "a second install adds nothing");
  const b = new Bare<string, number[]>() as any;
  let made = 0;
  const arr = b.getOrInsertComputed("a", (k: string) => (made++, [k.length]));
  arr.push(7);
  assert.deepEqual(b.getOrInsertComputed("a", () => (made++, [])), [1, 7]);
  assert.equal(made, 1);
  assert.equal(b.getOrInsert("x", 1), 1);
  assert.equal(b.getOrInsert("x", 2), 1);
  assert.throws(() => b.getOrInsertComputed("z", 5), TypeError);
  assert.ok(!Object.keys(Bare.prototype).includes("getOrInsert"), "non-enumerable");
  // A prototype that has them keeps its own.
  const own = { has: () => true, get: () => 1, set: () => 0, getOrInsert: () => "native", getOrInsertComputed: () => "native" };
  assert.equal(addUpsert(own as never), 0);
  assert.equal(own.getOrInsert(), "native");
});

test("pdf.js gets its worker in one place, the legacy one where the webview lacks upsert", () => {
  const root = join(import.meta.dirname, "../..");
  const setup = readFileSync(join(root, "src/pdfjsSetup.ts"), "utf8");
  assert.match(setup, /legacy\/build\/pdf\.worker\.min\.mjs\?url/);
  assert.match(setup, /if \(legacy\) installUpsert\(\);/);
  for (const f of ["src/PdfView.tsx", "src/fileText.ts"]) {
    const s = readFileSync(join(root, f), "utf8");
    assert.match(s, /from "\.\/pdfjsSetup"/, f);
    assert.doesNotMatch(s, /pdf\.worker|GlobalWorkerOptions/, f);
  }
});
