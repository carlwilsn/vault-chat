// A rename to a name with a slash must not create folders (Carl typed "11/5").
import { test } from "node:test";
import assert from "node:assert/strict";
import { entryName } from "../../src/entryName.ts";

test("a slash or backslash in a new name becomes a dash, not a folder", () => {
  assert.equal(entryName("AMLE Case Ideation 11/5.md"), "AMLE Case Ideation 11-5.md");
  assert.equal(entryName("a\\b/c"), "a-b-c");
});

test("ordinary names are kept; empty and dot names are refused", () => {
  assert.equal(entryName("  notes.md "), "notes.md");
  assert.equal(entryName(""), null);
  assert.equal(entryName(".."), null);
});
