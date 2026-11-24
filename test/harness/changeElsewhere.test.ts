// Undo for a change in a vault the laptop does not have open (2026-11-20: a per-vault part applied in school2 while the
// laptop showed vault-chat; its "Done" line drew no Undo, because the app folds only its open vault's records). The
// line now names its vault (server/changeNotices.ts), the reducer keeps it, and src/changeElsewhere.ts reads that
// vault's records and writes Undo there (POST /api/v2/supervisor with ?vault=).
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

installFakeTauri(makeTempVault("vc-elsewhere-"));
const { isElsewhere, readElsewhere, undoElsewhere, changesIn } = await import("../../src/changeElsewhere.ts");
const { lineState } = await import("../../src/changeFlow.ts");

const PLUGIN = "app/wild-chat";
const rec = (seq: number, s: Record<string, unknown>) => ({ seq, at: 1000 + seq, type: "signal", signal: { type: "plugin.change", plugin: PLUGIN, at: 1000 + seq, ...s } });
const keep = rec(5, { change: "keep", version: "def43751", by: "gate", from: "built-in" });
const change = { plugin: PLUGIN, version: "def43751", offer: "undo" as const, vault: "school2" };

test("a line of another vault is told apart from one of the open vault", () => {
  assert.equal(isElsewhere(change, "C:/Users/c/vc/vaults/vault-chat"), true);
  assert.equal(isElsewhere(change, "C:\\Users\\c\\vc\\vaults\\school2"), false);
  assert.equal(isElsewhere({ vault: undefined }, "/x/vault-chat"), false, "an older line (no vault) keeps the usual records");
});

test("that vault's records make the line 'applied' (Undo shows); Undo is written into that vault", async () => {
  const gets: any[] = [];
  const posts: any[] = [];
  let records: any[] = [keep];
  const deps = {
    link: async () => ({ url: "http://box", token: null, vault: "vault-chat" }),
    get: async (link: any, path: string) => (gets.push({ link, path }), { records }),
    post: async (link: any, path: string, body: any) => {
      posts.push({ link, path, body });
      records = [...records, rec(9, { change: "switch", version: "built-in", by: "carl", from: "def43751" })];
      return { ok: true, data: { text: "switched back" } };
    },
  };
  const before = await readElsewhere(change, "/v/vault-chat", deps as any);
  assert.equal(gets[0].link.vault, "school2", "read from the line's vault, not the open one");
  assert.equal(lineState(change, before!.changes, false, null).state, "applied");
  // The open vault's records (none for this plugin) would have hidden Undo: the bug.
  assert.equal(lineState(change, changesIn([], PLUGIN), false, null).state, "gone");
  const r = await undoElsewhere(change, "/v/vault-chat", deps as any);
  assert.deepEqual(r, { ok: true, text: "switched back" });
  assert.equal(posts[0].link.vault, "school2");
  assert.deepEqual(posts[0].body, { plugin: PLUGIN, change: "switch", by: "carl" });
  const after = await readElsewhere(change, "/v/vault-chat", deps as any);
  assert.equal(lineState(change, after!.changes, false, null).state, "undone");
});

test("the reducer keeps the line's vault; the box writes it for a per-vault part", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../../src/convlog/reduce.ts", import.meta.url), "utf8");
  assert.match(src, /typeof x\.vault === "string"/);
  const { sayChange, _setChangeLineSink } = await import("../../server/changeNotices.ts");
  const got: any[] = [];
  _setChangeLineSink((_v: string, _c: string, l: any) => void got.push(l));
  try {
    await sayChange("/box/vaults/school2", "c1", { kind: "done", plugin: PLUGIN, version: "def43751", text: "Done: x", offer: "undo" });
    await sayChange("/box/vaults/school2", "c1", { kind: "done", plugin: "app/core", version: "1", text: "Done: core", offer: "undo" });
  } finally {
    _setChangeLineSink(null);
  }
  assert.equal(got[0].vault, "school2");
  assert.equal(got[1].vault, undefined, "the core is one per box");
});
