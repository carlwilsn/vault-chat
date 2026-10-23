// The board's voice (board/src/voice.ts) against a fake ElevenLabs SDK and a fake box: the chat it
// is attached to (its lines go into it), the board's contextual update and picture (deduped by the
// image path), the update after a stroke, the holds while the agent speaks, the box's updates in the
// live call (an answer spoken, context never), the conversation's images at the start, a mic that is
// refused, and the mic button pressing through the chrome's rule (chrome.ts) into start and end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LOOK_THEN_ANSWER, VoiceController, boardContextText, recentChats, type BoardSource, type SessionOpts, type VoiceApi, type VoiceClose, type VoiceConv } from "../../board/src/voice.ts";
import { ChromeTaps, routeChrome } from "../../board/src/chrome.ts";
import type { Item } from "../../src/boardFormat.ts";
import { VOICE_SILENCE_RULE } from "../../src/voicePrompt.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeBox(over: Partial<VoiceApi> = {}) {
  const calls = { session: [] as (string | null)[], lines: [] as { role: string; text: string; ended?: boolean; convId: string | null }[], tools: [] as { name: string; convId: string | null }[] };
  const api: VoiceApi = {
    listChats: async () => [
      { id: "m1", title: "A mission", lastActivityAt: 900, source: "mission" },
      { id: "c-old", title: "Older chat", lastActivityAt: 100, source: "manual" },
      { id: "c-new", title: "Cauchy sequences", lastActivityAt: 500, source: "phone" },
    ],
    voiceSession: async (id) => {
      calls.session.push(id);
      return { signedUrl: "wss://fake", systemPrompt: "prompt", toolNames: ["Ask", "LookAtScreen"], convId: id };
    },
    voiceTool: async (b) => {
      calls.tools.push({ name: b.name, convId: b.convId });
      return { result: "ok" };
    },
    voiceTranscript: async (b) => {
      calls.lines.push({ role: b.role, text: b.text, ended: b.ended, convId: b.convId });
      return { convId: b.convId ?? "voice-1" };
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
    getId: () => "conv_el_1",
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
  assert.match(t, /Ask the agent to send it to his board inbox/);
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

  // Its one tool that acts (Ask) runs on the box in the chat it is attached to; its lines go into that chat.
  assert.equal(await f.opts().clientTools.Ask!({ request: "x" }), "ok");
  assert.deepEqual(box.calls.tools, [{ name: "Ask", convId: "c-new" }]);
  assert.deepEqual(Object.keys(f.opts().clientTools).sort(), ["Ask", "LookAtScreen"]);
  f.opts().onMessage({ role: "user", message: "what's under problem 3?" });
  f.opts().onMessage({ role: "agent", message: "[curious] Your bound." });
  v.setMuted(true);
  assert.equal(f.log.muted, true);
  await v.end();
  await wait(10);
  assert.equal(v.state.phase, "idle");
  assert.equal(f.log.ended, 1);
  assert.deepEqual(
    box.calls.lines.map((l) => [l.role, l.text, l.ended ?? false, l.convId]),
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

test("WebRTC with the box's conversation token; WebSocket once if it can't connect; the tap's mic stream is let go; the close is kept with its reason", async () => {
  const stopped: string[] = [];
  const heldMic = async () => ({ getTracks: () => [{ stop: () => stopped.push("tap stream") }] }) as unknown as MediaStream;
  const box = fakeBox({ voiceSession: async () => ({ conversationToken: "tok", signedUrl: "wss://fake", systemPrompt: "p", toolNames: [] }) });
  const seen: SessionOpts[] = [];
  let failFirst = true;
  const conv: VoiceConv = {
    endSession: async () => seen.at(-1)?.onDisconnect({ reason: "user" }),
    setMicMuted: () => {},
    sendContextualUpdate: () => {},
    uploadFile: async () => ({ fileId: "f" }),
    sendMultimodalMessage: () => {},
    getInputVolume: () => 0.2,
  };
  const sdk = {
    Conversation: {
      startSession: async (o: SessionOpts) => {
        seen.push(o);
        if (failFirst) {
          failFirst = false;
          throw new Error("could not establish pc connection");
        }
        o.onConnect();
        return conv;
      },
    },
  };
  const v = new VoiceController({ api: box.api, sdk: async () => sdk, mic: heldMic });
  await v.start();
  assert.deepEqual(stopped, ["tap stream"], "the permission stream is stopped before the SDK opens its own");
  assert.equal(seen[0]!.connectionType, "webrtc");
  assert.equal(seen[0]!.conversationToken, "tok");
  assert.equal(seen[0]!.signedUrl, undefined);
  assert.equal(seen[1]!.connectionType, "websocket");
  assert.equal(seen[1]!.signedUrl, "wss://fake");
  assert.equal(v.state.phase, "live");
  assert.equal(v.transport, "websocket");
  assert.equal(v.inputLevel(), 0.5, "the waves read the SDK's own mic level");
  seen.at(-1)!.onDisconnect({ reason: "error", message: "ws closed", closeCode: 1006 });
  assert.deepEqual(v.lastClose, { transport: "websocket", reason: "error", message: "ws closed", code: 1006, closeReason: undefined });
});

/// Carl, 2026-10-18: on the board, voice went live → idle → connecting → live every 15–25 s, and each restart
// landed on a different conversation (each session's lines made a voice conversation of their own, the next
// "most recent chat"), so the agent lost what was said. Now the call's lines go into the chat it is attached
// to, so that chat stays the most recent: a drop, a mic restart and a reload all continue it.
test("one conversation across a drop, a mic restart and a reload: the attached chat, which its lines go into", async () => {
  const lines: { convId: string | null; text: string }[] = [];
  const active = new Map<string, number>([
    ["c-old", 100],
    ["c-new", 500],
  ]);
  const box = fakeBox({
    listChats: async () => [...active].map(([id, at]) => ({ id, title: id, lastActivityAt: at, source: "manual" })).sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    voiceTranscript: async (b) => {
      lines.push({ convId: b.convId, text: b.text });
      // The box: the line goes into that chat (its activity is now).
      if (b.convId && !b.ended) active.set(b.convId, Math.max(...active.values()) + 1);
      return { convId: b.convId };
    },
  });
  const stored = new Map<string, string>();
  const threadStore = { get: () => stored.get("t") ?? null, set: (id: string | null) => void (id ? stored.set("t", id) : stored.delete("t")) };
  const closes: VoiceClose[] = [];
  const f = fakeSdk();
  const v = new VoiceController({ api: box.api, sdk: async () => f.sdk, mic, threadStore, onClose: (c) => closes.push(c) });
  await v.start();
  assert.deepEqual(box.calls.session, ["c-new"], "the first start continues the most recent chat");
  f.opts().onMessage({ role: "user", message: "Can you see my board?" });
  await wait(10);
  assert.equal(lines.at(-1)!.convId, "c-new", "its lines go into that chat, never a conversation of their own");
  assert.equal(v.state.chat?.id, "c-new");

  // The connection drops: said, with the reason, and the mic goes on in the same chat.
  f.opts().onDisconnect({ reason: "error", message: "pc connection lost", closeCode: 1006 });
  await wait(10);
  assert.equal(v.state.phase, "error");
  assert.match(v.state.error, /Voice disconnected \(pc connection lost\)\. Tap the mic to go on with this chat\./);
  assert.deepEqual(closes.at(-1), { by: "remote", reason: "error", message: "pc connection lost", code: 1006, transport: "websocket", secs: closes.at(-1)!.secs, conv: "c-new" });
  await v.start();
  assert.deepEqual(box.calls.session, ["c-new", "c-new"]);
  // Ended with the mic and tapped again; then a reload: still that chat.
  await v.end("mic");
  await v.start();
  assert.equal(box.calls.session.at(-1), "c-new");
  await v.end("pill");
  const v2 = new VoiceController({ api: box.api, sdk: async () => f.sdk, mic, threadStore });
  await v2.start();
  assert.equal(box.calls.session.at(-1), "c-new");

  // Picking another chat: it holds across restarts while Carl is active nowhere else…
  await v2.switchChat("c-old");
  assert.equal(box.calls.session.at(-1), "c-old");
  await v2.end();
  await v2.start();
  assert.equal(box.calls.session.at(-1), "c-old");
  await v2.end();
  // …and when he goes on in another chat (the laptop), "continue that" on the board means that chat.
  active.set("c-new", Date.now() + 60_000);
  await v2.start();
  assert.equal(box.calls.session.at(-1), "c-new");
  await v2.end();
});

test("the box's updates in the live call: the agent's answer is spoken (a user message), context never; [vc:…] lines are not Carl's; the chat's images go at the start", async () => {
  const sent: string[] = [];
  const ctx: string[] = [];
  let polls = 0;
  const box = fakeBox({
    voiceSession: async (id) => ({
      signedUrl: "wss://fake",
      systemPrompt: "p",
      toolNames: ["Ask", "LookAtScreen"],
      convId: id,
      cursor: "1:1",
      images: [
        { mime: "image/png", dataBase64: Buffer.from("png-bytes").toString("base64") },
        { mime: "image/png", dataBase64: "" },
      ],
    }),
    voiceUpdates: async (_id, cursor) => {
      polls++;
      if (cursor === "1:1")
        return {
          cursor: "2:2",
          updates: [
            { id: "r1", kind: "result", speak: true, text: "[vc:result] The agent answered: saved." },
            { id: "c1", kind: "context", speak: false, text: "[vc:context] Carl typed in the chat." },
          ],
        };
      await wait(20);
      return { cursor: cursor ?? "", updates: [] };
    },
  });
  let opts: SessionOpts | null = null;
  const conv: VoiceConv = {
    endSession: async () => opts?.onDisconnect(),
    setMicMuted: () => {},
    sendContextualUpdate: (t) => ctx.push(t),
    sendUserMessage: (t) => sent.push(t),
    uploadFile: async () => ({ fileId: "img" }),
    sendMultimodalMessage: () => {},
  };
  const sdk = {
    Conversation: {
      startSession: async (o: SessionOpts) => {
        opts = o;
        o.onConnect();
        return conv;
      },
    },
  };
  const v = new VoiceController({ api: box.api, sdk: async () => sdk, mic });
  await v.start();
  // An answer waits until Carl's mic has been quiet a second (never over his words).
  await wait(1_300);
  assert.deepEqual(sent, ["[vc:result] The agent answered: saved."]);
  assert.deepEqual(
    ctx.filter((t) => t.startsWith("[vc:")),
    ["[vc:context] Carl typed in the chat."],
  );
  assert.ok(polls >= 2, "it keeps listening");
  assert.equal(v.sent.images, 1, "the real image went; the empty one never");
  // The SDK echoes our user message back as a user line: never saved as Carl's; a control tag never reaches the chat.
  opts!.onMessage({ role: "user", message: "[vc:result] The agent answered: saved." });
  opts!.onMessage({ role: "agent", message: "Saved it. [skip_turn]" });
  await wait(10);
  assert.deepEqual(
    box.calls.lines.map((l) => [l.role, l.text]),
    [["assistant", "Saved it."]],
  );
  await v.end();
});

// One voice at a time (server/voice.ts): voice started on another device ends this call at once.
test("voice moved to another device: the call ends at once, no end line, the pill says where it went; lines and tools carried this call's id", async () => {
  let moved = false;
  const box = fakeBox({
    voiceSession: async (id) => ({ signedUrl: "wss://fake", systemPrompt: "p", toolNames: ["Ask"], convId: id, cursor: "1:1", sessionId: "vs-board-1" }),
    voiceUpdates: async (_id, cursor, session) => {
      assert.equal(session, "vs-board-1", "the poll carries the call's id");
      await wait(10);
      return moved ? { cursor: cursor ?? "", updates: [], moved: { to: "laptop", line: "Voice moved to laptop" } } : { cursor: cursor ?? "", updates: [] };
    },
  });
  const ids: (string | undefined)[] = [];
  const realT = box.api.voiceTranscript;
  box.api.voiceTranscript = async (b) => (ids.push(b.sessionId), realT(b));
  const f = fakeSdk();
  const closes: VoiceClose[] = [];
  const v = new VoiceController({ api: box.api, sdk: async () => f.sdk, mic, onClose: (c) => closes.push(c) });
  await v.start();
  f.opts().onMessage({ role: "user", message: "what's the next line" });
  await wait(20);
  assert.deepEqual(ids, ["vs-board-1"]);
  moved = true;
  await wait(60);
  assert.equal(f.log.ended, 1, "the SDK's session ended");
  assert.equal(v.state.phase, "error");
  assert.equal(v.state.error, "Voice moved to laptop.");
  assert.equal(closes.at(-1)?.by, "moved");
  assert.ok(!box.calls.lines.some((l) => l.ended), "no end line: the box said it in the thread");
});

test("mute is the SDK's own and instant; a result still reaches the call while muted", async () => {
  const sent: string[] = [];
  let polls = 0;
  const box = fakeBox({
    voiceSession: async (id) => ({ signedUrl: "wss://fake", systemPrompt: "p", toolNames: ["Ask"], convId: id, cursor: "1:1", sessionId: "vs-2" }),
    voiceUpdates: async (_id, cursor) => {
      polls++;
      await wait(15);
      return polls === 2 ? { cursor: "2:2", updates: [{ id: "r1", kind: "result", speak: true, text: "[vc:result] The agent answered: 91." }] } : { cursor: cursor ?? "", updates: [] };
    },
  });
  const f = fakeSdk();
  const conv = await (async () => {
    const v = new VoiceController({ api: box.api, sdk: async () => ({ Conversation: { startSession: async (o: SessionOpts) => {
      const c = await f.sdk.Conversation.startSession(o);
      (c as VoiceConv).sendUserMessage = (t: string) => sent.push(t);
      // A loud room: the meter says someone talks, but he is muted, so nothing waits on it.
      (c as VoiceConv).getInputVolume = () => 0.5;
      return c;
    } } }), mic });
    await v.start();
    return v;
  })();
  conv.setMuted(true);
  assert.equal(f.log.muted, true, "the SDK's mute: no audio is sent");
  assert.equal(conv.state.muted, true);
  await wait(1_400);
  assert.deepEqual(sent, ["[vc:result] The agent answered: 91."], "the voice still speaks a result while he is muted");
  conv.setMuted(false);
  assert.equal(f.log.muted, false, "unmuted at once");
  await conv.end();
});

// 2026-10-22, the iPad: Carl said "Hello?", "Interesting.", "Hello?" on the board and the voice never answered — the
// box saw only his lines (and a board.look right at each "Hello?": the voice looked, then said nothing) and no line
// said what the agent did with them. Now: the look ends by telling the voice to answer, and every line of his is a
// "voice turn" line saying whether it was answered, what ran (skip_turn too) and the ElevenLabs conversation id.
test("a line of Carl's: the look tells the voice to answer; each turn is logged with whether it was answered, its tools and skip_turn", async () => {
  const box = fakeBox();
  const f = fakeSdk();
  const board = fakeBoard();
  const logs: Record<string, unknown>[] = [];
  const v = new VoiceController({ api: box.api, sdk: async () => f.sdk, mic, debounceMs: 30, turnWaitMs: 60, log: (ev, d) => logs.push({ ev, ...d }) });
  v.setBoard(board.b);
  await v.start();
  await wait(10);
  assert.equal(f.log.uploads, 1, "the start's picture");
  const connected = logs.find((l) => l.ev === "voice connected");
  assert.equal(connected?.el, "conv_el_1", "ElevenLabs' conversation id, to find its history");
  const o = f.opts();

  // "Hello?" → the voice looks (the view is the one it already has) → ElevenLabs reports skip_turn → nothing said.
  o.onMessage({ role: "user", message: "Hello?" });
  const look = await o.clientTools.LookAtScreen!({});
  assert.match(look, /already have/);
  assert.ok(look.endsWith(LOOK_THEN_ANSWER), "a look always ends by telling the voice to answer him");
  assert.doesNotMatch(look, /Nothing in view has changed|Don't describe the board/, "nothing in it reads as 'nothing new: stay silent'");
  o.onAgentToolResponse?.({ tool_name: "LookAtScreen", tool_type: "client" });
  o.onAgentToolResponse?.({ tool_name: "skip_turn", tool_type: "system" });
  const tool = logs.find((l) => l.ev === "voice tool");
  assert.deepEqual({ name: tool?.name, look: tool?.look, error: tool?.error, turn: tool?.turn }, { name: "LookAtScreen", look: "duplicate", error: false, turn: 1 });
  await wait(100);
  const unanswered = logs.filter((l) => l.ev === "voice turn");
  assert.equal(unanswered.length, 1, "logged once the wait for a reply ran out");
  assert.deepEqual(
    { turn: unanswered[0]!.turn, replied: unanswered[0]!.replied, end: unanswered[0]!.end, tools: unanswered[0]!.tools, agentTools: unanswered[0]!.agentTools, skipped: unanswered[0]!.skipped, audio: unanswered[0]!.audio, el: unanswered[0]!.el },
    { turn: 1, replied: false, end: "timeout", tools: ["LookAtScreen"], agentTools: ["skip_turn"], skipped: true, audio: false, el: "conv_el_1" },
  );

  // "Interesting." then "Hello?" at once: the first is logged unanswered when the next line comes.
  o.onMessage({ role: "user", message: "Interesting." });
  o.onMessage({ role: "user", message: "Hello?" });
  // Answered: the voice speaks, then its line.
  o.onModeChange({ mode: "speaking" });
  o.onMessage({ role: "agent", message: "Hi, I'm here." });
  const turns = logs.filter((l) => l.ev === "voice turn");
  assert.deepEqual(turns.map((t) => [t.turn, t.replied, t.end]), [[1, false, "timeout"], [2, false, "next-line"], [3, true, "reply"]]);
  assert.equal(turns[2]!.audio, true);
  assert.equal(typeof turns[2]!.replyMs, "number");
  await wait(100);
  assert.equal(logs.filter((l) => l.ev === "voice turn").length, 3, "an answered turn is logged once");

  // A line still waiting when the call ends is logged then.
  o.onMessage({ role: "user", message: "Can you see this?" });
  await v.end();
  const last = logs.filter((l) => l.ev === "voice turn").at(-1)!;
  assert.deepEqual([last.turn, last.replied, last.end], [4, false, "call-end"]);
});

test("the prompt: a look is part of the answer to his line, never the end of it", () => {
  assert.match(VOICE_SILENCE_RULE, /A look you took for his line \(at his screen or his board\) is part of your answer to it, never the end: when the look comes back, answer him out loud/);
});
