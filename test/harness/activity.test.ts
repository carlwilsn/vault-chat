// The shared context stream, laptop side (src/activity.ts): entries are posted
// to the box's log for this vault and the summary fetched with ?vault=; with no
// box there is no stream; the switch turns writing off. Ctrl+K and Ctrl+L send
// the block (summary + project memory) in their request to the box's
// /api/v1/complete — asserted on the body the fake box receives.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-activity-");
const boxVault = makeTempVault("vc-activity-box-");
const fake = installFakeTauri(vault);

// A box: records what it is sent, answers the summary and one-shot calls.
const boxReqs: { method: string; url: string; body: any }[] = [];
let boxUrl = "";
const box = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    boxReqs.push({ method: req.method ?? "", url: req.url ?? "", body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { "content-type": "application/json" });
    if ((req.url ?? "").startsWith("/api/v1/activity/summary")) {
      res.end(JSON.stringify({ activity: "<recent_activity>\n- [1 min ago] Voice: Carl said: \"from the box\"\n</recent_activity>", project: "<project_context>\nbox project memory\n</project_context>" }));
    } else if ((req.url ?? "").startsWith("/api/v1/complete")) {
      res.end(JSON.stringify({ text: "# Short title" }));
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
  assert.deepEqual(await activity.sharedContextFor(vault, "coconut"), { activity: "", project: "" });
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

test("entries are posted to the box's vault (the image as data for it to store), the summary fetched with ?vault=", async () => {
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
  const c = await activity.sharedContextFor(boxVault, "optics");
  const get = boxReqs.find((r) => r.method === "GET")!;
  assert.equal(get.url, "/api/v1/activity/summary?project=optics&vault=physics");
  assert.ok(c.activity.includes("from the box"));
  assert.ok(c.project.includes("box project memory"));
});

test("Ctrl+K: the box's one-shot call carries the shared context after the editor's rules", async () => {
  useStore.setState({ vaultPath: boxVault } as any);
  const shared = activity.sharedContextText(await activity.sharedContextFor(boxVault, "optics"));
  boxReqs.length = 0;
  const out = await runInlineEdit({ prompt: "undo the edit I just made", selection: "# Short title", before: "", after: "\nbody\n", sharedContext: shared });
  assert.equal(out, "# Short title");
  const req = boxReqs.find((r) => r.url.startsWith("/api/v1/complete"))!;
  assert.equal(req.url, "/api/v1/complete?vault=physics");
  assert.ok(req.body.instructions.startsWith("You are an inline editor"), "the editor's own rules first");
  assert.ok(req.body.instructions.includes("# Context from Carl's other surfaces"));
  assert.ok(req.body.instructions.includes("box project memory"));
  // The request's text is the edit, not the context.
  assert.ok(req.body.text.includes("INSTRUCTION:\nundo the edit I just made"));
  assert.ok(!req.body.text.includes("recent_activity"));
});

test("Ctrl+L: the ask carries it too, and the marquee's image; without it the prompt is as before", async () => {
  const shared = activity.sharedContextText(await activity.sharedContextFor(boxVault, "optics"));
  boxReqs.length = 0;
  const answer = await runInlineAsk({ prompt: "what did I just circle?", selection: "", before: "", after: "", sharedContext: shared, imageDataUrl: `data:image/png;base64,${PNG}` });
  assert.equal(answer, "# Short title");
  const req = boxReqs.find((r) => r.url.startsWith("/api/v1/complete"))!;
  assert.ok(req.body.instructions.includes("<recent_activity>"));
  assert.ok(req.body.instructions.includes("<project_context>"));
  assert.deepEqual(req.body.images, [`data:image/png;base64,${PNG}`]);
  const plain = buildInlineAskRequest({ prompt: "q", selection: "", before: "", after: "" });
  assert.ok(!plain.instructions.includes("Context from Carl's other surfaces"));
  // Earlier turns of the popover ride in the one message.
  const refine = buildInlineAskRequest({ prompt: "shorter", selection: "", before: "", after: "", priorTurns: [{ prompt: "explain", result: "A long answer." }] });
  assert.ok(refine.text.includes("[Earlier in this popover]\nYou answered:\nA long answer."));
  assert.ok(refine.text.endsWith("[The latest request]\nshorter"));
});

test("no box: Ctrl+K says so, in the chat's words", async () => {
  useStore.setState({ vaultPath: vault } as any);
  await assert.rejects(runInlineEdit({ prompt: "x", selection: "", before: "", after: "" }), /Connect your box to chat/);
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
