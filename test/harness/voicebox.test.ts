// Voice in box mode: the laptop's voice is the front of house of the open chat
// (D3): its one tool that acts, Ask, goes to the box (POST /api/v1/voice/tool,
// in the attached conversation, after the lines before it); the tools that read
// or move this screen stay local; its lines go into that chat on the box, under
// its own id; its updates come from the box. Off a box, voice does not start.
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
    if ((req.url ?? "").startsWith("/conversation/project")) {
      res.end(JSON.stringify({ ok: true, project: body.project ? String(body.project).toLowerCase().replace(/[^a-z0-9]+/g, "-") : null }));
      return;
    }
    res.end(JSON.stringify({ result: `box ran ${body.name}` }));
  });
});

// Only `vault` is box-connected.
fake.setHandler("vault_box_config", ({ vault: v }) => (v === vault ? { box: boxUrl, vault: "v" } : null));
fake.setHandler("box_get_json", async ({ url }) => ({ status: 200, body: String(url).includes("/projects") ? JSON.stringify({ projects: [{ slug: "thesis", name: "Thesis" }] }) : "{}" }));
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

test("box mode: Ask goes to the box in the attached chat, after the lines before it; the screen tools are this laptop's", async () => {
  const { voiceToolVia, boxVoice } = await import("../../src/voiceBox.ts");
  const b = (await boxVoice(vault))!;
  let saved = false;
  const lines = new Promise((r) => setTimeout(() => ((saved = true), r(undefined)), 30));
  const h = voice.buildClientToolHandlers(voiceToolVia(b.link, vault, undefined, () => "chat-7"), ["Ask"], () => lines);
  posts.length = 0;
  assert.equal(await h.Ask({ request: "summarise the week" }), "box ran Ask");
  assert.equal(saved, true, "the request waited for Carl's words to be saved");
  assert.deepEqual(
    posts.map((p) => [p.path, p.body.name, p.body.args.request, p.body.convId, p.body.device]),
    [["/api/v1/voice/tool?vault=v", "Ask", "summarise the week", "chat-7", "laptop"]],
  );
  assert.deepEqual(Object.keys(h).sort(), ["Ask", "LookAtScreen", "ScrollTo", "ShowFile"]);
  // Nothing was written on the laptop: any change is the agent's, on the box.
  assert.equal(fake.calls.some((c) => c.cmd === "write_text_file"), false);
});

test("box mode: ScrollTo stays local (it moves this screen)", async () => {
  const h = voice.buildClientToolHandlers((await boxVoiceTool(vault))!);
  posts.length = 0;
  assert.equal(await h.ScrollTo({ page: 2 }), "Error: no file is currently open.");
  assert.equal(posts.length, 0);
});

test("off a box: voice does not start, and says to connect the box", async () => {
  const local = makeTempVault("vc-voicelocal-");
  assert.equal(await boxVoiceTool(local), null);
  useStore.setState({ vaultPath: local, voiceError: null } as any);
  posts.length = 0;
  await voice.startElevenLabsSession();
  assert.match(String(useStore.getState().voiceError ?? ""), /Connect your box to talk/);
  assert.equal(useStore.getState().voiceConnecting, false);
  assert.equal(posts.length, 0);
  useStore.setState({ vaultPath: vault, voiceError: null } as any);
});

test("relativeArgs: only paths under the vault change", () => {
  assert.deepEqual(relativeArgs({ path: `${vault}/a/b.md`, cwd: vault, x: 1 }, vault), { path: "a/b.md", cwd: ".", x: 1 });
  assert.deepEqual(relativeArgs({ path: "/etc/passwd" }, vault), { path: "/etc/passwd" });
  assert.deepEqual(relativeArgs({ path: "C:\\V\\notes\\a.md" }, "C:/v"), { path: "notes/a.md" });
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
  assert.deepEqual(seen, ["/api/v1/voice/session?convId=c1&device=laptop"]);
  assert.equal(b.link.vault, "v", "(boxGet adds ?vault= from the link)");
  // Settings' voice model and voice ride along: the box's agent uses them.
  localStorage.setItem("vault_chat_elevenlabs_llm", "claude-sonnet-4-6");
  localStorage.setItem("vault_chat_elevenlabs_voice", "JBFqnCBsd6RMkjVDRZzb");
  const chosen: string[] = [];
  await boxVoiceSession(b, "c1", async (_l, path) => {
    chosen.push(path);
    return { signedUrl: "wss://fake/y", systemPrompt: "p", toolNames: [] };
  });
  assert.deepEqual(chosen, ["/api/v1/voice/session?convId=c1&device=laptop&llm=claude-sonnet-4-6&voice=JBFqnCBsd6RMkjVDRZzb"]);
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

test("the transcript is saved on the box in order, into the chat voice is attached to, under its own id", async () => {
  const { boxVoice, voiceTranscriptMirror } = await import("../../src/voiceBox.ts");
  const b = (await boxVoice(vault))!;
  const chat = useStore.getState().newConversation();
  const sent: any[] = [];
  const post = async (_l: any, path: string, body: any) => {
    sent.push({ path, ...body });
    await new Promise((r) => setTimeout(r, body.role === "user" ? 30 : 0)); // the first answers slowest
    return { ok: true, data: { ok: true, convId: body.convId } };
  };
  const m = voiceTranscriptMirror(b, chat, post);
  m.push({ role: "user", content: "what's the budget?" });
  m.push({ role: "assistant", content: "LookAtScreen", system: true, toolCalls: [{ name: "LookAtScreen", input: {}, result: "budget.md" }] } as any);
  m.push({ role: "assistant", content: "3.2B tokens." });
  await m.done();
  assert.deepEqual(
    sent.map((x) => [x.path, x.convId, x.role, x.text, !!x.system, x.device]),
    [
      ["/api/v1/voice/transcript", chat, "user", "what's the budget?", false, "laptop"],
      ["/api/v1/voice/transcript", chat, "assistant", "LookAtScreen", true, "laptop"],
      ["/api/v1/voice/transcript", chat, "assistant", "3.2B tokens.", false, "laptop"],
    ],
  );
  assert.equal(useStore.getState().activeConversationId, chat, "the same chat: no conversation of voice's own");
});

test("the call's updates come from the box for the attached chat (long-polled from the session's cursor)", async () => {
  const { boxVoice, boxVoiceUpdates } = await import("../../src/voiceBox.ts");
  const b = (await boxVoice(vault))!;
  const seen: string[] = [];
  const page = await boxVoiceUpdates(b.link, "chat-7", "100:100", async (_l, path) => {
    seen.push(path);
    return { updates: [{ id: "r1", kind: "result", speak: true, text: "[vc:result] The agent answered: done." }], cursor: "200:100" };
  });
  assert.deepEqual(seen, ["/api/v1/voice/updates?convId=chat-7&wait=20000&cursor=100%3A100"]);
  assert.equal(page.cursor, "200:100");
  assert.equal(page.updates[0]!.speak, true);
});

test("voice has no tool that acts but Ask: no project, notes or file tool of its own (they are the agent's)", async () => {
  const h = voice.buildClientToolHandlers((await boxVoiceTool(vault))!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(h).sort(), ["Ask", "LookAtScreen", "ScrollTo", "ShowFile"]);
  const { voiceToolDefs } = await import("../../src/voicePrompt.ts");
  const defs = voiceToolDefs("laptop");
  for (const n of ["SetProject", "ListProjects", "ListNotes", "CreateNote", "Write", "Edit", "Bash", "AskAgent"]) assert.ok(!defs.some((d) => d.name === n), n);
  assert.deepEqual(Object.keys(defs[0]!.parameters.properties), ["request"]);
});
