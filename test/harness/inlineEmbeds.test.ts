// One live copy of a page file in the feed (src/inlineEmbeds.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewestEmbed, newestEmbed, registerEmbed } from "../../src/inlineEmbeds.ts";

(globalThis as any).Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
// Elements numbered by their place in the feed.
const el = (pos: number, connected = true) => ({ pos, isConnected: connected, compareDocumentPosition(o: { pos: number }) { return o.pos > pos ? 4 : 2; } }) as unknown as HTMLElement;

test("the last embed of a file in the feed is the live one; others are older", () => {
  const a = el(1), b = el(5), c = el(3);
  const un = [registerEmbed("v/x.html", a), registerEmbed("v/x.html", b), registerEmbed("v/x.html", c)];
  assert.equal(newestEmbed("v/x.html"), b);
  assert.equal(isNewestEmbed("v/x.html", b), true);
  assert.equal(isNewestEmbed("v/x.html", a), false);
  assert.equal(isNewestEmbed("v/x.html", c), false);
  un[1]!(); // the newest goes away: the next newest takes over
  assert.equal(isNewestEmbed("v/x.html", c), true);
  assert.equal(isNewestEmbed("v/x.html", a), false);
  un[0]!(); un[2]!();
  assert.equal(newestEmbed("v/x.html"), null);
});

test("another file, a Windows-style path of the same file, and an unregistered element", () => {
  const a = el(1), b = el(2);
  const un = [registerEmbed("v\\x.html", a), registerEmbed("v/y.html", b)];
  assert.equal(isNewestEmbed("v/x.html", a), true);
  assert.equal(isNewestEmbed("v/y.html", b), true);
  assert.equal(isNewestEmbed("v/x.html", null), true);
  const c = el(9);
  un.push(registerEmbed("v/x.html", c));
  assert.equal(isNewestEmbed("v/x.html", a), false);
  un.forEach((f) => f());
});
