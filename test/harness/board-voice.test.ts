// The board's voice (board/src/voice.ts) against a fake ElevenLabs SDK and a fake box: the chat it
// continues, the board's contextual update and picture (deduped by the image path), the update after
// a stroke, the holds while the agent speaks, a mic that is refused, and the mic button pressing
// through the chrome's rule (chrome.ts) into start and end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceController, boardContextText, recentChats, type BoardSource, type SessionOpts, type VoiceApi, type VoiceConv } from "../../board/src/voice.ts";
import { ChromeTaps, routeChrome } from "../../board/src/chrome.ts";
import type { Item } from "../../src/boardFormat.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeBox(over: Partial<VoiceApi> = {}) {
  const calls = { session: [] as (string | null)[], lines: [] as { role: string; text: string; ended?: boolean; fromConvId: string | null }[], tools: [] as string[] };
  const api: VoiceApi = {
    listChats: async () => [
      { id: "m1", title: "A mission", lastActivityAt: 900, source: "mission" },
      { id: "c-old", title: "Older chat", lastActivityAt: 100, source: "manual" },
      { id: "c-new", title: "Cauchy sequences", lastActivityAt: 500, source: "phone" },
    ],
    voiceSession: async (id) => {
      calls.session.push(id);
      return { signedUrl: "wss://fake", systemPrompt: "prompt", toolNames: ["Read", "AskAgent"] };
    },
    voiceTool: async (b) => {
      calls.tools.push(b.name);
      return { result: "ok" };
    },
    voiceTranscript: async (b) => {
      calls.lines.push({ role: b.role, text: b.text, ended: b.ended, fromConvId: b.fromConvId });
      return { convId: "voice-1" };
    },
    ...over,
  };
  return { api, calls };
}

function fakeSdk() {
  const log = { updates: [] as { text: string; contextId?: string }[], uploads: 0, files: [] as (string | undefined)[], ended: 0, muted: false };
  let opts: SessionOpts | null = null;
  const conv: VoiceConv = {
    endSession: async () => {
      log.ended++;
      opts?.onDisconnect();
    },
    setMicMuted: (m) => (log.muted = m),
    sendContextualUpdate: (text, o) => log.updates.push({ text, contextId: o?.contextId }),
    uploadFile: async () => ({ fileId: `f${++log.uploads}` }),
    sendMultimodalMessage: (m) => log.files.push(m.text),
  };
  const sdk = {
    Conversation: {
      startSession: async (o: SessionOpts) => {
        opts = o;
        // The real SDK connects, then resolves.
        o.onConnect();
        return conv;
      },
    },
  };
  return { sdk, log, opts: () => opts! };
}

function fakeBoard() {
  const items: Item[] = [
    { id: "i1", kind: "math", x: 0, y: 0, w: 300, h: 100, src: "assets/a.html", label: "Problem 3", inbox: { id: "e1", part: 2 } },
    { id: "i2", kind: "pdf", x: 0, y: 200, w: 600, h: 800, src: "assets/l.pdf", page: 4, inbox: { id: "e2", part: 0 } },
    { id: "i3", kind: "image", x: 700, y: 0, w: 200, h: 200, src: "assets/p.png" },
  ];
  let strokes = 2;
  let pic = "picture-1";
  const b: BoardSource = {
    slug: "cauchy",
    name: () => "Cauchy",
    items: () => items,
    strokes: () => strokes,
    snapshot: async () => new Blob([pic], { type: "image/jpeg" }),
  };
  return { b, stroke: (newPic?: string) => ((strokes += 1), newPic && (pic = newPic)) };
}

const mic = async () => ({ getTracks: () => [] }) as unknown as MediaStream;

test("the context update names the board and the inbox parts on it, by their labels", () => {
  const { b } = fakeBoard();
  const t = boardContextText({ name: b.name(), items: b.items(), strokes: 2 });
  assert.match(t, /board "Cauchy"/);
  assert.match(t, /from the board inbox: "Problem 3" \(math\), a PDF page \(page 4\) \(pdf\)\./);
  assert.match(t, /1 picture he inserted himself/);
  assert.match(t, /2 strokes of his handwriting/);
  assert.match(t, /ask the agent to send it to the board inbox/);
  assert.equal(boardContextText({ name: "Empty", items: [], strokes: 0 }).includes("Nothing from the board inbox is on it. No handwriting yet."), true);
});

test("the chat it continues: the most recent of Carl's chats (the phone's list, missions left out)", () => {
  const rows = recentChats([
    { id: "a", title: "", lastActivityAt: 1, source: "manual" },
    { id: "w", title: "", lastActivityAt: 9, source: "worker" },
    { id: "b", title: "", lastActivityAt: 5, source: "voice" },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["b", "a"]);
});

test("start → live with the board's context and picture; a stroke sends a new update after the debounce; an unchanged picture is not sent again; end", async () => {
  const box = fakeBox();
  const f = fakeSdk();
  const board = fakeBoard();
  const v = new VoiceController({ api: box.api, sdk: async () => f.sdk, mic, debounceMs: 30 });
  v.setBoard(board.b);
  await v.start();
  assert.equal(v.state.phase, "live");
  assert.equal(v.state.chat?.id, "c-new");
  assert.deepEqual(box.calls.session, ["c-new"]);
  await wait(10);
  assert.equal(f.log.updates.length, 1);
  assert.equal(f.log.updates[0]!.contextId, "board");
  assert.match(f.log.updates[0]!.text, /"Problem 3"/);
  assert.equal(f.log.uploads, 1, "the picture of the view went once");
  assert.match(f.log.files[0] ?? "", /looking at his whiteboard "Cauchy"/);

  // A stroke: one update after the pen has been still for the debounce, not before.
  board.stroke();
  v.boardChanged(board.b);
  v.boardChanged(board.b);
  await wait(5);
  assert.equal(f.log.updates.length, 1);
  await wait(60);
  assert.equal(f.log.updates.length, 2);
  assert.match(f.log.updates[1]!.text, /3 strokes/);
  assert.equal(f.log.uploads, 1, "same picture: not uploaded again");

  board.stroke("picture-2");
  v.boardChanged(board.b);
  await wait(60);
  assert.equal(f.log.uploads, 2, "a changed picture goes");

  // Its tools run on the box, its lines are saved there, from the chat it continues.
  assert.equal(await f.opts().clientTools.AskAgent!({ task: "x" }), "ok");
  assert.deepEqual(box.calls.tools, ["AskAgent"]);
  f.opts().onMessage({ role: "user", message: "what's under problem 3?" });
  f.opts().onMessage({ role: "agent", message: "[curious] Your bound." });
  v.setMuted(true);
  assert.equal(f.log.muted, true);
  await v.end();
  await wait(10);
  assert.equal(v.state.phase, "idle");
  assert.equal(f.log.ended, 1);
  assert.deepEqual(
    box.calls.lines.map((l) => [l.role, l.text, l.ended ?? false, l.fromConvId]),
    [
      ["user", "what's under problem 3?", false, "c-new"],
      ["assistant", "Your bound.", false, "c-new"],
      ["assistant", "Voice session ended.", true, "c-new"],
    ],
  );
  // Ended: a later stroke sends nothing.
  const before = [f.log.updates.length, f.log.uploads];
  board.stroke("picture-3");
  v.boardChanged(board.b);
  await wait(60);
  assert.deepEqual([f.log.updates.length, f.log.uploads], before);
});

test("pushes wait while the agent speaks, then go", async () => {
  const f = fakeSdk();
  const board = fakeBoard();
  const v = new VoiceController({ api: fakeBox().api, sdk: async () => f.sdk, mic, debounceMs: 10 });
  v.setBoard(board.b);
  await v.start();
  await wait(10);
  const n = f.log.updates.length;
  f.opts().onModeChange({ mode: "speaking" });
  board.stroke("picture-x");
  v.boardChanged(board.b);
  await wait(40);
  assert.equal(f.log.updates.length, n, "held while it speaks");
  f.opts().onModeChange({ mode: "listening" });
  await wait(800);
  assert.equal(f.log.updates.length, n + 1);
  await v.end();
});

test("a refused mic: the red state with one plain line, no session minted", async () => {
  const box = fakeBox();
  const v = new VoiceController({
    api: box.api,
    sdk: async () => fakeSdk().sdk,
    mic: async () => {
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    },
  });
  await v.start();
  assert.equal(v.state.phase, "error");
  assert.match(v.state.error, /^Microphone access is off\./);
  assert.deepEqual(box.calls.session, []);
  v.dismiss();
  assert.equal(v.state.phase, "idle");
  // Not HTTPS: no getUserMedia at all.
  const w = new VoiceController({ api: box.api, sdk: async () => fakeSdk().sdk, mic: null });
  await w.start();
  assert.match(w.state.error, /isn't on HTTPS/);
});

test("the box refuses the session: red, with the box's reason", async () => {
  const err = Object.assign(new Error("voice is not ready on the box (no ElevenLabs key — the laptop's Settings sends it)"), { status: 503 });
  const v = new VoiceController({ api: fakeBox({ voiceSession: async () => Promise.reject(err) }).api, sdk: async () => fakeSdk().sdk, mic });
  await v.start();
  assert.equal(v.state.phase, "error");
  assert.match(v.state.error, /no ElevenLabs key/);
});

test("switching chats restarts the session on the picked one", async () => {
  const box = fakeBox();
  const f = fakeSdk();
  const v = new VoiceController({ api: box.api, sdk: async () => f.sdk, mic });
  await v.start();
  await v.switchChat("c-old");
  assert.equal(v.state.phase, "live");
  assert.equal(v.state.chat?.id, "c-old");
  assert.deepEqual(box.calls.session, ["c-new", "c-old"]);
  await v.end();
});

test("the mic button, pressed by a Pencil or a finger through the chrome's rule, starts voice once and ends it once", async () => {
  const f = fakeSdk();
  const v = new VoiceController({ api: fakeBox().api, sdk: async () => f.sdk, mic });
  const btn = { name: "voice" };
  // view.ts: a press clicks the button; its click handler calls voice.toggle().
  const taps = new ChromeTaps<typeof btn>(() => v.toggle());
  let t = 0;
  const tap = (kind: "pen" | "touch", id: number, click: boolean) => {
    routeChrome(taps, { type: "down", id, x: 10, y: 10, t: (t += 8) }, false, () => btn);
    routeChrome(taps, { type: "up", id, x: 11, y: 11, t: (t += 8) }, false, () => btn);
    // iOS's synthesised click, dropped by the dedupe: never a second toggle.
    if (click && taps.click((t += 4))) v.toggle();
  };
  tap("pen", 2, true);
  await wait(10);
  assert.equal(v.state.phase, "live");
  tap("touch", 7, true);
  await wait(10);
  assert.equal(v.state.phase, "idle");
  assert.equal(f.log.ended, 1);
});
