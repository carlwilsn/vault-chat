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
      ["/api/v1/voice/tool", "Read", "notes/a.md"],
      ["/api/v1/voice/tool", "Write", "notes/b.md"],
      ["/api/v1/voice/tool", "Bash", "ls"],
      ["/api/v1/voice/tool", "AskAgent", "summarise the week"],
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
