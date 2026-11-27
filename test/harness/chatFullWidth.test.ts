// The docked chat can take the whole window (Carl 11-26: "move the Ctrl+Shift+B chat all the way to the left so I can
// have full screen"). Dragging its edge to the left collapses the tile area to 0 (src/App.tsx, TILES_SNAP), and the
// agent's box:workspace resize {chat} does the same through the same outer resize: a chat leaving the tiles less than
// TILES_SNAP takes the whole width (the viewer reads back 0); a narrower chat leaves the tiles their minimum as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

installFakeTauri(makeTempVault("vc-chatfull-"));
const L = await import("../../src/layoutOps.ts");

test("resize {chat} wide enough collapses the tiles to 0; narrower keeps them, and they come back", () => {
  let sizes = { leftPanel: 0, viewer: 900, chat: 500 };
  const measure = () => ({ viewport: { width: 1400, height: 900 }, sizes });
  const calls: number[][] = [];
  const off = L.registerOuterResize((s) => {
    calls.push(s);
    sizes = { leftPanel: s[0], viewer: s[1], chat: s[2] };
  });
  try {
    // The whole window (any width past it is the whole window too).
    assert.equal(L.resizeColumns({ chat: 1400 }, measure), null);
    assert.deepEqual(calls.at(-1), [0, 0, 1400]);
    assert.equal(L.resizeColumns({ chat: 99999 }, measure), null);
    assert.deepEqual(calls.at(-1), [0, 0, 1400]);
    // Near the edge (under TILES_SNAP left for the tiles): snaps to the whole window, as the drag does.
    assert.equal(L.resizeColumns({ chat: 1400 - L.TILES_SNAP + 1 }, measure), null);
    assert.deepEqual(calls.at(-1), [0, 0, 1400]);
    // With the file tree open, the chat takes everything right of it.
    sizes = { leftPanel: 200, viewer: 700, chat: 500 };
    assert.equal(L.resizeColumns({ chat: 1400 }, measure), null);
    assert.deepEqual(calls.at(-1), [200, 0, 1200]);
    // Back out: the tiles return (at least their old floor).
    assert.equal(L.resizeColumns({ chat: 500 }, measure), null);
    assert.deepEqual(calls.at(-1), [200, 700, 500]);
    assert.equal(L.resizeColumns({ chat: 1100 }, measure), null);
    assert.deepEqual(calls.at(-1), [200, 340, 1100], "a chat leaving more than the snap keeps the tiles' minimum");
  } finally {
    off();
  }
});
