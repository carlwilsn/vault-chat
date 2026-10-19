// One agent, many modes (Carl, 2026-10-17: the voice agent kept seeing the old
// rectangle-charge problem after he pasted the potassium one into homework 3,
// and when he pasted it into the chat the TEXT agent answered while the voice
// agent said it saw nothing).
//   - LookAtScreen reads the focused pane off the page at call time: the text
//     and every image in view as shown — an in-editor paste included, with no
//     save, no disk read, no sync.
//   - One brain answers each turn (D3): while voice is live on a conversation,
//     what Carl types goes to the conversation's agent, never into the call
//     (voice hears it, and the agent's answer, as context from the box).
//   - A new session gets the thread's recent images (it never saw them).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-oneagent-");
const fake = installFakeTauri(vault);
fake.setHandler("read_binary_file", ({ path: p }) => [...fs.readFileSync(p)]);
fake.setHandler("git_repo_root_for_file", () => vault);

const { useStore } = await import("../../src/store.ts");
const voice = await import("../../src/voice-elevenlabs.ts");
const look = await import("../../src/screenLook.ts");
const { dispatchChatAction } = await import("../../src/sync.ts");

// ---- a scripted ElevenLabs conversation ------------------------------------
type Sent = { text?: string; fileId: string };
function fakeConv() {
  const uploads: Blob[] = [];
  const sent: Sent[] = [];
  const userMessages: string[] = [];
  return {
    uploads,
    sent,
    userMessages,
    async uploadFile(b: Blob) {
      uploads.push(b);
      return { fileId: `f${uploads.length}` };
    },
    sendMultimodalMessage(m: Sent) {
      sent.push(m);
    },
    sendUserMessage(t: string) {
      userMessages.push(t);
    },
    sendContextualUpdate() {},
    setMicMuted() {},
    setVolume() {},
    getInputByteFrequencyData: () => new Uint8Array(32),
    getOutputByteFrequencyData: () => new Uint8Array(32),
    endSession: async () => {},
  };
}

// ---- a tiny DOM: the pane as the page lays it out ---------------------------
type Rect = { left: number; top: number; right: number; bottom: number };
class El {
  parentElement: El | null = null;
  children: El[] = [];
  constructor(
    public tagName: string,
    public rect: Rect,
    public attrs: Record<string, string> = {},
    public ownText = "",
  ) {}
  add(...c: El[]): this {
    for (const x of c) {
      x.parentElement = this;
      this.children.push(x);
    }
    return this;
  }
  getBoundingClientRect() {
    return { ...this.rect, width: this.rect.right - this.rect.left, height: this.rect.bottom - this.rect.top };
  }
  getAttribute(n: string) {
    return n in this.attrs ? this.attrs[n]! : null;
  }
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  private matchOne(sel: string): boolean {
    const m = /^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[\w-]+\])*)$/i.exec(sel.trim());
    if (!m) return false;
    const [, tag, cls, attrs] = m;
    if (tag && tag.toUpperCase() !== this.tagName.toUpperCase()) return false;
    for (const c of (cls ?? "").split(".").filter(Boolean)) if (!(this.attrs.class ?? "").split(/\s+/).includes(c)) return false;
    for (const a of (attrs ?? "").match(/[\w-]+/g) ?? []) if (!(a in this.attrs)) return false;
    return true;
  }
  matches(sel: string) {
    return sel.split(",").some((s) => this.matchOne(s));
  }
  querySelectorAll(sel: string): El[] {
    const out: El[] = [];
    const walk = (e: El) => {
      for (const c of e.children) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  closest(sel: string): El | null {
    for (let e: El | null = this; e; e = e.parentElement) if (e.matches(sel)) return e;
    return null;
  }
}
const R = (top: number, bottom: number, left = 0, right = 800): Rect => ({ left, top, right, bottom });
// A PNG's bytes as a data URL (what drawing the shown image gives).
const png = (n: number) => `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, n, n, n, n]).toString("base64")}`;
look.setLookDrawForTests(async (el) => {
  const url = (el as El).attrs["data-test-pixels"];
  if (!url) throw new Error("it hasn't loaded");
  return url;
});

const HW = `${vault}/Physics 135/Homework/homework 3.md`;
let pane: El;
let scroller: El;
let content: El;
function buildPane() {
  pane = new El("div", R(0, 900), { "data-look-pane": "main", "data-file": HW, "data-active": "true", "data-mode": "editing" });
  const header = new El("div", R(0, 40), { "data-look-skip": "" }).add(new El("span", R(0, 40), {}, "Physics 135 › Homework › homework 3.md"));
  scroller = new El("div", R(40, 900), { class: "cm-scroller" });
  Object.assign(scroller, { scrollTop: 0, scrollHeight: 2000, clientHeight: 860 });
  content = new El("div", R(40, 900), { class: "cm-content" });
  content.add(
    new El("div", R(50, 70), { class: "cm-line" }, "Problem 1. Four charges sit at the corners of a rectangle."),
    new El("div", R(70, 400), { class: "cm-line" }).add(
      new El("span", R(70, 400), { class: "cm-image-widget" }).add(new El("img", R(70, 400), { "data-src": "assets/rectangle.png", "data-test-pixels": png(1) })),
    ),
    // A toolbar icon: not content.
    new El("img", R(45, 61, 760, 776), { "data-src": "icons/pencil.svg", "data-test-pixels": png(9) }),
  );
  scroller.add(content);
  pane.add(header, scroller);
  (globalThis as any).document = { querySelectorAll: (s: string) => (pane.matches(s) ? [pane] : []) };
}

before(() => {
  fs.mkdirSync(`${vault}/Physics 135/Homework/assets`, { recursive: true });
  // On disk: the file as it was before the paste (no save, no sync since).
  fs.writeFileSync(HW, "Problem 1. Four charges sit at the corners of a rectangle.\n\n![](assets/rectangle.png)\n");
  useStore.setState({ vaultPath: vault, currentFile: HW, followAlong: true } as any);
  buildPane();
});

test("LookAtScreen: what is on screen now — a paste in the editor shows at once, no save, no disk read, no sync", async () => {
  const conv = fakeConv();
  voice.adoptVoiceSessionForPreview(conv);
  const h = voice.buildClientToolHandlers(async () => "box (never: the screen is read here)");
  const first = await h.LookAtScreen({});
  assert.match(first, /Physics 135\/Homework\/homework 3\.md is open \(editing\), showing about 0%–43% of the file\. There is more below/);
  assert.match(first, /not a synced copy/);
  assert.match(first, /Text in view:\nProblem 1\. Four charges/);
  assert.doesNotMatch(first, /Physics 135 › Homework/, "the pane's header isn't content");
  assert.match(first, /Images in view, top to bottom \(1\):\n1\. rectangle\.png — attached now/);
  assert.equal(conv.uploads.length, 1, "the toolbar icon isn't sent");
  assert.match(conv.sent[0]!.text!, /The user's screen now: Physics 135\/Homework\/homework 3\.md/);

  // Carl pastes the potassium problem under it in the editor: the editor shows
  // the new line and image (the file on disk is unchanged; nothing has synced).
  const reads = fake.calls.filter((c: any) => c.cmd === "read_binary_file").length;
  content.add(
    new El("div", R(410, 430), { class: "cm-line" }, "Problem 2. A potassium ion moves from inside the cell (−85.5 mV) to outside (0 V)."),
    new El("div", R(430, 760), { class: "cm-line" }).add(
      new El("span", R(430, 760), { class: "cm-image-widget" }).add(new El("img", R(430, 760), { "data-src": "assets/pasted-2026-10-17_06-09-50.png", "data-test-pixels": png(2) })),
    ),
  );
  const second = await h.LookAtScreen({});
  assert.match(second, /Problem 2\. A potassium ion/);
  assert.match(second, /1\. rectangle\.png — already in your context, unchanged\n2\. pasted-2026-10-17_06-09-50\.png — attached now/);
  assert.equal(conv.uploads.length, 2, "only the new image is uploaded");
  assert.equal(conv.sent.at(-1)!.fileId, "f2");
  assert.equal(fake.calls.filter((c: any) => c.cmd === "read_binary_file").length, reads, "nothing read from disk");
  assert.doesNotMatch(fs.readFileSync(HW, "utf8"), /potassium/, "and the file on disk never had it");

  // The same picture redrawn changed (an edit to the image itself): sent again.
  (content.children.at(-1)!.children[0]!.children[0] as El).attrs["data-test-pixels"] = png(3);
  assert.match(await h.LookAtScreen({}), /2\. pasted-2026-10-17_06-09-50\.png — attached now/);
  assert.equal(conv.uploads.length, 3);

  // An image that can't be drawn: said plainly, not blamed on syncing.
  delete (content.children.at(-1)!.children[0]!.children[0] as El).attrs["data-test-pixels"];
  const broken = await h.LookAtScreen({});
  assert.match(broken, /Couldn't capture: pasted-2026-10-17_06-09-50\.png: it hasn't loaded\./);
  assert.doesNotMatch(broken.replace("not a synced copy", ""), /sync/i);
  voice.adoptVoiceSessionForPreview(null);
});

test("the voice prompt on the laptop: it sees the screen and images, never asks for a refresh or a re-paste", async () => {
  const P = await import("../../src/voicePrompt.ts");
  const p = P.buildVoicePrompt({ device: "laptop" });
  assert.match(p, /LookAtScreen reads what is in view right now/);
  assert.match(p, /Never ask him to refresh, re-paste or send it again/);
  assert.match(p, /never blame syncing/);
  const def = P.voiceToolDefs("laptop").find((t) => t.name === "LookAtScreen")!;
  assert.match(def.description, /See Carl's screen right now, on the device in front of him/);
});

test("composer during voice: one brain per turn — what Carl types goes to the conversation's agent, never into the call", async () => {
  const id = useStore.getState().newConversation();
  useStore.getState().selectConversation(id);
  const conv = fakeConv();
  voice.adoptVoiceSessionForPreview(conv);
  assert.equal(voice.voiceSessionOn(id), true);
  assert.equal((voice as any).sendComposerToVoice, undefined, "no route from the composer into the call");
  dispatchChatAction({ kind: "send", text: "Sure, I just pasted it into the chat." });
  dispatchChatAction({ kind: "send", text: "this one", attachments: [{ imageDataUrl: png(7) }] });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(conv.userMessages, [], "the voice never gets a typed turn to answer");
  assert.equal(conv.uploads.length, 0);
  voice.adoptVoiceSessionForPreview(null);
});

test("a new session gets the thread's recent images it never saw (a resume, a reconnect)", async () => {
  const conv = fakeConv();
  voice.adoptVoiceSessionForPreview(conv);
  fs.mkdirSync(`${vault}/.vault-chat/captures`, { recursive: true });
  fs.writeFileSync(`${vault}/.vault-chat/captures/big.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 5, 5]));
  const r = await voice.pushThreadImages(
    [
      { role: "user", content: "the rectangle problem", attachments: [{ imageDataUrl: png(1) }] },
      { role: "assistant", content: "Got it." },
      // A large capture is kept on disk, not inline.
      { role: "user", content: "the potassium one", attachments: [{ imageDataUrl: "", capturedFilePath: ".vault-chat/captures/big.png" }] },
    ] as any,
    vault,
  );
  assert.deepEqual(r, ["sent", "sent"]);
  assert.equal(conv.uploads.length, 2);
  assert.equal(conv.sent.length, 2, "one message (each file id carries it here: the fake has no raw connection)");
  assert.match(conv.sent[0]!.text!, /Earlier in this conversation.*these 2 images were shared/);
  // (The box's prompt says an image went with a line: server/test/voice.test.ts.)
  voice.adoptVoiceSessionForPreview(null);
});
