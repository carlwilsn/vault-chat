// Change ready on the phone and the iPad board (src/changeCards.ts, phone/src/changes.ts, board/src/changes.ts): the
// box's list of drafts drawn as a card with Keep / Discard (and Try on the phone for a draft that runs there), Carl's
// word through the same POST /api/v2/supervisor as the laptop's, a word from another surface clearing the card here,
// a tried draft that throws discarding itself, a surface turned off showing nothing, and nothing pending drawing
// nothing at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { LoadModule } from "../../src/mountHost.ts";
import { _resetRows } from "../../src/chatRows.ts";
import { _resetOffers } from "../../src/pluginOffers.ts";

const { window, document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
(globalThis as any).document = document;
const { startPhoneHost } = await import("../../phone/src/plugins.ts");
const { startPhoneChanges } = await import("../../phone/src/changes.ts");
const { startBoardChanges } = await import("../../board/src/changes.ts");

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const THEME = { mode: "dark" as const, vars: {} };
const win = { DOMParser: (window as any).DOMParser, addEventListener() {}, removeEventListener() {} };
const click = (sel: string) => {
  const b = document.querySelector(sel) as any;
  assert.ok(b, `no ${sel}`);
  b.dispatchEvent(new (window as any).Event("click", { bubbles: true }));
};
const card = () => document.querySelector('[data-el="change-ready"]') as HTMLElement | null;

const LIVE = "live rows";
const DRAFT = "draft rows";
type Change = { plugin: string; name: string; what: string; version: string; added: boolean; tryOn: string[]; code?: string };
type Box = { changes: Change[]; off?: string; words: any[]; plugins: { id: string; name: string; code: string }[]; gets: number };

function fakeBox(box: Box) {
  return async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/v2/changes")) {
      box.gets++;
      return new Response(JSON.stringify({ changes: box.off ? [] : box.changes, ...(box.off ? { off: box.off } : {}) }), { status: 200 });
    }
    if (path === "/api/v2/supervisor" && init?.method === "POST") {
      const b = JSON.parse(String(init.body));
      box.words.push(b);
      if (b.version) box.changes = box.changes.filter((c) => !(c.plugin === b.plugin && c.version === b.version));
      if (b.change === "keep") box.plugins = box.plugins.map((p) => (p.id === b.plugin ? { ...p, code: DRAFT } : p));
      return new Response(JSON.stringify({ ok: true, seq: box.words.length, text: `${b.change} done` }), { status: 200 });
    }
    if (path.startsWith("/api/v2/supervisor")) return new Response(JSON.stringify({ seq: 0, records: [] }), { status: 200 });
    if (path.startsWith("/api/v2/plugin/device")) return new Response(JSON.stringify({ device: "phone", plugins: box.plugins }), { status: 200 });
    return new Response("{}", { status: 200 });
  };
}

// "throw" in the code: the module throws when it mounts (a broken draft).
const load: LoadModule = async (code) => ({
  module: {
    mount() {
      if (code.includes("throw")) throw new Error("the draft broke");
    },
  },
  url: "blob:" + code,
  dispose() {},
});

const ROWS = ".vault-chat/plugins/rows.js";
const rowsDraft = (code = DRAFT, version = "aaaaaaaa"): Change => ({ plugin: ROWS, name: "Rows", what: "a rounder chat row", version, added: false, tryOn: ["laptop", "phone"], code });
const notesDraft: Change = { plugin: "app/notes", name: "Notes", what: "bigger note text", version: "bbbbbbbb", added: false, tryOn: ["laptop"] };

function phone(box: Box) {
  _resetRows();
  _resetOffers();
  const api = fakeBox(box) as any;
  const host = startPhoneHost({ api, toast() {}, where: () => ({ page: "chat", chat: "main", title: "Main" }), redraw() {}, load, win: win as any, theme: () => THEME, everyMs: 60_000 });
  const ch = startPhoneChanges({ api, host: () => host, everyMs: 60_000, visible: () => true });
  return {
    host,
    ch,
    stop() {
      ch.stop();
      host.stop();
    },
  };
}

test("nothing pending: the phone draws no card at all, and asks the box once", async () => {
  const box: Box = { changes: [], words: [], plugins: [], gets: 0 };
  const p = phone(box);
  try {
    await tick(60);
    assert.equal(card(), null);
    assert.equal(box.gets, 1);
    // A record that cannot move the list asks nothing; one that can reads it again.
    p.ch.record({ type: "signal", signal: { type: "notif" } });
    p.ch.record({ type: "signal", signal: { type: "plugin.change", plugin: "x" } });
    await tick(200);
    assert.equal(box.gets, 2);
    assert.equal(card(), null);
  } finally {
    p.stop();
  }
});

test("the phone tries a draft that names it in place of the live copy, Keep posts the word, the kept copy stays mounted", async () => {
  const box: Box = { changes: [rowsDraft(), notesDraft], words: [], plugins: [{ id: ROWS, name: "Rows", code: LIVE }], gets: 0 };
  const p = phone(box);
  try {
    await tick(80);
    assert.equal(document.querySelector('[data-el="change-ready-title"]')?.textContent, "Change ready: a rounder chat row");
    assert.match(card()!.textContent!, /1 more/);
    assert.deepEqual(p.host.mounted().map((m) => [m.id, m.draft ?? null]), [[ROWS, null]]);

    click('[data-el="change-try"]');
    await tick(40);
    assert.deepEqual(p.host.mounted().map((m) => [m.id, m.draft ?? null]), [[ROWS, "aaaaaaaa"]]);
    assert.ok(card()!.hasAttribute("data-vc-trying"));
    assert.match(document.querySelector('[data-el="change-trying"]')!.textContent!, /Trying it on this phone/);

    click('[data-el="change-keep"]');
    await tick(200);
    assert.deepEqual(box.words[0], { plugin: ROWS, change: "keep", version: "aaaaaaaa", by: "carl" });
    // The draft is the live copy now (no flash back to the old one), and the next waiting draft shows, Keep / Discard
    // only: it is an app plugin's, tried on the laptop.
    assert.deepEqual(p.host.mounted().map((m) => m.id), [ROWS]);
    assert.equal(document.querySelector('[data-el="change-ready-title"]')?.textContent, "Change ready: bigger note text");
    assert.equal(document.querySelector('[data-el="change-try"]'), null);
    assert.match(document.querySelector('[data-el="change-direct"]')!.textContent!, /Try it on the laptop/);
    assert.match(document.querySelector('[data-el="change-outcome"]')!.textContent!, /Rows: Kept/);
    assert.ok(document.querySelector('[data-el="change-switch-back"]'));

    // Decided on the laptop: the plugin.change record reaches the phone's feed, the list is read again, the card goes.
    box.changes = [];
    p.ch.record({ type: "signal", signal: { type: "plugin.change", plugin: "app/notes", change: "discard" } });
    click('[aria-label="Dismiss"]');
    await tick(250);
    assert.equal(card(), null);
  } finally {
    p.stop();
  }
});

test("a draft tried on the phone that throws discards itself (a record by auto) and the phone falls back to the live copy", async () => {
  const box: Box = { changes: [rowsDraft("throw rows", "cccccccc")], words: [], plugins: [{ id: ROWS, name: "Rows", code: LIVE }], gets: 0 };
  const p = phone(box);
  try {
    await tick(80);
    click('[data-el="change-try"]');
    await tick(150);
    assert.equal(box.words.length, 1);
    assert.equal(box.words[0].change, "discard");
    assert.equal(box.words[0].by, "auto");
    assert.equal(box.words[0].version, "cccccccc");
    assert.match(box.words[0].reason, /the draft broke/);
    assert.deepEqual(p.host.mounted().map((m) => [m.id, m.draft ?? null, m.error]), [[ROWS, null, null]]);
    assert.match(document.querySelector('[data-el="change-outcome"]')!.textContent!, /Discarded by itself: .*the draft broke/);
  } finally {
    p.stop();
  }
});

test("decided elsewhere while the phone tries it: the phone stops trying", async () => {
  const box: Box = { changes: [rowsDraft()], words: [], plugins: [{ id: ROWS, name: "Rows", code: LIVE }], gets: 0 };
  const p = phone(box);
  try {
    await tick(80);
    click('[data-el="change-try"]');
    await tick(40);
    assert.equal(p.host.mounted()[0]!.draft, "aaaaaaaa");
    box.changes = [];
    p.ch.record({ type: "signal", signal: { type: "plugin.change", plugin: ROWS, change: "discard" } });
    await tick(250);
    assert.equal(p.host.mounted()[0]!.draft, undefined);
    assert.equal(card(), null);
  } finally {
    p.stop();
  }
});

test("the board: Keep / Discard only (it says where to try it), a word clears it, a board turned off shows nothing", async () => {
  const box: Box = { changes: [rowsDraft(), notesDraft, { plugin: "app/settings-values", name: "Settings", what: "the model opus", version: "dddddddd", added: false, tryOn: [] }], words: [], plugins: [], gets: 0 };
  let feed: ((rec: unknown) => void) | null = null;
  const events: string[] = [];
  const b = startBoardChanges({ api: fakeBox(box) as any, onFeed: (fn) => ((feed = fn), () => (feed = null)), blog: (ev) => void events.push(ev), everyMs: 60_000, visible: () => true });
  try {
    await tick(60);
    assert.equal(document.querySelector('[data-el="change-ready-title"]')?.textContent, "Change ready: a rounder chat row");
    assert.equal(document.querySelector('[data-el="change-try"]'), null);
    assert.match(document.querySelector('[data-el="change-direct"]')!.textContent!, /Try it on the laptop or the phone/);
    click('[data-el="change-discard"]');
    await tick(150);
    assert.deepEqual(box.words[0], { plugin: ROWS, change: "discard", version: "aaaaaaaa", by: "carl" });
    assert.equal(document.querySelector('[data-el="change-ready-title"]')?.textContent, "Change ready: bigger note text");
    // Later hides this one: the settings draft (the box applies it: no Try anywhere) shows.
    click('[aria-label="Later"]');
    assert.equal(document.querySelector('[data-el="change-ready-title"]')?.textContent, "Change ready: the model opus");
    assert.match(document.querySelector('[data-el="change-direct"]')!.textContent!, /The box applies this/);
    click('[data-el="change-keep"]');
    await tick(150);
    assert.deepEqual(box.words[1], { plugin: "app/settings-values", change: "keep", version: "dddddddd", by: "carl" });
    assert.ok(events.includes("change.word"));

    // The board turned off: its list is empty with the line, and the card goes (after the outcome is dismissed).
    box.off = "The iPad board is turned off by Carl.";
    feed!({ type: "signal", signal: { type: "plugin.desired", plugin: "app/board", state: "stopped" } });
    click('[aria-label="Dismiss"]');
    await tick(250);
    assert.equal(card(), null);
  } finally {
    b.stop();
  }
});
