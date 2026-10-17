// One agent, many modes (Carl, 2026-10-17, homework 3): he pasted the next
// problem into the homework file while talking, and the voice agent's
// LookAtScreen kept seeing only the first problem; then he pasted it into the
// chat, the TEXT agent answered in the thread and the voice agent said it saw
// nothing. After: LookAtScreen reads the pane off the screen (the pasted image
// is there at once, nothing saved or synced), and while voice is on, the
// chat's composer is Carl's turn in the voice conversation — the image goes
// through the voice upload, and the text agent says nothing.
import type { Scenario, Step } from "./types";
import * as P3 from "./phase3";

const HW = "Physics 135/Homework/homework 3.md";
const DIR = "Physics 135/Homework/assets";
const SEL_COMPOSER = "textarea[placeholder^='Ask anything']";

type Seen = { kind: "files" | "text"; text?: string; size?: number };
/** What the scripted ElevenLabs conversation was handed, in order. */
const seen: Seen[] = [];
let lookResults: string[] = [];

function scripted() {
  const files = new Map<string, number>();
  return {
    getInputByteFrequencyData: () => new Uint8Array(64),
    getOutputByteFrequencyData: () => new Uint8Array(64),
    async uploadFile(b: Blob) {
      const id = `file-${files.size + 1}`;
      files.set(id, b.size);
      return { fileId: id };
    },
    sendMultimodalMessage(m: { text?: string; fileId: string }) {
      seen.push({ kind: "files", text: m.text, size: files.get(m.fileId) ?? 0 });
    },
    sendUserMessage(text: string) {
      seen.push({ kind: "text", text });
    },
    sendContextualUpdate() {},
    setMicMuted() {},
    setVolume() {},
    async endSession() {},
  };
}

/** A problem as a picture (a small PNG). */
async function problemPng(title: string, line: string, hue: number): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = 520;
  c.height = 150;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = `hsl(${hue}, 60%, 88%)`;
  g.fillRect(0, 0, c.width, 34);
  g.fillStyle = "#222";
  g.font = "bold 16px sans-serif";
  g.fillText(title, 12, 23);
  g.font = "14px sans-serif";
  g.fillText(line, 12, 80);
  return new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
}

const has = async (): Promise<boolean> => {
  const v: any = await import(/* @vite-ignore */ "/src/voice-elevenlabs.ts");
  return typeof v.sendComposerToVoice === "function";
};
const fail = (m: string) => {
  throw new Error(`voice-one-agent: ${m}`);
};
const until = async (ok: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  fail(`${what} (waited ${ms} ms)`);
};

const writeFirst: Step = {
  run: async ({ vault }) => {
    const bytes = Array.from(new Uint8Array(await (await problemPng("Problem 1", "Four charges ±Q at the corners of an x by y rectangle: energy to pull them apart?", 210)).arrayBuffer()));
    await (window as any).__TAURI_INTERNALS__.invoke("write_binary_file_unique", { dir: `${vault}/${DIR}`, name: "rectangle.png", bytes });
  },
};

const startVoice: Step = {
  run: async () => {
    seen.length = 0;
    lookResults = [];
    (window as any).__oneAgent = { seen, lookResults };
    const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
    const v: any = await import(/* @vite-ignore */ "/src/voice-elevenlabs.ts");
    useStore.getState().newConversation();
    v.ensureVoiceConversation();
    v.adoptVoiceSessionForPreview(scripted());
  },
};

/** Carl pastes the potassium problem under the first, in the editor (a real paste event). */
const pasteInEditor: Step = {
  run: async ({ q }) => {
    const cm = q(".cm-content");
    if (!cm) fail("the editor isn't showing homework 3");
    const blob = await problemPng("Problem 2", "A K+ ion moves from inside the cell (−85.5 mV) to outside (0 V). ΔU?", 30);
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "image.png", { type: "image/png" }));
    cm!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await until(() => document.querySelectorAll(".cm-image-widget img[src^='blob:']").length >= 2, 4000, "the pasted image did not show in the editor");
    const scroller = q(".cm-scroller");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    await new Promise((r) => setTimeout(r, 300));
  },
};

/** "I've pasted it into the homework file." → LookAtScreen: the new problem is attached. */
const lookTurn: Step = {
  run: async () => {
    const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
    const v: any = await import(/* @vite-ignore */ "/src/voice-elevenlabs.ts");
    useStore.getState().appendMessage({ role: "user", content: "I've pasted it into the homework file." });
    const before = seen.length;
    const r: string = await v.buildClientToolHandlers().LookAtScreen({});
    lookResults.push(r);
    console.info("[voice-one-agent] LookAtScreen →", r.replace(/\s+/g, " ").slice(0, 400));
    if (!(await has())) return; // the before tree: whatever it saw
    if (!/homework 3\.md is open \(editing\)/.test(r)) fail(`LookAtScreen didn't name the open file: ${r.slice(0, 200)}`);
    if (!/pasted-[^\n]*\.png — attached now/.test(r)) fail(`the pasted problem wasn't attached: ${r.slice(0, 600)}`);
    const sent = seen.slice(before).filter((s) => s.kind === "files");
    if (!sent.length || !sent.every((s) => (s.size ?? 0) > 0)) fail("no image reached the voice conversation");
    useStore.getState().appendMessage({ role: "assistant", content: "Now I can see the potassium-ion question: a K⁺ ion goes from −85.5 millivolts inside to zero outside." });
  },
};

/** The same problem pasted into the chat's composer, then Enter. */
const pasteInComposer: Step = {
  run: async ({ q }) => {
    const ta = q(SEL_COMPOSER) as HTMLTextAreaElement | null;
    if (!ta) fail("no composer");
    const blob = await problemPng("Problem 2", "A K+ ion moves from inside the cell (−85.5 mV) to outside (0 V). ΔU?", 30);
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "image.png", { type: "image/png" }));
    ta!.focus();
    ta!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 400));
  },
};

const checkComposer: Step = {
  run: async () => {
    const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
    const start = useStore.getState().messages.length;
    (window as any).__oneAgentStart = start;
    if (!(await has())) return;
    await until(() => seen.some((s) => s.kind === "files" && /next one/.test(s.text ?? "")), 3000, "the composer's image did not reach the voice agent");
    // No text-agent turn: give it time to start one if it were going to.
    await new Promise((r) => setTimeout(r, 1500));
    const st = useStore.getState();
    const last = st.messages.filter((m: any) => !m.system).slice(-1)[0];
    if (!last || last.role !== "user" || !/next one/.test(last.content)) fail(`the thread's last line is not Carl's: ${JSON.stringify(last?.content)}`);
    if (!last.attachments?.length) fail("Carl's line lost its image in the thread");
    if (st.busy) fail("the text agent started a turn");
    const conv = st.conversations.find((c: any) => c.id === st.activeConversationId);
    if (conv?.status === "running") fail("the conversation is running a text turn");
    st.appendMessage({ role: "assistant", content: "Got it — same problem. Delta U is q times delta V: what's the charge on a potassium ion?" });
  },
};

export const voiceOneAgentScenarios: Scenario[] = [
  {
    id: "voice-one-agent",
    title: "Voice sees what you paste — in the editor and in the chat — and only voice answers",
    group: "Voice · One agent",
    clock: "2026-10-17T06:08:00",
    notes:
      "Homework 3 open in the editor, voice on (the ElevenLabs side scripted; window.__oneAgent.seen lists what it was handed). (1) Carl pastes the potassium problem under the first one, in the editor — a real paste: the image lands in assets/ and shows at once. He says “I've pasted it into the homework file”: LookAtScreen reads the pane off the screen — the file, the part in view, the text, both images (the new one attached now; the first one already seen). Nothing was saved or synced for that. (2) He pastes the same problem into the chat and presses Enter: it is his turn in the voice conversation — the image goes through the voice upload with his words, the line shows in the thread with its image, and the text agent says nothing (no turn, no reply). Before: LookAtScreen on a markdown file returned the text window from the last scroll (the first problem only, no image), and the composer started a text-agent turn that answered beside the voice agent.",
    build: (ctx) => {
      P3.build(ctx);
      ctx.write(HW, "## Problem 1\n\n![](assets/rectangle.png)\n\n");
    },
    surfaces: ["desktop"],
    open: [
      writeFirst,
      { file: HW, mode: "edit" },
      { wait: ".cm-image-widget img[src^='blob:']", timeout: 6000 },
      { chat: true },
      startVoice,
      { sleep: 600 },
      { key: "ctrl+End", target: ".cm-content" },
      pasteInEditor,
      { sleep: 500 },
      lookTurn,
      { sleep: 1200 },
      pasteInComposer,
      { type: "here's the next one", into: SEL_COMPOSER },
      { key: "Enter", target: SEL_COMPOSER },
      checkComposer,
      { sleep: 1200 },
    ],
  },
];
