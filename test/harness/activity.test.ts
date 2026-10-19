// The shared context stream, laptop side (src/activity.ts): entries are posted
// to the box's log for this vault; with no box there is no stream; the switch
// turns writing off. Ctrl+K and Ctrl+L are side threads on the box
// (POST /api/v1/side; the box forks the open conversation and adds the stream
// itself): what they send, the answer streaming in through GET
// /api/v1/side/:id (what the popover shows as it comes), a refinement in the
// same side thread, Esc stopping it on the box, and the box-unreachable words.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-activity-");
const boxVault = makeTempVault("vc-activity-box-");
const fake = installFakeTauri(vault);

// A box: records what it is sent; a side thread answers in versions (pi's text
// so far), one per poll, the last one done. `stream` is what the next one says.
const boxReqs: { method: string; url: string; body: any }[] = [];
let boxUrl = "";
let stream = ["# Sh", "# Short", "# Short title"];
const sides = new Map<string, { texts: string[]; stopped: boolean }>();
const box = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = req.url ?? "";
    boxReqs.push({ method: req.method ?? "", url, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { "content-type": "application/json" });
    const poll = /^\/api\/v1\/side\/([^/?]+)\?after=(\d+)/.exec(url);
    if (req.method === "POST" && url.startsWith("/api/v1/side?")) {
      const body = JSON.parse(raw);
      const id = body.side ?? `side-${sides.size + 1}`;
      sides.set(id, { texts: [...stream], stopped: false });
      res.end(JSON.stringify({ ok: true, id, v: 0 }));
    } else if (req.method === "POST" && /^\/api\/v1\/side\/[^/]+\/stop/.test(url)) {
      const sd = sides.get(decodeURIComponent(url.split("/")[4]!));
      if (sd) sd.stopped = true;
      res.end(JSON.stringify({ ok: true }));
    } else if (poll) {
      const sd = sides.get(decodeURIComponent(poll[1]!))!;
      const v = Number(poll[2]) + 1;
      const done = sd.stopped || v >= sd.texts.length;
      res.end(JSON.stringify({ id: poll[1], v, text: sd.texts[Math.min(v, sd.texts.length) - 1], done, error: sd.stopped ? "stopped" : null }));
    } else res.end(JSON.stringify({ ok: true }));
  });
});
fake.setHandler("vault_box_config", ({ vault: v }) => (v === boxVault ? { box: boxUrl, vault: "physics" } : null));
fake.setHandler("box_post_json", async ({ url, body }) => {
  const r = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json" } });
  return { status: r.status, body: await r.text() };
});
fake.setHandler("box_get_json", async ({ url }) => {
  const r = await fetch(url);
  return { status: r.status, body: await r.text() };
});

const { useStore } = await import("../../src/store.ts");
const activity = await import("../../src/activity.ts");
const core = await import("../../src/activityCore.ts");
const { runInlineEdit, runInlineAsk, buildInlineAskRequest } = await import("../../src/inlineEdit.ts");
const { complete } = await import("../../src/complete.ts");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

before(async () => {
  await new Promise<void>((r) => box.listen(0, "127.0.0.1", () => r()));
  boxUrl = `http://127.0.0.1:${(box.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => box.close(() => r()));
});

const logPath = (v: string) => path.join(v, ".vault-chat", "local", "activity.jsonl");

test("no box: nothing is written on the laptop and there is no shared context", async () => {
  boxReqs.length = 0;
  activity.recordActivity(vault, { kind: "focus", text: "opened the file", path: "notes/a.md" });
  await activity.flushActivity();
  assert.ok(!fs.existsSync(logPath(vault)), "no local log");
  assert.equal(await activity.contextImageFor(vault, "what is this figure", { deictic: true }), null);
  assert.equal(boxReqs.length, 0);
  // The current project comes from the conversation Carl is in.
  useStore.setState({ conversations: [{ id: "c1", title: "x", messages: [], project: "coconut" }], activeConversationId: "c1" } as any);
  assert.equal(activity.currentProject(), "coconut");
});

test("the switch: vault_chat_activity = 0 posts nothing", async () => {
  boxReqs.length = 0;
  localStorage.setItem(activity.ACTIVITY_SWITCH, "0");
  try {
    assert.equal(activity.activityEnabled(), false);
    activity.recordActivity(boxVault, { kind: "ask", text: "should not be written" });
    await activity.flushActivity();
    assert.equal(boxReqs.filter((r) => r.method === "POST").length, 0);
  } finally {
    localStorage.removeItem(activity.ACTIVITY_SWITCH);
  }
});

test("entries are posted to the box's vault (the image as data for it to store)", async () => {
  boxReqs.length = 0;
  activity.recordActivity(boxVault, { kind: "ask", modality: "ctrl-l", text: 'asked "what is RoPE"', detail: "answer: rotary embeddings", path: "paper.pdf", where: "page 3" });
  activity.recordActivity(boxVault, { kind: "capture", text: "captured a region", imageDataUrl: `data:image/png;base64,${PNG}` });
  await activity.flushActivity();
  const posts = boxReqs.filter((r) => r.method === "POST");
  assert.deepEqual(posts.map((p) => p.url), ["/api/v1/activity?vault=physics", "/api/v1/activity?vault=physics"]);
  assert.equal(posts[0]!.body.entry.text, 'asked "what is RoPE"');
  assert.equal(posts[1]!.body.imageBase64, PNG);
  assert.equal(posts[1]!.body.imageMime, "image/png");
  assert.equal(posts[1]!.body.entry.imageDataUrl, undefined);
  assert.ok(!fs.existsSync(logPath(boxVault)), "nothing is written on the laptop");
});

test("Ctrl+K: a side thread of the open conversation on the box; the replacement streams in", async () => {
  useStore.setState({ vaultPath: boxVault } as any);
  boxReqs.length = 0;
  stream = ["# Sh", "# Short", "# Short title"];
  const seen: string[] = [];
  const out = await runInlineEdit({ prompt: "undo the edit I just made", selection: "# A very long title", before: "", after: "\nbody\n", convId: "conv-7" }, { onText: (t) => seen.push(t) });
  assert.deepEqual(out, { text: "# Short title", side: "side-1" });
  // What the popover shows as it comes: each version of pi's text, in order.
  assert.deepEqual(seen, ["# Sh", "# Short", "# Short title"]);
  const req = boxReqs.find((r) => r.method === "POST" && r.url.startsWith("/api/v1/side"))!;
  assert.equal(req.url, "/api/v1/side?vault=physics");
  assert.equal(req.body.kind, "edit");
  assert.equal(req.body.convId, "conv-7");
  assert.ok(req.body.text.startsWith("# Ctrl+K: an inline edit"), "the edit's own rules first");
  assert.ok(req.body.text.includes("You are an inline editor"));
  assert.ok(req.body.text.includes("INSTRUCTION:\nundo the edit I just made"));
  // The context (the conversation, the activity stream) is the box's: none of it is sent from here.
  assert.ok(!req.body.text.includes("Context from Carl's other surfaces"));
  assert.ok(!req.body.text.includes("recent_activity"));
  const polls = boxReqs.filter((r) => r.method === "GET" && r.url.startsWith("/api/v1/side/side-1"));
  assert.deepEqual(polls.map((r) => /after=(\d+)/.exec(r.url)![1]), ["0", "1", "2"]);
});

test("Ctrl+L: the marquee's image goes with the first request; a follow-up continues the same side thread", async () => {
  boxReqs.length = 0;
  stream = ["It is", "It is a circle."];
  const answer = await runInlineAsk({ prompt: "what did I just circle?", selection: "", before: "", after: "", convId: "conv-7", imageDataUrl: `data:image/png;base64,${PNG}` });
  assert.equal(answer.text, "It is a circle.");
  const req = boxReqs.find((r) => r.method === "POST" && r.url.startsWith("/api/v1/side"))!;
  assert.equal(req.body.kind, "ask");
  assert.ok(req.body.text.startsWith("# Ctrl+L: a question about the file"));
  assert.ok(req.body.text.includes("look it up with your read-only tools (files in the vault, PDFs with PdfRead"));
  assert.ok(req.body.text.includes("Never ask Carl for a screenshot"));
  assert.deepEqual(req.body.images, [`data:image/png;base64,${PNG}`]);
  // The popover's next request: only what is new, in the same side thread.
  const refine = buildInlineAskRequest({ prompt: "shorter", selection: "x", before: "", after: "", side: answer.side, convId: "conv-7", imageDataUrl: `data:image/png;base64,${PNG}` });
  assert.deepEqual(refine, { kind: "ask", side: answer.side, text: "shorter" });
});

test("Esc: the side thread is stopped on the box", async () => {
  boxReqs.length = 0;
  stream = ["a", "ab", "abc", "abcd", "abcde"];
  const ac = new AbortController();
  const seen: string[] = [];
  await runInlineAsk({ prompt: "explain", selection: "", before: "", after: "" }, { signal: ac.signal, onText: (t) => (seen.push(t), seen.length === 2 && ac.abort()) });
  const stopped = () => boxReqs.some((r) => r.method === "POST" && /^\/api\/v1\/side\/side-\d+\/stop/.test(r.url));
  for (let i = 0; i < 50 && !stopped(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(stopped(), "stop sent");
  assert.deepEqual(seen, ["a", "ab"], "nothing shown after Esc");
});

test("a one-shot (a note's title, spoken math) is a side request too, and returns its text", async () => {
  boxReqs.length = 0;
  stream = ["KV", "KV cache basics"];
  assert.equal(await complete({ instructions: "You write the headline for a saved note.", text: "a note", fast: true }), "KV cache basics");
  const req = boxReqs.find((r) => r.method === "POST" && r.url.startsWith("/api/v1/side"))!;
  assert.deepEqual(req.body, { kind: "once", system: "You write the headline for a saved note.", text: "a note", fast: true });
});

test("no box, or the box unreachable: Ctrl+K and Ctrl+L say so, in the chat's words", async () => {
  useStore.setState({ vaultPath: vault } as any);
  await assert.rejects(runInlineEdit({ prompt: "x", selection: "", before: "", after: "" }), /Connect your box to chat/);
  // A box that does not answer: a closed port.
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
  const deadUrl = `http://127.0.0.1:${(closed.address() as any).port}`;
  await new Promise<void>((r) => closed.close(() => r()));
  const deadVault = makeTempVault("vc-activity-dead-");
  fake.setHandler("vault_box_config", ({ vault: v }) => (v === boxVault ? { box: boxUrl, vault: "physics" } : v === deadVault ? { box: deadUrl, vault: "physics" } : null));
  fake.setHandler("box_post_json", async ({ url, body }) => {
    try {
      const r = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json" } });
      return { status: r.status, body: await r.text() };
    } catch (e) {
      throw String((e as any)?.cause?.code ?? (e as Error).message) + ": connection refused";
    }
  });
  useStore.setState({ vaultPath: deadVault } as any);
  await assert.rejects(runInlineAsk({ prompt: "x", selection: "", before: "", after: "" }), /^Error: Box unreachable: the box is down or restarting\.$/);
  // The box answers but refuses (its engine is down): its own words.
  useStore.setState({ vaultPath: boxVault } as any);
  fake.setHandler("box_post_json", async () => ({ status: 503, body: JSON.stringify({ error: "engine not running" }) }));
  await assert.rejects(runInlineEdit({ prompt: "x", selection: "", before: "", after: "" }), /The box could not answer: engine not running/);
  useStore.setState({ vaultPath: vault } as any);
});

test("voice tool calls that change things become entries, reads do not", () => {
  assert.equal(core.voiceToolEntry("Read", { path: "a.md" }, "x"), null);
  const e = core.voiceToolEntry("Edit", { path: `${vault}/notes/a.md`, old_string: "long", new_string: "short" }, "Edited", vault)!;
  assert.equal(e.path, "notes/a.md");
  assert.equal(e.text, "Voice edited notes/a.md");
  assert.equal(e.detail, '"long" → "short"');
  assert.match(core.voiceToolEntry("Write", { path: "x.md", contents: "y" }, "Error: nope")!.text, /failed: Error: nope/);
  // A refusal changed nothing and may name a denied path; another vault's tool did nothing here.
  assert.equal(core.voiceToolEntry("Bash", { command: "cat private/s.md" }, "Refused: command references restricted path 'private'."), null);
  assert.equal(core.voiceToolEntry("EchoKey", {}, 'Error: tool "EchoKey" is not available on the box.'), null);
  assert.equal(core.voiceLineEntry("user", "make it shorter", "v1")!.text, 'Carl said: "make it shorter"');
});
