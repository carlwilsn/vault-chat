// The gate's UI runner, end to end over the real channel: the box (server/gate.ts) puts a signal on a fake box's REAL feed; the laptop's box chat (src/boxChat.ts) hands it to
// src/driveOnLaptop.ts, which checks Carl's activity (src/userActivity.ts), opens the Drive copy of the app
// (src/driveHost.ts) and acks over POST /api/v1/show/<id>/ack. The Drive copy itself needs a webview: here a fake host
// stands in for it, speaking the real protocol (src/driveProtocol.ts). The DOM step runner is checked in Chromium
// against the preview harness (see the change's notes); its pure parts are checked here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-drive-");
const fake = installFakeTauri(vault);
const box = new FakeBox();
box.showVault = vault;

async function fetchVia(url: string, init: RequestInit, timeoutMs: number) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    throw String((e as Error)?.message ?? e);
  }
}
fake.setHandler("vault_box_config", () => ({ box: box.url, vault: "v" }));
fake.setHandler("box_get_json", ({ url, timeoutMs }) => fetchVia(url, { method: "GET" }, timeoutMs ?? 20000));
fake.setHandler("box_post_json", ({ url, body }) => fetchVia(url, { method: "POST", body, headers: { "content-type": "application/json" } }, 20000));
fake.setHandler("path_exists", ({ path }) => fs.existsSync(path));
fake.setHandler("conversations_write_all", () => null);

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const { resetPresence } = await import("../../server/show.ts");
const { setDriveHostFactory } = await import("../../src/driveHost.ts");
const { _resetUserActivity } = await import("../../src/userActivity.ts");
const { checkSteps, parseKey } = await import("../../src/driveSteps.ts");
const { driveCommandRefusal, memoryStorage } = await import("../../src/driveGuard.ts");
const { isDriveWindow } = await import("../../src/windowKind.ts");
const S = () => useStore.getState();

async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A Drive copy that speaks the protocol: `answer` decides each run's reply (it may wait for an abort). */
type Req = { kind: string; reqId: string; mode?: string; steps?: unknown[]; reason?: string };
let opened = 0;
let closed = 0;
let readyFail: string | null = null;
let answer: (req: Req, aborted: Promise<string>) => Promise<Record<string, unknown>> = async () => ({});
const tried: (Record<string, string> | null)[] = [];
const fakeFactory = async (tries?: Record<string, string> | null) => {
  opened++;
  tried.push(tries ?? null);
  const fns = new Set<(m: any) => void>();
  const aborts = new Map<string, (why: string) => void>();
  const reply = (m: any) => setTimeout(() => fns.forEach((f) => f(m)), 5);
  return {
    where: "a fake Drive copy",
    ready: Promise.resolve(readyFail ? { kind: "ready", ok: false, error: readyFail, readyMs: 0 } : { kind: "ready", ok: true, readyMs: 1234 }),
    send(m: Req) {
      if (m.kind === "abort") return aborts.get(m.reqId)?.(m.reason ?? "aborted");
      const aborted = new Promise<string>((r) => aborts.set(m.reqId, r));
      void answer(m, aborted).then((body) => reply({ kind: "result", reqId: m.reqId, ...body }));
    },
    onReply: (fn: (m: any) => void) => (fns.add(fn), () => void fns.delete(fn)),
    close: () => void closed++,
  } as any;
};
setDriveHostFactory(fakeFactory);

const sent: Record<string, unknown>[] = [];
const emit = (ev: Record<string, unknown>) => (sent.push(ev), void box.emit(null, { type: "signal", signal: ev } as any));
const stepsOk = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
  steps: { ok: true, steps: steps.map((s, i) => ({ i: i + 1, action: Object.keys(s as object)[0], ok: true, ms: 3 })), errors: [], text: "Main\nAsk anything", shots: [], ms: 40, ...extra },
});

before(async () => {
  resetPresence();
  _resetUserActivity();
  await box.start();
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("the laptop polls the feed as client=laptop", () => box.seen.some((x) => x.route === "GET /poll"));
});
after(async () => {
  setDriveHostFactory(null);
  bc.stopBoxChat();
  await box.close();
});

test("the gate's UI runner on the real app: a draft is run in a fresh Drive copy started with it (echoed), never the warm one; bad tries are refused", async () => {
  _resetUserActivity();
  const { gateDriveRoute } = await import("../../server/gate.ts");
  const { cleanDriveTries } = await import("../../src/driveGuard.ts");
  assert.deepEqual(cleanDriveTries({ "app/notes": "0123abcd", "box/x": "0123abcd", "app/chat": "nothex!!", ".vault-chat/plugins/pen.js": "89abcdef" }), { "app/notes": "0123abcd", ".vault-chat/plugins/pen.js": "89abcdef" });
  assert.equal(cleanDriveTries({ "app/chat": "zz" }), null);
  answer = async (req) => stepsOk(req.steps ?? []);
  const live = await gateDriveRoute(vault, { steps: [{ wait: 10 }], idleMs: 0 }, emit);
  assert.equal(live.status, 200);
  assert.equal((live.body as any).tries, null, "the copy in effect");
  assert.equal(tried.at(-1), null);
  const n = opened;
  const draft = await gateDriveRoute(vault, { steps: [{ waitFor: '[data-vc-copy="draft"]', timeout: 50 }], tries: { "app/notes": "0123abcd" }, idleMs: 0 }, emit);
  assert.deepEqual((draft.body as any).tries, { "app/notes": "0123abcd" }, "the laptop says it ran the draft");
  assert.equal((draft.body as any).steps.ok, true);
  assert.equal(opened, n + 1, "a fresh copy, started with the tries");
  assert.deepEqual(tried.at(-1), { "app/notes": "0123abcd" });
  assert.equal((await gateDriveRoute(vault, { steps: [], tries: { "box/x": "0123abcd" } }, emit)).status, 400);
  // Carl at the laptop: the gate does not run there (the harness judges instead).
  const { noteInput } = await import("../../src/userActivity.ts");
  noteInput("keydown");
  assert.match(String(((await gateDriveRoute(vault, { steps: [{ wait: 10 }] }, emit)).body as any).unavailable), /Carl is using the laptop/);
  _resetUserActivity();
});

test("steps and keys are checked; the Drive guard allows reads only; storage is a copy", () => {
  assert.deepEqual(parseKey("Control+Shift+F"), { key: "F", code: "KeyF", keyCode: 70, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false });
  assert.equal(parseKey("Enter")!.key, "Enter");
  assert.equal(parseKey("Ctrl+k")!.key, "k");
  assert.equal(parseKey("Hyper+K"), null);
  assert.equal(parseKey("Banana"), null);
  assert.match(String(checkSteps([{ shot: "a" }, { shot: "b" }, { shot: "c" }, { shot: "d" }, { shot: "e" }])), /at most 4 shots/);
  assert.match(String(checkSteps([{ wait: 99999 }])), /wait is/);
  assert.match(String(checkSteps([{ press: "Hyper+Q" }])), /press needs a key/);
  assert.ok(Array.isArray(checkSteps([{ click: { text: "Save" } }, { type: "x" }, { waitFor: "#a", timeout: 100 }, { scroll: 300 }])));
  // Mod is the platform's mod key: Ctrl here (not a Mac), Cmd on a Mac (src/shortcuts.ts isMod).
  assert.deepEqual(parseKey("Mod+Shift+F"), { key: "F", code: "KeyF", keyCode: 70, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false });
  assert.equal(parseKey("Meta+k")!.metaKey, true);
  // A drag, a right click and a selection, checked like the rest.
  assert.ok(Array.isArray(checkSteps([{ drag: "[data-tree-path$='/a.md']", to: "[data-el=markdown-area]", at: { x: 0.95, y: 0.5 } }, { rightClick: { text: "a" } }, { select: ".prose", text: "fox" }])));
  assert.match(String(checkSteps([{ drag: "#a" }])), /drag needs to/);
  assert.match(String(checkSteps([{ drag: "#a", to: "#b", start: { x: 2, y: 0 } }])), /fractions/);
  assert.match(String(checkSteps([{ select: "#a", text: " " }])), /select's text/);
  assert.match(String(checkSteps([{ rightClick: "" }])), /rightClick needs/);

  assert.equal(isDriveWindow, false, "a test (or Carl's window) is not the Drive window");
  assert.equal(driveCommandRefusal("write_text_file"), null, "Carl's windows are never refused");
  for (const cmd of ["read_text_file", "box_get_json", "list_dir", "plugin:event|listen", "plugin:event|emit_to", "plugin:app|version"]) assert.equal(driveCommandRefusal(cmd, true), null, cmd);
  for (const cmd of ["write_text_file", "box_post_json", "git_commit_all", "vault_box_sync", "app_ready", "local_server_start", "keychain_set", "plugin:updater|check", "plugin:process|restart", "plugin:window|set_focus", "plugin:event|emit", "plugin:opener|open_url"]) assert.match(String(driveCommandRefusal(cmd, true)), /read-only/, cmd);

  const real = memoryStorage();
  real.setItem("vault", "/v");
  const copy = memoryStorage(real);
  copy.setItem("vault", "/elsewhere");
  copy.setItem("new", "1");
  assert.equal(real.getItem("vault"), "/v");
  assert.equal(real.getItem("new"), null);
  assert.equal(copy.getItem("vault"), "/elsewhere");
});
