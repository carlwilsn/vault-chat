// The voice on the laptop, in the preview: no mic and no box call, so the live call is a scripted stand-in (its levels:
// Carl's voice while `phase` is "user", the voice's while "agent") adopted by src/voiceCall.ts; the store's state is set
// as the box's feed would set it.
import type { Scenario, Step } from "./types";
import * as P3 from "./phase3";

let phase: "idle" | "user" | "agent" = "idle";

function levels(on: boolean): Uint8Array {
  const a = new Uint8Array(64);
  if (!on) return a;
  const t = performance.now() / 160;
  for (let i = 0; i < a.length; i++) {
    const shape = Math.max(0, 1 - i / 40);
    a[i] = Math.round(255 * shape * (0.35 + 0.65 * Math.abs(Math.sin(t + i * 0.7) * Math.cos(t * 0.6 + i * 0.23))));
  }
  return a;
}

function scriptedConversation() {
  return {
    getInputByteFrequencyData: () => levels(phase === "user"),
    getOutputByteFrequencyData: () => levels(phase === "agent"),
    setMicMuted() {},
    setVolume() {},
    async endSession() {},
  };
}

// The waiting line (src/voiceWaitLine.ts): one thin line under the titlebar waves while the voice waits on work.
const waitStore = async () => (await import(/* @vite-ignore */ "/src/store.ts")).useStore;
const waitCaption = (text: string): Step => ({
  run: () => {
    let el = document.getElementById("vw-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "vw-caption";
      el.style.cssText = "position:fixed;left:50%;top:44px;transform:translateX(-50%);z-index:99999;font:600 13px system-ui;padding:6px 12px;border-radius:8px;background:rgba(0,0,0,.72);color:#fff;pointer-events:none";
      document.body.appendChild(el);
    }
    el.textContent = text;
  },
});
const waitSet = (f: (s: any) => Record<string, unknown>): Step => ({
  run: async () => {
    const st = await waitStore();
    st.setState((s: any) => f(s));
  },
});
const waitConv = (patch: Record<string, unknown> | (() => Record<string, unknown>)) =>
  waitSet((s) => {
    const p = typeof patch === "function" ? patch() : patch;
    return { conversations: s.conversations.map((c: any) => (c.id === s.activeConversationId ? { ...c, ...p } : c)) };
  });
const waitTurn = (ago = 0) => waitSet(() => ({ busy: true, liveTools: [{ id: "t1", name: "read", input: { path: "Real 320-1/Chapter 1 - Proof Workbook.md" }, startedAt: Date.now() - ago }] }));
const waitTurnEnd = waitSet(() => ({ busy: false, liveTools: [] }));
const waitSpeak = (ms: number): Step[] => [
  { run: () => void (phase = "agent") },
  waitSet(() => ({ voiceSpeaking: true })),
  { sleep: ms },
  waitSet(() => ({ voiceSpeaking: false })),
  { run: () => void (phase = "idle") },
];
const todo = (done: number, total: number) => Array.from({ length: total }, (_, i) => ({ content: `step ${i + 1}`, status: i < done ? "completed" : i === done ? "in_progress" : "pending" }));
const waitStart: Step = {
  run: async () => {
    const st = await waitStore();
    const v: any = await import(/* @vite-ignore */ "/src/voiceCall.ts");
    st.getState().newConversation();
    v.adoptVoiceSessionForPreview(scriptedConversation());
    phase = "idle";
  },
};

export const voiceScenarios: Scenario[] = [
  {
    id: "voice-wait-line",
    title: "The voice's waiting line: short, long, a plan's steps, an overrun, complete while he talks",
    group: "Voice · Box",
    notes:
      "One thin line under the titlebar waves, only while the voice waits on work; when the voice talks back it goes. Quick work runs a quick line, work the agent called long (or that history says is long) a slow one; with a plan it fills by real steps; work that runs past its expectation turns slow; when the work ends it completes and stays complete, and if Carl is talking then, the voice waits for him (the bars are his voice) and speaks after.",
    clock: "2026-10-23T20:00:00",
    build: (ctx) => P3.build(ctx),
    open: [
      waitStart,
      { sleep: 1200 },
      waitCaption("1 · Quick read: a quick line"),
      waitTurn(),
      { sleep: 3000 },
      waitTurnEnd,
      waitCaption("1 · Done: the line completes, then the voice speaks"),
      { sleep: 1200 },
      ...waitSpeak(1600),
      waitCaption("2 · Delegated, expected long: a slow line"),
      waitConv(() => ({ subagents: [{ threadId: "w1", title: "Sectioned PDF of lecture 7", state: "running", startedAt: Date.now(), expect: "long" }] })),
      { sleep: 4500 },
      waitCaption("3 · A plan: the line fills by its real steps"),
      waitConv({ todos: todo(1, 4) }),
      waitTurn(),
      { sleep: 1500 },
      waitConv({ todos: todo(2, 4) }),
      { sleep: 1500 },
      waitConv({ todos: todo(3, 4) }),
      { sleep: 1500 },
      waitTurnEnd,
      waitConv({ todos: todo(4, 4), subagents: [] }),
      waitCaption("4 · Complete while he is talking: the voice waits for him"),
      { run: () => void (phase = "user") },
      { sleep: 3500 },
      { run: () => void (phase = "idle") },
      { sleep: 1200 },
      waitCaption("4 · He stopped: now it speaks"),
      ...waitSpeak(1800),
      waitCaption("5 · Overrun: quick work running long turns slow"),
      waitTurn(6000),
      { sleep: 5000 },
      waitTurnEnd,
      { sleep: 1000 },
      ...waitSpeak(1500),
      waitCaption("Done"),
      { sleep: 800 },
    ],
    surfaces: ["desktop"],
  },
];
