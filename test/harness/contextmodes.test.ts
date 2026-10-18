// One agent, many modalities — the laptop's half: Ctrl+K / Ctrl+L get the
// capture a request is about from the box (POST /api/v1/activity/image) and
// send it as an image with what it is; Ctrl+L's summary leaves out the open
// chat's exchange (its first turn carries that chat's transcript already).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-modes-");
const boxVault = makeTempVault("vc-modes-box-");
const fake = installFakeTauri(vault);
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

const activity = await import("../../src/activity.ts");
const { buildInlineEditRequest, buildInlineAskRequest } = await import("../../src/inlineEdit.ts");

before(async () => {
  await new Promise<void>((r) => box.listen(0, "127.0.0.1", () => r()));
  boxUrl = `http://127.0.0.1:${(box.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => box.close(() => r()));
});

test("the image comes from the box's captures (one POST, this vault's)", async () => {
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

test("Ctrl+K and Ctrl+L carry the capture as an image, captioned with what it is", async () => {
  const img = (await activity.contextImageFor(boxVault, "what does this figure show?"))!;
  const extra = { imageDataUrl: img.dataUrl, caption: img.caption };
  const k = buildInlineEditRequest({ prompt: "describe the figure here", selection: "", before: "", after: "", extraImages: [extra] });
  assert.deepEqual(k.images, [img.dataUrl]);
  assert.ok(k.text.includes(`Image 1: ${img.caption}`));
  const l = buildInlineAskRequest({ prompt: "what does this figure show?", selection: "", before: "", after: "", extraImages: [extra] });
  assert.deepEqual(l.images, [img.dataUrl]);
  assert.ok(l.text.includes("Image 1: [Attached: Carl's latest image capture"));
  // No image: none sent.
  assert.equal(buildInlineEditRequest({ prompt: "x", selection: "", before: "", after: "" }).images, undefined);
});
