// One agent, many modalities — the laptop's half: a local chat turn writes its
// latest exchange into the stream; Ctrl+K / Ctrl+L get the capture a request
// is about as an image part (local: from this vault's captures; box mode: from
// the box's POST /api/v1/activity/image); Ctrl+L leaves out the open chat's
// exchange (its first turn carries that chat's transcript already).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { installFakeTauri, makeTempVault, startFakeOpenRouter, type FakeOpenRouter } from "./fakes.ts";

const vault = makeTempVault("vc-modes-");
const boxVault = makeTempVault("vc-modes-box-");
const fake = installFakeTauri(vault);
fake.setHandler("write_binary_file_unique", ({ dir, name, bytes }) => {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p.replace(/\\/g, "/");
});
fake.setHandler("read_binary_file", ({ path: p }) => [...fs.readFileSync(p)]);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// A box: answers the image route and the summary, records what it was asked.
const boxReqs: { method: string; url: string; body: any }[] = [];
let boxUrl = "";
const box = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    boxReqs.push({ method: req.method ?? "", url: req.url ?? "", body });
    res.writeHead(200, { "content-type": "application/json" });
    const url = req.url ?? "";
    if (url.startsWith("/api/v1/activity/image")) {
      const about = /figure/.test(String(body?.text ?? ""));
      res.end(JSON.stringify({ image: about ? { path: ".vault-chat/local/captures/box.png", mime: "image/png", dataBase64: PNG, caption: "[Attached: Carl's latest image capture from paper.pdf (page 2), 1 min ago — the image this request refers to.]" } : null }));
    } else if (url.startsWith("/api/v1/activity/summary")) res.end(JSON.stringify({ activity: "<recent_activity>\n- box\n</recent_activity>", project: "" }));
    else res.end(JSON.stringify({ ok: true }));
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
const cc = await import("../../src/chat-controller.ts");
const { runInlineAsk, buildInlineEditRequest } = await import("../../src/inlineEdit.ts");
const MAIN = "openai/gpt-6.1-sol";

let or: FakeOpenRouter;
before(async () => {
  await new Promise<void>((r) => box.listen(0, "127.0.0.1", () => r()));
  boxUrl = `http://127.0.0.1:${(box.address() as any).port}`;
  or = await startFakeOpenRouter(() => ({ text: "Eigenvectors keep their direction under the map; the notes are in courses/la.md." }));
  providers.setOpenRouterBaseURL(or.url);
  useStore.setState({ vaultPath: vault, apiKeys: { openrouter: "sk-test" }, modelId: MAIN, conversationsLoaded: true } as any);
});
after(async () => {
  providers.setOpenRouterBaseURL(null);
  await or.close();
  await new Promise<void>((r) => box.close(() => r()));
});

const entries = (v: string) => {
  try {
    return core.parseLog(fs.readFileSync(path.join(v, ".vault-chat", "local", "activity.jsonl"), "utf8"));
  } catch {
    return [];
  }
};

test("a local chat turn writes its latest exchange — Carl's message and the reply — and Ctrl+L leaves it out when it carries that chat", async () => {
  const convId = useStore.getState().newConversation();
  await cc.sendMessage("What is an eigenvector, briefly?");
  const until = Date.now() + 10_000;
  let chat: import("../../src/activityCore.ts").ActivityEntry | undefined;
  while (Date.now() < until) {
    await activity.flushActivity();
    chat = entries(vault).find((e) => e.kind === "chat" && e.convId === convId);
    if (chat) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(chat, "the exchange is in the stream");
  assert.equal(chat!.detail, 'Carl: "What is an eigenvector, briefly?" → Agent: "Eigenvectors keep their direction under the map; the notes are in courses/la.md."');
  // Ctrl+K's summary has it; Ctrl+L's (which carries the chat's last turns) does not.
  const k = await activity.sharedContextFor(vault, null);
  assert.ok(k.activity.includes("What is an eigenvector, briefly?"));
  const l = await activity.sharedContextFor(vault, null, 2500, convId);
  assert.ok(!l.activity.includes("What is an eigenvector, briefly?"));
});

test("local mode: a request about the capture gets the image itself, as an image part with what it is", async () => {
  activity.recordActivity(vault, { kind: "capture", text: "captured a region", path: "paper.pdf", where: "page 2", imageDataUrl: `data:image/png;base64,${PNG}` });
  await activity.flushActivity();
  assert.equal(await activity.contextImageFor(vault, "make the title shorter"), null);
  const img = await activity.contextImageFor(vault, "what does this figure show?");
  assert.ok(img);
  assert.equal(img!.dataUrl, `data:image/png;base64,${PNG}`);
  assert.match(img!.path, /^\.vault-chat\/local\/captures\//);
  assert.ok(img!.caption.startsWith("[Attached: Carl's latest image capture from paper.pdf (page 2)"));
  // Given once: excluded, it is not given again.
  assert.equal(await activity.contextImageFor(vault, "what does this figure show?", { exclude: [img!.path] }), null);
  // Ctrl+L: the request carries it, captioned.
  for await (const _ of runInlineAsk({
    modelId: MAIN,
    apiKey: "sk-test",
    vault,
    prompt: "what does this figure show?",
    selection: "",
    before: "",
    after: "",
    extraImages: [{ imageDataUrl: img!.dataUrl, sourcePath: img!.sourcePath, sourceAnchor: img!.sourceAnchor ?? null, caption: img!.caption }],
  })) void _;
  const user = or.requests.at(-1).messages.find((m: any) => m.role === "user");
  const parts = user.content as any[];
  assert.ok(Array.isArray(parts));
  assert.ok(parts.some((p) => p.type === "text" && p.text.startsWith("[Attached: Carl's latest image capture")));
  assert.ok(parts.some((p) => p.type === "image_url" && String(p.image_url?.url ?? "").startsWith("data:image/png;base64,")));
  // Ctrl+K: the same image part on its request.
  const k = buildInlineEditRequest({ modelId: MAIN, apiKey: "x", prompt: "describe the figure here", selection: "", before: "", after: "", extraImages: [{ imageDataUrl: img!.dataUrl, caption: img!.caption }] });
  const kParts = k.messages[0]!.content as any[];
  assert.equal(kParts.filter((p) => p.type === "image").length, 1);
  assert.equal(kParts[1].text, img!.caption);
});

test("box mode: the image comes from the box's captures (one POST, this vault's)", async () => {
  boxReqs.length = 0;
  const img = await activity.contextImageFor(boxVault, "explain this figure", { deictic: true, exclude: ["x"] });
  assert.ok(img);
  assert.equal(img!.dataUrl, `data:image/png;base64,${PNG}`);
  const post = boxReqs.find((r) => r.url.startsWith("/api/v1/activity/image"))!;
  assert.equal(post.url, "/api/v1/activity/image?vault=physics");
  assert.deepEqual(post.body, { text: "explain this figure", deictic: true, exclude: ["x"] });
  assert.equal(await activity.contextImageFor(boxVault, "list my notes"), null);
  // The summary for Ctrl+L names the chat to leave out.
  await activity.sharedContextFor(boxVault, "optics", 2500, "conv-1");
  assert.ok(boxReqs.some((r) => r.url === "/api/v1/activity/summary?project=optics&exclude=conv-1&vault=physics"));
});
