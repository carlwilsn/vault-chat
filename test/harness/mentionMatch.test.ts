// The composer's @ picker matching (src/plugins/composer/mentionMatch.ts): fuzzy letters in order, name matches over
// path matches, shallower paths first, recent files boosted, at most 8 rows, hidden entries never, and the matched
// letters reported for the name and the parent folder separately (the row lights them; the name never repeats in it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzy, rankMentions, MENTION_ROWS } from "../../src/plugins/composer/mentionMatch.ts";

const V = "/v";
const f = (rel: string, o: { dir?: boolean; hidden?: boolean } = {}) => ({
  path: `${V}/${rel}`,
  name: rel.split("/").pop()!,
  is_dir: !!o.dir,
  depth: rel.split("/").length - 1,
  hidden: !!o.hidden,
});
const names = (hits: { rel: string }[]) => hits.map((h) => h.rel);

test("fuzzy: a substring beats scattered letters, a start beats the middle, letters must be in order", () => {
  assert.deepEqual(fuzzy("con", "constitution.md")!.idx, [0, 1, 2]);
  const start = fuzzy("con", "constitution.md")!.score;
  const mid = fuzzy("con", "reconcile.md")!.score;
  const scattered = fuzzy("con", "cotton.md")!.score;
  assert.ok(start > mid && mid > scattered, `${start} ${mid} ${scattered}`);
  assert.equal(fuzzy("xyz", "constitution.md"), null);
  assert.equal(fuzzy("noc", "con"), null);
});

test("fuzzy: scattered letters prefer word starts", () => {
  assert.deepEqual(fuzzy("rp", "real-proofs.md")!.idx, [0, 5]);
  assert.deepEqual(fuzzy("mpa", "my-paper.md")!.idx, [0, 3, 4]);
});

test("a name match ranks over a match only in the folder path", () => {
  const files = [f("notes/real/week1.md"), f("notes/real"), f("realism.md")];
  const hits = rankMentions(files, V, "real");
  // Both name matches (the exact, shorter name first) come before the file that matches only through its folder.
  assert.deepEqual(names(hits), ["notes/real", "realism.md", "notes/real/week1.md"]);
  // The path-only match lights the folder's letters, not the name's.
  const wk = hits.find((h) => h.rel === "notes/real/week1.md")!;
  assert.deepEqual(wk.ni, []);
  assert.deepEqual(wk.di, [6, 7, 8, 9]);
  assert.equal(wk.dir, "notes/real");
  assert.equal(wk.name, "week1.md");
});

test("shallower paths first among equal names; recent files boosted", () => {
  const files = [f("a/b/c/plan.md"), f("a/plan.md"), f("plan.md")];
  assert.deepEqual(names(rankMentions(files, V, "plan")), ["plan.md", "a/plan.md", "a/b/c/plan.md"]);
  assert.deepEqual(names(rankMentions(files, V, "plan", [`${V}/a/b/c/plan.md`])), ["a/b/c/plan.md", "plan.md", "a/plan.md"]);
});

test("a query with a slash matches the path; the name part is lit in the name", () => {
  const files = [f("hw/set3.pdf"), f("notes/set3.md")];
  const hits = rankMentions(files, V, "hw/set");
  assert.deepEqual(names(hits), ["hw/set3.pdf"]);
  assert.deepEqual(hits[0]!.ni, [0, 1, 2]);
  assert.deepEqual(hits[0]!.di, [0, 1]);
});

test("at most 8 rows, hidden entries never, folders marked", () => {
  const files = [...Array.from({ length: 20 }, (_, i) => f(`doc${i}.md`)), f("docs", { dir: true }), f("doc-secret.md", { hidden: true })];
  const hits = rankMentions(files, V, "doc");
  assert.equal(hits.length, MENTION_ROWS);
  assert.ok(!hits.some((h) => h.rel === "doc-secret.md"));
  assert.equal(rankMentions(files, V, "docs")[0]!.isDir, true);
  assert.deepEqual(rankMentions(files, null, "doc"), []);
});

test("an empty @ lists recent files first, then the vault's top level in tree order", () => {
  const files = [f("a", { dir: true }), f("a/deep.md"), f("b.md"), f("gone.md", { hidden: true }), f("c.md")];
  const hits = rankMentions(files, V, "", [`${V}/a/deep.md`, `${V}/missing.md`, `${V}/gone.md`]);
  assert.deepEqual(names(hits), ["a/deep.md", "a", "b.md", "c.md"]);
  assert.deepEqual(names(rankMentions(files, V, "")), ["a", "b.md", "c.md"]);
});

test("rankNames: the / menu's fuzzy match by name, best first, ties in list order, empty keeps the list", async () => {
  const { rankNames } = await import("../../src/plugins/composer/mentionMatch.ts");
  const skills = ["review", "commit", "code-review", "simplify", "security-review"].map((name) => ({ name }));
  const by = (q: string) => rankNames(skills, (s) => s.name, q).map((h) => h.item.name);
  assert.deepEqual(by(""), ["review", "commit", "code-review", "simplify", "security-review"]);
  assert.equal(by("rev")[0], "review");
  assert.ok(by("cr").includes("code-review"));
  assert.deepEqual(rankNames(skills, (s) => s.name, "com")[0]!.idx, [0, 1, 2]);
  assert.deepEqual(by("zzz"), []);
  assert.equal(rankNames(Array.from({ length: 20 }, (_, i) => ({ name: `s${i}` })), (s) => s.name, "s").length, 8);
});
