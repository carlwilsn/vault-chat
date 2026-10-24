// The composer's placeholder on one line at any width, cut with an ellipsis (src/fitPlaceholder.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitText } from "../../src/fitPlaceholder.ts";

const measure = (s: string) => s.length * 7; // 7 px a character

test("fits as it is when there is room; else cut at a word, with an ellipsis, never wider than the room", () => {
  const t = "Ask anything, or / for commands…";
  assert.equal(fitText(t, 1000, measure), t);
  for (const w of [40, 70, 100, 140, 180, 220]) {
    const out = fitText(t, w, measure);
    assert.ok(measure(out) <= w || out === "…", `${w}: ${out}`);
    assert.ok(out.endsWith("…"), out);
  }
  assert.equal(fitText(t, 100, measure), "Ask anything…");
  assert.equal(fitText(t, 5, measure), "…");
});
