// The shared context stream, laptop side (src/activity.ts): local mode writes
// this vault's .vault-chat/local/activity.jsonl and builds the summary and the
// project's memory here; box mode posts entries to the box and fetches the
// summary with ?vault=; the switch turns writing off. Ctrl+K and Ctrl+L send
// the block (summary + project memory) in their model request — asserted on
// the body a fake OpenRouter receives.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { installFakeTauri, makeTempVault, startFakeOpenRouter, type FakeOpenRouter } from "./fakes.ts";

const vault = makeTempVault("vc-activity-");
const boxVault = makeTempVault("vc-activity-box-");
const fake = installFakeTauri(vault);
// The fake's file handlers resolve relative paths against `vault`; ours are absolute.
fake.setHandler("write_binary_file_unique", ({ dir, name, bytes }) => {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p.replace(/\\/g, "/");
});

// A box: records what it is sent, answers the summary.
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
const providers = await import("../../src/providers.ts");
const { runInlineEdit, runInlineAsk } = await import("../../src/inlineEdit.ts");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let or: FakeOpenRouter;
before(async () => {
  await new Promise<void>((r) => box.listen(0, "127.0.0.1", () => r()));
  boxUrl = `http://127.0.0.1:${(box.address() as any).port}`;
  or = await startFakeOpenRouter(() => ({ text: "# Short title" }));
  providers.setOpenRouterBaseURL(or.url);
  useStore.setState({ vaultPath: vault } as any);
  // A project with memory, and global rules — what the chat already reads.
  const p = path.join(vault, "agent-projects", "coconut");
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "project.md"), "# Coconut\n\n## What\n\nDetect coconuts in drone images.\n");
  fs.writeFileSync(path.join(p, "memory.md"), "# Memory\n\n## Decisions\n\n- use YOLO at 640px\n");
  fs.writeFileSync(path.join(vault, ".vault-chat", "rules.md"), "Always cite the page.\n");
});
after(async () => {
  providers.setOpenRouterBaseURL(null);
  await or.close();
  await new Promise<void>((r) => box.close(() => r()));
});

const logPath = (v: string) => path.join(v, ".vault-chat", "local", "activity.jsonl");

test("local mode: entries land in this vault's .vault-chat/local/activity.jsonl (kept out of git), captures as files", async () => {
  activity.recordActivity(vault, { kind: "focus", text: "opened the file", path: "notes/a.md", project: "coconut" });
  activity.recordActivity(vault, {
    kind: "edit",
    modality: "ctrl-k",
    text: '"make the title shorter"',
    detail: core.editSummary("# A very long title", "# Short title"),
    outcome: "accepted",
    path: "notes/a.md",
    project: "coconut",
  });
  activity.recordActivity(vault, { kind: "capture", text: "captured a region for the chat", path: "paper.pdf", where: "page 2", imageDataUrl: `data:image/png;base64,${PNG}` });
  activity.recordActivity(vault, { kind: "voice", text: "Carl said: my key is sk-or-v1-0123456789abcdef0123456789abcdef" });
  await activity.flushActivity();
  const log = fs.readFileSync(logPath(vault), "utf8");
  const entries = core.parseLog(log);
  assert.equal(entries.length, 4);
  assert.equal(fs.readFileSync(path.join(vault, ".vault-chat", "local", ".gitignore"), "utf8"), "*\n");
  const cap = entries.find((e) => e.kind === "capture")!;
  assert.match(cap.image ?? "", /^\.vault-chat\/local\/captures\/[a-z0-9]+-[a-z0-9]+\.png$/);
  assert.equal(fs.readFileSync(path.join(vault, cap.image!)).toString("base64"), PNG);
  assert.ok(!log.includes(PNG.slice(0, 30)), "no image data in the log");
  assert.ok(!log.includes("sk-or-v1-0123"), "no key in the log");
});

test("local mode: the shared context is built here — the summary and the project's memory and rules", async () => {
  const c = await activity.sharedContextFor(vault, "coconut");
  assert.match(c.activity, /^<recent_activity>/);
  assert.ok(c.activity.includes("## Now")); // the last Ctrl+K edit, the latest capture, the last voice line
  assert.ok(c.activity.includes('Ctrl+K edit · notes/a.md: "make the title shorter" (accepted)'));
  assert.ok(c.activity.includes("[image: .vault-chat/local/captures/"));
  assert.match(c.project, /^<project_context>/);
  assert.ok(c.project.includes("# Project: Coconut (coconut)"));
  assert.ok(c.project.includes("use YOLO at 640px"));
  assert.ok(c.project.includes("Always cite the page."));
  // The current project comes from the conversation Carl is in.
  useStore.setState({ conversations: [{ id: "c1", title: "x", messages: [], project: "coconut" }], activeConversationId: "c1" } as any);
  assert.equal(activity.currentProject(), "coconut");
});

test("the switch: vault_chat_activity = 0 writes nothing", async () => {
  const before = fs.readFileSync(logPath(vault), "utf8");
  localStorage.setItem(activity.ACTIVITY_SWITCH, "0");
  try {
    assert.equal(activity.activityEnabled(), false);
    activity.recordActivity(vault, { kind: "ask", text: "should not be written" });
    await activity.flushActivity();
    assert.equal(fs.readFileSync(logPath(vault), "utf8"), before);
  } finally {
    localStorage.removeItem(activity.ACTIVITY_SWITCH);
  }
});

test("box mode: entries are posted to the box's vault (the image as data for it to store), the summary fetched with ?vault=", async () => {
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
  assert.ok(!fs.existsSync(logPath(boxVault)), "box mode writes nothing on the laptop");
  const c = await activity.sharedContextFor(boxVault, "optics");
  const get = boxReqs.find((r) => r.method === "GET")!;
  assert.equal(get.url, "/api/v1/activity/summary?project=optics&vault=physics");
  assert.ok(c.activity.includes("from the box"));
  assert.ok(c.project.includes("box project memory"));
});

test("Ctrl+K: the model request carries the shared context (summary + project memory) after the editor's rules", async () => {
  const shared = activity.sharedContextText(await activity.sharedContextFor(vault, "coconut"));
  let out = "";
  for await (const t of runInlineEdit({
    modelId: "openai/gpt-6.1-sol",
    apiKey: "sk-canary",
    prompt: "undo the edit I just made",
    selection: "# Short title",
    before: "",
    after: "\nbody\n",
    sharedContext: shared,
  })) out += t;
  assert.equal(out, "# Short title");
  const body = or.requests.at(-1);
  const system = body.messages.find((m: any) => m.role === "system").content as string;
  assert.ok(system.startsWith("You are an inline editor"), "the editor's own rules first");
  assert.ok(system.includes("# Context from Carl's other surfaces"));
  assert.ok(system.includes('Ctrl+K edit · notes/a.md: "make the title shorter" (accepted) — replaced 1 line(s) with 1: "# A very long title" → "# Short title"'));
  assert.ok(system.includes("use YOLO at 640px"));
  // The user turn is unchanged by it.
  const user = JSON.stringify(body.messages.filter((m: any) => m.role === "user"));
  assert.ok(!user.includes("recent_activity"));
});

test("Ctrl+L: the ask request carries it too; without it the prompt is as before", async () => {
  const shared = activity.sharedContextText(await activity.sharedContextFor(vault, "coconut"));
  for await (const _ of runInlineAsk({
    modelId: "openai/gpt-6.1-sol",
    apiKey: "sk-canary",
    vault,
    prompt: "what did I just circle?",
    selection: "",
    before: "",
    after: "",
    sharedContext: shared,
  })) void _;
  const system = or.requests.at(-1).messages.find((m: any) => m.role === "system").content as string;
  assert.ok(system.includes("<recent_activity>"));
  assert.ok(system.includes("Image capture · paper.pdf (page 2): captured a region for the chat [image: .vault-chat/local/captures/"));
  assert.ok(system.includes("<project_context>"));
  for await (const _ of runInlineAsk({ modelId: "openai/gpt-6.1-sol", apiKey: "sk-canary", vault, prompt: "q", selection: "", before: "", after: "" })) void _;
  const plain = or.requests.at(-1).messages.find((m: any) => m.role === "system").content as string;
  assert.ok(!plain.includes("Context from Carl's other surfaces"));
});

test("voice on this laptop: tool calls that change things become entries, reads do not", () => {
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
