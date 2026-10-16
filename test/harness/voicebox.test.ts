// Voice in box mode: the laptop's voice agent sends its vault tools to the box
// (POST /api/v1/voice/tool, paths made vault-relative), keeps ScrollTo — which
// moves the user's own screen — local, and reaches the box's agent through
// AskAgent. Off a box, every tool runs here and AskAgent says there is no box.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-voicebox-");
const fake = installFakeTauri(vault);

const posts: { path: string; body: any }[] = [];
let boxUrl = "";
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    posts.push({ path: req.url ?? "", body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: `box ran ${body.name}` }));
  });
});

// Only `vault` is box-connected.
fake.setHandler("vault_box_config", ({ vault: v }) => (v === vault ? { box: boxUrl, vault: "v" } : null));
fake.setHandler("box_post_json", async ({ url, body }) => {
  const r = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json" } });
  return { status: r.status, body: await r.text() };
});

const { useStore } = await import("../../src/store.ts");
const voice = await import("../../src/voice-elevenlabs.ts");
const { boxVoiceTool, relativeArgs } = await import("../../src/voiceBox.ts");

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  boxUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  useStore.setState({ vaultPath: vault, currentFile: null } as any);
});
after(() => new Promise<void>((r) => server.close(() => r())));

test("box mode: vault tools go to the box with vault-relative paths", async () => {
  const remote = await boxVoiceTool(vault);
  assert.ok(remote, "a box-connected vault yields a remote runner");
  const h = voice.buildClientToolHandlers(remote!);
  posts.length = 0;
  assert.equal(await h.Read({ path: `${vault}/notes/a.md` }), "box ran Read");
  assert.equal(await h.Write({ path: `${vault}/notes/b.md`, contents: "x" }), "box ran Write");
  assert.equal(await h.Bash({ command: "ls" }), "box ran Bash");
  assert.equal(await h.AskAgent({ task: "summarise the week" }), "box ran AskAgent");
  assert.deepEqual(
    posts.map((p) => [p.path, p.body.name, p.body.args.path ?? p.body.args.command ?? p.body.args.task]),
    [
      ["/api/v1/voice/tool?vault=v", "Read", "notes/a.md"],
      ["/api/v1/voice/tool?vault=v", "Write", "notes/b.md"],
      ["/api/v1/voice/tool?vault=v", "Bash", "ls"],
      ["/api/v1/voice/tool?vault=v", "AskAgent", "summarise the week"],
    ],
  );
  // Nothing was written on the laptop: the write is the box's.
  assert.equal(fake.calls.some((c) => c.cmd === "write_text_file"), false);
});

test("box mode: ScrollTo stays local (it moves this screen)", async () => {
  const h = voice.buildClientToolHandlers((await boxVoiceTool(vault))!);
  posts.length = 0;
  assert.equal(await h.ScrollTo({ page: 2 }), "Error: no file is currently open.");
  assert.equal(posts.length, 0);
});

test("off a box: tools run here and AskAgent says there is no box", async () => {
  const local = makeTempVault("vc-voicelocal-");
  assert.equal(await boxVoiceTool(local), null);
  useStore.setState({ vaultPath: local } as any);
  const h = voice.buildClientToolHandlers();
  posts.length = 0;
  fake.setHandler("read_text_file", () => "local text");
  assert.equal(await h.Read({ path: `${local}/notes/a.md` }), "local text");
  assert.match(await h.AskAgent({ task: "x" }), /isn't connected to a box/);
  assert.equal(posts.length, 0);
  useStore.setState({ vaultPath: vault } as any);
});

test("relativeArgs: only paths under the vault change", () => {
  assert.deepEqual(relativeArgs({ path: `${vault}/a/b.md`, cwd: vault, x: 1 }, vault), { path: "a/b.md", cwd: ".", x: 1 });
  assert.deepEqual(relativeArgs({ path: "/etc/passwd" }, vault), { path: "/etc/passwd" });
  assert.deepEqual(relativeArgs({ path: "C:\\V\\notes\\a.md" }, "C:/v"), { path: "notes/a.md" });
});

test("box mode: the box's own vault tools (named by its session) are forwarded too", async () => {
  const h = voice.buildClientToolHandlers((await boxVoiceTool(vault))!, ["EchoKey"]);
  posts.length = 0;
  assert.equal(await h.EchoKey({ word: "hi" }), "box ran EchoKey");
  assert.equal(posts[0]?.path, "/api/v1/voice/tool?vault=v", "the box's name for the vault rides along");
});

test("the session is the box's; unreachable and no-voice-for-this-vault are told apart", async () => {
  const { boxVoice, boxVoiceSession } = await import("../../src/voiceBox.ts");
  const b = (await boxVoice(vault))!;
  const seen: string[] = [];
  localStorage.removeItem("vault_chat_elevenlabs_llm");
  localStorage.removeItem("vault_chat_elevenlabs_voice");
  const ok = await boxVoiceSession(b, "c1", async (_l, path) => {
    seen.push(path);
    return { signedUrl: "wss://fake/x", systemPrompt: "box prompt", toolNames: ["Read", "EchoKey"], vaultRoot: "/home/carl/vaults/v" };
  });
  assert.equal(ok.session?.signedUrl, "wss://fake/x");
  assert.deepEqual(seen, ["/api/v1/voice/session?convId=c1"]);
  assert.equal(b.link.vault, "v", "(boxGet adds ?vault= from the link)");
  // Settings' voice model and voice ride along: the box's agent uses them.
  localStorage.setItem("vault_chat_elevenlabs_llm", "claude-sonnet-4-6");
  localStorage.setItem("vault_chat_elevenlabs_voice", "JBFqnCBsd6RMkjVDRZzb");
  const chosen: string[] = [];
  await boxVoiceSession(b, "c1", async (_l, path) => {
    chosen.push(path);
    return { signedUrl: "wss://fake/y", systemPrompt: "p", toolNames: [] };
  });
  assert.deepEqual(chosen, ["/api/v1/voice/session?convId=c1&llm=claude-sonnet-4-6&voice=JBFqnCBsd6RMkjVDRZzb"]);
  localStorage.removeItem("vault_chat_elevenlabs_llm");
  localStorage.removeItem("vault_chat_elevenlabs_voice");
  const down = await boxVoiceSession(b, null, async () => {
    throw "error sending request: connection refused";
  });
  assert.equal(down.unreachable, true);
  const other = await boxVoiceSession(b, null, async () => {
    throw Object.assign(new Error('HTTP 404: {"error":"no vault v on this box"}'), { status: 404 });
  });
  assert.equal(other.unsupported, true);
  const noKey = await boxVoiceSession(b, null, async () => {
    throw Object.assign(new Error("HTTP 503: no ElevenLabs key"), { status: 503 });
  });
  assert.ok(noKey.error && !noKey.unreachable && !noKey.unsupported);
});

test("the transcript is saved on the box in order, and the local thread moves to the box's id", async () => {
  const { boxVoice, voiceTranscriptMirror } = await import("../../src/voiceBox.ts");
  const b = (await boxVoice(vault))!;
  const localId = useStore.getState().newConversation();
  const sent: any[] = [];
  const post = async (_l: any, path: string, body: any) => {
    sent.push({ path, ...body });
    await new Promise((r) => setTimeout(r, body.role === "user" ? 30 : 0)); // the first answers slowest
    return { ok: true, data: { ok: true, convId: "box-voice-1" } };
  };
  const m = voiceTranscriptMirror(b, localId, "p-seed44", post);
  m.push({ role: "user", content: "what's the budget?" });
  m.push({ role: "assistant", content: "Read writeup.md · on the box", system: true });
  m.push({ role: "assistant", content: "3.2B tokens." });
  await m.done();
  assert.deepEqual(
    sent.map((x) => [x.path, x.convId, x.role, x.text, !!x.system, x.fromConvId ?? null]),
    [
      ["/api/v1/voice/transcript", localId, "user", "what's the budget?", false, "p-seed44"],
      ["/api/v1/voice/transcript", "box-voice-1", "assistant", "Read writeup.md · on the box", true, "p-seed44"],
      ["/api/v1/voice/transcript", "box-voice-1", "assistant", "3.2B tokens.", false, "p-seed44"],
    ],
  );
  assert.equal(useStore.getState().activeConversationId, "box-voice-1");
  assert.ok(!useStore.getState().conversations.some((c) => c.id === localId));
});
