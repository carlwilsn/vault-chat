// Actual Arbiter -> BoardView actions/edits, without mounting canvases. Rendering and persistence are spies,
// not UI proof; scripts/real-desktop.py checks trusted browser pen input separately. Shapes here are synthetic.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Arbiter, type PEvent, type Kind } from "../../board/src/palm.ts";
import { scribbleTraces } from "../../board/src/scribbleTraces.ts";

Object.assign(globalThis, {
  // Bounds/coverage use real geometry; the unused canvas path object is a rendering stub.
  Path2D: class { moveTo() {} lineTo() {} quadraticCurveTo() {} },
  location: { search: "" },
  window: { setTimeout, clearTimeout },
  localStorage: { getItem: () => null, setItem: () => {} },
});
// The existing harness loader stubs PDF/CSS imports; no SDK, browser, audio or network is started.
const { BoardView } = await import("../../board/src/view.ts");
const { flushBoardLog } = await import("../../board/src/log.ts");
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('{}', { status: 200 });
after(async () => { await flushBoardLog(); globalThis.fetch = realFetch; });

const pts = scribbleTraces(3).find(t => t.name.startsWith("horizontal scribble"))!.pts;
function fixture(kind: Kind = "pen") {
  const v: any = Object.create(BoardView.prototype);
  const target = { id: "target", tool: "pen", color: "#111", w: 2.4, xy: [280, 295, 290, 300, 300, 295] };
  Object.assign(v, {
    board: { strokes: [target], items: [{ id: "protected", kind: "math", x: 0, y: 0, w: 5, h: 5 }] },
    prefs: { mode: "pen", pen: 2.4, penColor: "#111", penStyle: "solid", scribble: true },
    cam: { x: 0, y: 0, z: 1 }, stageRect: { left: 0, top: 0 },
    arb: new Arbiter({ hand: "left", pan1: false, penSeen: false }),
    g: null, sel: null, txn: null, tiles: new Map(), fades: [], dimmed: new Set(),
    undoStack: [], redoStack: [], dirty: false, disposed: false,
    perf: { penDown() {}, penUp() {}, input() {} },
    capture() {}, hidePaste() {}, syncToolbar() {}, savePrefs() {}, fitItems() {},
    queueLive() {}, renderBase() {}, invalidate() {}, repaint() { v.repaints++; },
    changed() { v.changes++; }, changes: 0, repaints: 0, decisions: 0,
  });
  const hits = v.scribbleHits.bind(v);
  v.scribbleHits = (...args: any[]) => { v.decisions++; return hits(...args); };
  const send = (type: PEvent["type"], p = pts.at(-1)!, id = 7, k = kind) => {
    for (const a of v.arb.handle({ type, id, kind: k, x: p.x, y: p.y, t: p.t, button: 0, buttons: type === "up" ? 0 : 1 })) v.act(a);
  };
  const draw = () => { send("down", pts[0]); for (const p of pts.slice(1)) send("move", p); };
  return { v, send, draw, target };
}

test("positive contact held past old preview timer: no decision, target edits, tiles or undo until matching up", async () => {
  const { v, send, draw, target } = fixture();
  const original = structuredClone(v.board);
  draw();
  await new Promise(r => setTimeout(r, 85));
  assert.equal(v.decisions, 0);
  assert.equal(v.repaints, 0);
  assert.equal(v.changes, 0);
  assert.equal(v.undoStack.length, 0);
  assert.deepEqual(v.board, original);
  assert.ok(v.g.xy.length > 10, "ordinary live ink is retained");
  send("up");
  assert.equal(v.decisions, 1);
  assert.deepEqual(v.board.strokes, []);
  assert.equal(v.undoStack.length, 1);
  assert.deepEqual(v.board.items, original.items);
  send("up");
  assert.equal(v.decisions, 1, "late/duplicate up is inert");
  v.undo(); assert.deepEqual(v.board.strokes, [target]);
  v.redo(); assert.deepEqual(v.board.strokes, []);
});

test("positive prefix then ordinary long writing stays ink, with no earlier decisions", () => {
  const { v, send, draw, target } = fixture();
  draw();
  assert.equal(v.decisions, 0);
  const tail = { x: 1100, y: 600, t: pts.at(-1)!.t + 100 };
  send("move", tail); send("up", tail);
  assert.equal(v.decisions, 1);
  assert.equal(v.board.strokes.length, 2);
  assert.deepEqual(v.board.strokes[0], target);
});

test("positive pointercancel preserves interrupted pen ink, never an erase transaction", () => {
  const { v, send, draw, target } = fixture();
  draw(); send("cancel"); send("up");
  assert.equal(v.decisions, 0);
  assert.deepEqual(v.board.strokes[0], target);
  assert.equal(v.board.strokes.length, 2);
  assert.equal(v.undoStack.length, 1, "only interrupted ink is undoable");
  assert.equal(v.undoStack[0].strokes.removed.length, 0);
});

test("foreign up/cancel (including same id, different kind) cannot finish drawing", () => {
  const { v, send, draw } = fixture();
  draw(); send("up", undefined, 99); send("cancel", undefined, 99);
  send("up", undefined, 7, "mouse"); send("cancel", undefined, 7, "touch");
  assert.ok(v.g);
  assert.equal(v.decisions, 0);
  send("up"); assert.equal(v.decisions, 1);
});

for (const kind of ["mouse"] as const) test(`${kind} fallback remains eligible on normal up`, () => {
  const { v, send, draw } = fixture(kind);
  draw(); assert.equal(v.decisions, 0);
  send("up"); assert.equal(v.decisions, 1); assert.equal(v.board.strokes.length, 0);
});

test("final real up point participates once, pressure/buttons-zero up is not cancellation", () => {
  const { v, send, draw, target } = fixture();
  draw();
  // This actual endpoint makes the formerly positive prefix too large; ignoring up would wrongly erase.
  send("up", { x: 1100, y: 600, t: pts.at(-1)!.t + 100 });
  assert.equal(v.decisions, 1);
  assert.deepEqual(v.board.strokes[0], target);
  assert.deepEqual(v.board.strokes[1].xy.slice(-2), [1100, 600]);
});

test("tool change cancels the existing Arbiter owner; late moves/up do not restart it", () => {
  const { v, send, draw, target } = fixture();
  draw(); v.setMode("hl"); send("move"); send("up");
  assert.equal(v.decisions, 0);
  assert.equal(v.g, null);
  assert.equal(v.arb.state().tool, null);
  assert.deepEqual(v.board.strokes[0], target);
  assert.equal(v.board.strokes.length, 2);
});

test("lost capture goes through view event routing as cancel, and late up cannot erase", () => {
  const { v, send, draw, target } = fixture();
  draw();
  Object.assign(v, { stage: { contains: () => true }, chrome: { has: () => false }, slotHold() {} });
  v.onPointer({ type: "lostpointercapture", pointerId: 7, pointerType: "pen", clientX: 0, clientY: 0, timeStamp: 999, target: v.stage });
  send("up");
  assert.equal(v.decisions, 0);
  assert.equal(v.arb.state().tool, null);
  assert.deepEqual(v.board.strokes[0], target);
  assert.equal(v.board.strokes.length, 2);
});

test("lifecycle interruption is idempotent; redundant moves never start a gesture", () => {
  const { v, send, draw, target } = fixture();
  send("move"); assert.equal(v.g, null);
  draw(); v.interruptTool(); v.interruptTool(); send("move"); send("up");
  assert.equal(v.g, null);
  assert.equal(v.decisions, 0);
  assert.equal(v.undoStack.length, 1);
  assert.deepEqual(v.board.strokes[0], target);
});

test("existing move coalescing accepts Safari id 0/current, not foreign; predictions never enter decision samples", () => {
  const { v, send } = fixture();
  v.cam = { x: 20, y: 30, z: 2 };
  v.stageRect = { left: 100, top: 50 };
  send("down", { x: 10, y: 10, t: 1 });
  v.domEv = {
    pointerId: 7,
    getCoalescedEvents: () => [
      { pointerId: 0, clientX: 120, clientY: 70, timeStamp: 2 },
      { pointerId: 7, clientX: 124, clientY: 74, timeStamp: 3 },
      { pointerId: 99, clientX: 9999, clientY: 9999, timeStamp: 4 },
    ],
    getPredictedEvents: () => [{ clientX: 126, clientY: 76 }],
  };
  send("move", { x: 24, y: 24, t: 3 });
  assert.deepEqual(v.g.raw, [{ x: 25, y: 35, t: 1 }, { x: 30, y: 40, t: 2 }, { x: 32, y: 42, t: 3 }]);
  const raw = v.g.raw;
  send("up", { x: 24, y: 24, t: 5 });
  assert.equal(raw.length, 3, "identical final endpoint is not duplicated or coalesced again");
  assert.equal(v.decisions, 1);
});

test("normal scribble still targets both pen and highlighter; interrupted finger ink is dropped", () => {
  const { v, send, draw, target } = fixture();
  const hl = { ...target, id: "highlight", tool: "hl", w: 18 };
  v.board.strokes.push(hl);
  draw(); send("up");
  assert.equal(v.board.strokes.length, 0);
  v.undo(); assert.deepEqual(v.board.strokes, [target, hl]);
  const f = fixture("touch"); f.draw(); f.send("cancel"); f.send("up");
  assert.deepEqual(f.v.board.strokes, [f.target]);
  assert.equal(f.v.undoStack.length, 0);
  assert.equal(f.v.decisions, 0);
});

test("second-finger interruption cancels the Arbiter's owner, not the triggering finger id", () => {
  const { v, send, target } = fixture("touch");
  send("down", pts[0]);
  for (const p of pts.slice(1, 20)) send("move", p);
  // The Arbiter reports action.id=7 with ev.id=8: the event that interrupts is not the drawing owner.
  const p = pts[19]!;
  send("down", { ...p, t: p.t + 10 }, 8);
  send("up", { ...p, t: p.t + 20 }, 7); send("up", { ...p, t: p.t + 21 }, 8);
  assert.equal(v.decisions, 0);
  assert.equal(v.g, null);
  assert.deepEqual(v.board.strokes, [target]);
  assert.equal(v.undoStack.length, 0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

// Only transport, picture rendering and device storage are replaced. close -> flush -> save/saveOnce ->
// picturesNow, serialization, generation acknowledgement and the interrupted ink transaction are production code.
function closingFixture() {
  const f = fixture();
  const { v } = f;
  const saved = deferred<any>();
  const secondSaved = deferred<any>();
  const rendered = deferred<void>();
  const renderDone = deferred<void>();
  const uploaded = deferred<any>();
  const uploadDone = deferred<Response>();
  const requests: any[] = [];
  const renderBoards: any[] = [];
  const oldXHR = globalThis.XMLHttpRequest;
  const oldFetch = globalThis.fetch;
  Object.assign(globalThis, {
    document: { removeEventListener() {} }, cancelAnimationFrame() {},
    // No IndexedDB is mounted: let the production ack bookkeeping run against unavailable device storage.
    indexedDB: { open() {
      const r: any = {};
      queueMicrotask(() => r.onblocked());
      return r;
    } },
    XMLHttpRequest: class {
      upload = {}; status = 200; responseText = '';
      open() {} setRequestHeader() {}
      send(body: string) {
        requests.push({ body: JSON.parse(body), xhr: this });
        (requests.length === 1 ? saved : secondSaved).resolve(requests.at(-1));
      }
      abort() { throw new Error('unexpected transport timeout'); }
    },
  });
  Object.assign(window, { removeEventListener() {} });
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/pictures')) {
      uploaded.resolve(JSON.parse(init!.body as string));
      return uploadDone.promise;
    }
    return new Response('{}', { status: 200 });
  };
  Object.assign(v, {
    slug: 'synthetic-close', rev: 4, gen: 20, localGen: 20, writer: 'test-writer', lkey: 'test-only',
    localSince: 0, unsavedSince: 0, sinceCapture: 0, stalled: false, conflict: false,
    saving: null, saveAgain: false, picsRev: 0, picsRunning: null, ser: null,
    pool: [], boardPics: new Map(), base: {}, live: {},
    chromeRO: { disconnect() {} }, stageRO: { disconnect() {} },
    items: { dispose() { v.tornDown = true; } }, offVoice() {}, offBadge() {}, saveCam() {},
    perf: { penDown() {}, penUp() {}, input() {}, work() {}, dispose() {} },
    refreshSoon() {}, persistSoon() {}, armStall() {}, setStatus(s: string) { v.status = s; },
    async persistLocal() { v.localGen = v.gen; },
    changed: BoardView.prototype['changed'],
    async exportPictures() {
      renderBoards.push(structuredClone(v.board)); rendered.resolve();
      await renderDone.promise;
      return { overview: 'overview-final-ink', view: 'view-final-ink' };
    },
  });
  return { ...f, saved, secondSaved, rendered, renderDone, uploaded, uploadDone, requests, renderBoards,
    finishSave(ok = true, rev = 5) {
      const { xhr } = requests.at(-1);
      xhr.status = ok ? 200 : 503;
      xhr.responseText = JSON.stringify(ok ? { ok: true, rev, updated: 123 } : { error: 'offline' });
      xhr.onload();
    },
    cleanup() {
      for (const key of ['saveT', 'picsT', 'localT', 'stallT', 'refreshT']) clearTimeout(v[key]);
      globalThis.XMLHttpRequest = oldXHR; globalThis.fetch = oldFetch;
    },
  };
}

function lateInput(v: any, send: ReturnType<typeof fixture>['send']) {
  const before = structuredClone(v.board), gen = v.gen, undo = v.undoStack.length;
  // Exercise actual DOM routing, plus a stale already-queued Arbiter action callback.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    v.onPointer({ type, pointerId: 7, pointerType: 'pen', target: null });
  }
  v.onClick({ target: { closest: () => ({ dataset: { act: 'undo' } }) } });
  v.onInput({ target: { dataset: { range: '' }, value: '99' } });
  v.wheel({ preventDefault() { throw new Error('late wheel reached camera'); } });
  v.onKey({ key: 'z', ctrlKey: true, preventDefault() {} });
  send('down', pts[0]); send('move'); send('up');
  assert.deepEqual(v.board, before);
  assert.equal(v.gen, gen);
  assert.equal(v.undoStack.length, undo);
  assert.equal(v.g, null);
  assert.equal(v.decisions, 0, 'latest stale up must never erase');
}

test('close flushes final interrupted pen generation and matching revision pictures before teardown', async () => {
  const f = closingFixture(); const { v } = f;
  try {
    f.draw();
    const latest = v.g.xy.slice();
    const closed = v.close();
    const { body } = await f.saved.promise;
    assert.equal(body.gen, v.gen); assert.ok(body.gen > 20);
    assert.deepEqual(body.board.strokes[0], f.target);
    assert.deepEqual(body.board.strokes[1].xy, latest);
    assert.equal(body.history.undo.length, 1);
    assert.equal(v.undoStack[0].strokes.removed.length, 0);
    lateInput(v, f.send);
    f.finishSave();
    // Assert after the save completes without waiting on a render that the broken source never starts.
    await v.saving;
    await Promise.resolve();
    assert.equal(f.renderBoards.length, 1, 'close must render its final saved board, not suppress picturesNow');
    await f.rendered.promise;
    assert.equal(v.tornDown, undefined);
    assert.deepEqual(f.renderBoards[0].strokes, body.board.strokes);
    lateInput(v, f.send);
    f.renderDone.resolve();
    const pics = await f.uploaded.promise;
    assert.deepEqual(pics, { rev: 5, overview: 'overview-final-ink', view: 'view-final-ink' });
    assert.equal(v.tornDown, undefined);
    lateInput(v, f.send);
    f.uploadDone.resolve(new Response('{"ok":true}', { status: 200 }));
    await closed;
    assert.equal(v.localGen, body.gen); assert.equal(v.dirty, false);
    assert.equal(v.picsRev, 0); assert.equal(v.tornDown, true); assert.equal(v.disposed, true);
    lateInput(v, f.send);
    v.picsRev = v.rev; await v.picturesNow();
    assert.equal(f.renderBoards.length, 1, 'actual teardown must still block picture work');
  } finally { f.cleanup(); }
});

for (const failure of ['json', 'pictures', 'flush'] as const) test(`close ${failure} failure stays inert, retains pending work and never invents picture success`, async () => {
  const f = closingFixture(); const { v } = f;
  try {
    f.draw();
    if (failure === 'flush') v.flush = async () => { throw new Error('flush rejected'); };
    const closed = v.close();
    if (failure === 'flush') {
      await assert.rejects(closed, /flush rejected/);
    } else {
      await f.saved.promise;
      lateInput(v, f.send);
      f.finishSave(failure !== 'json');
      if (failure === 'pictures') {
        await f.rendered.promise;
        f.renderDone.resolve(); await f.uploaded.promise;
        lateInput(v, f.send);
        f.uploadDone.resolve(new Response('{"error":"offline"}', { status: 503 }));
      }
      await closed;
    }
    assert.equal(v.disposed, true); assert.equal(v.tornDown, true);
    lateInput(v, f.send);
    v.saveFromTimer();
    assert.equal(f.requests.length, failure === 'flush' ? 0 : 1, 'no retry loop after close');
    if (failure === 'pictures') assert.equal(v.picsRev, 5, 'failed pictures remain pending, not acknowledged');
    else { assert.equal(v.dirty, true); assert.equal(f.renderBoards.length, 0); }
    assert.equal(v.board.strokes.length, 2);
    assert.deepEqual(v.board.strokes[0], f.target);
  } finally { f.cleanup(); }
});

test('close waits for the earlier save, then flushes newest interrupted generation and only its pictures', async () => {
  const f = closingFixture(); const { v } = f;
  try {
    v.dirty = true;
    const earlier = v.save();
    const first = await f.saved.promise;
    assert.equal(first.body.gen, 20);
    f.draw();
    const latest = v.g.xy.slice();
    const closed = v.close();
    lateInput(v, f.send);
    assert.equal(f.requests.length, 1);
    f.finishSave(); await earlier;
    const final = await f.secondSaved.promise;
    assert.equal(final.body.base, 5);
    assert.equal(final.body.gen, v.gen); assert.ok(final.body.gen > first.body.gen);
    assert.deepEqual(final.body.board.strokes[1].xy, latest);
    assert.equal(f.renderBoards.length, 0, 'earlier revision must not render while newest JSON is saving');
    lateInput(v, f.send);
    f.finishSave(true, 6);
    await f.rendered.promise;
    assert.deepEqual(f.renderBoards[0].strokes, final.body.board.strokes);
    lateInput(v, f.send);
    f.renderDone.resolve();
    assert.equal((await f.uploaded.promise).rev, 6);
    f.uploadDone.resolve(new Response('{"ok":true}', { status: 200 }));
    await closed;
    assert.equal(v.localGen, final.body.gen); assert.equal(v.picsRev, 0);
    assert.equal(v.board.strokes.length, 2); assert.deepEqual(v.board.strokes[0], f.target);
    lateInput(v, f.send);
  } finally { f.cleanup(); }
});


test("touch drawing cannot erase even before a Pencil has been seen", () => {
  const { v, draw, send, target } = fixture("touch");
  draw(); send("up");
  assert.equal(v.decisions, 0);
  assert.deepEqual(v.board.strokes[0], target);
  assert.equal(v.board.strokes.length, 2);
});

test("every individual down/move preserves exact original strokes/items and history", () => {
  const { v, send } = fixture();
  const original = structuredClone(v.board);
  send("down", pts[0]);
  for (const p of pts.slice(1)) {
    assert.deepEqual(v.board, original);
    assert.equal(v.undoStack.length, 0);
    assert.equal(v.decisions, 0);
    send("move", p);
  }
  assert.deepEqual(v.board, original);
  send("up");
  assert.equal(v.decisions, 1);
});

test("window blur retires the owner once without erasing; late up cannot commit", () => {
  const { v, draw, send, target } = fixture();
  draw(); v.onBlur(); v.onBlur(); send("up");
  assert.equal(v.decisions, 0);
  assert.deepEqual(v.board.strokes[0], target);
  assert.equal(v.undoStack.length, 1);
  assert.equal(v.undoStack[0].strokes.removed.length, 0);
});
