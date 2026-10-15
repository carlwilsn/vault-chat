// Voice in box mode (server/voice.ts, src/voiceBox.ts): the laptop's voice
// agent runs its vault tools on the box and hands long work to the box's
// agent. The preview has no mic and no ElevenLabs, so the ElevenLabs side is
// scripted: each turn is what the platform would do — the user's words land
// in the voice thread, the agent calls its client tools (the app's real
// handlers, buildClientToolHandlers), then speaks a reply built from what the
// tools returned. The fake box (runtime/backend/host.ts, boxChat.voice)
// answers /api/v1/voice/tool; AskAgent starts a real box chat in its list.
// The before tree has no box voice: the same turns run every tool on the
// laptop and there is no AskAgent.
import type { Scenario, Step } from "./types";
import * as P2 from "./phase2";
import * as P3 from "./phase3";

const BOX = { box: "https://box.tail0a1b2.ts.net", vault: "summer-demo" };
const NOTE = "projects/bitnet-160m/writeup.md";
const CHATS = "[title^='Chats — switch']";

type Call = [name: string, args: Record<string, unknown> | ((prev: string[], vault: string) => Record<string, unknown>)];

/** Results of the last turn's tools, kept for the next turn (AgentStatus needs AskAgent's id). */
let lastResults: string[] = [];
/** After: the session's lines saved on the box (voiceBox.ts voiceTranscriptMirror), and how many went. */
let mirror: { push: (m: any) => unknown } | null = null;
let sent = 0;

/** Save the voice thread's new lines on the box, as the app does in box mode. */
async function saveLines(): Promise<void> {
  if (!mirror) return;
  const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
  const msgs = useStore.getState().messages;
  for (; sent < msgs.length; sent++) mirror.push(msgs[sent]);
}

/** One scripted ElevenLabs turn: heard → tool calls → spoken reply. */
const voiceTurn = (heard: string, calls: Call[], reply: (results: string[]) => string): Step => ({
  run: async () => {
    const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
    const v: any = await import(/* @vite-ignore */ "/src/voice-elevenlabs.ts");
    const st = useStore.getState();
    // Box voice exists only where the module says so (the before tree has neither).
    // (A runtime path: the before tree has no voiceBox.ts for Vite to resolve.)
    const voiceBox = `${import.meta.env.BASE_URL}src/voiceBox.ts`;
    const remote = v.LOCAL_VOICE_TOOLS ? await (await import(/* @vite-ignore */ voiceBox)).boxVoiceTool(st.vaultPath) : null;
    const h = v.buildClientToolHandlers(remote ?? undefined);
    st.appendMessage({ role: "user", content: heard });
    const results: string[] = [];
    for (const [name, a] of calls) {
      const args = typeof a === "function" ? a(lastResults, st.vaultPath ?? "") : a;
      if (!h[name]) {
        results.push("");
        continue;
      }
      results.push(await h[name](args));
      await new Promise((r) => setTimeout(r, 500));
    }
    lastResults = results;
    useStore.getState().appendMessage({ role: "assistant", content: reply(results) });
    await saveLines();
  },
});

/** A fresh voice thread, as the mic tap makes one. */
const startVoice: Step = {
  run: async () => {
    lastResults = [];
    const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
    const v: any = await import(/* @vite-ignore */ "/src/voice-elevenlabs.ts");
    const from = useStore.getState().activeConversationId;
    useStore.getState().newConversation();
    const local = v.ensureVoiceConversation();
    mirror = null;
    sent = 0;
    if (v.LOCAL_VOICE_TOOLS) {
      const vb = await import(/* @vite-ignore */ `${import.meta.env.BASE_URL}src/voiceBox.ts`);
      const box = await vb.boxVoice(useStore.getState().vaultPath);
      if (box) mirror = vb.voiceTranscriptMirror(box, local, from);
    }
  },
};

const idOf = (r: string | undefined): string => {
  try {
    return String(JSON.parse(r ?? "").conversationId ?? "");
  } catch {
    return "";
  }
};

const TASK =
  "Re-run the eval for seeds 42, 43 and 44 on the current checkpoints, rebuild the three-seed table in projects/bitnet-160m/writeup.md with the new numbers (mean ± std), and tell me if the mean moved by more than 0.005.";

const pause = (ms = 1200): Step => ({ sleep: ms });

// ---- voice in fullscreen chat ---------------------------------------------------
// The ElevenLabs session is scripted (adoptVoiceSessionForPreview): its levels
// come from the phase below (Carl talking → input, the agent → output), its
// uploads are kept in `uploads` (what the agent was shown). Lines land the way
// onMessage lands them, so the math pass runs for real against the fake model.

const FIG = "figs/loss-landscape.png";
let phase: "idle" | "user" | "agent" = "idle";
let voiceLine: ((role: "user" | "agent", text: string) => void) | null = null;
/** What the scripted conversation was sent: the note and the bytes, per image. */
const uploads: Array<{ text?: string; size: number }> = [];

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
  const files = new Map<string, number>();
  return {
    getInputByteFrequencyData: () => levels(phase === "user"),
    getOutputByteFrequencyData: () => levels(phase === "agent"),
    async uploadFile(b: Blob) {
      const id = `file-${files.size + 1}`;
      files.set(id, b.size);
      return { fileId: id };
    },
    sendMultimodalMessage(m: { text?: string; fileId: string }) {
      uploads.push({ text: m.text, size: files.get(m.fileId) ?? 0 });
    },
    sendContextualUpdate() {},
    sendUserMessage() {},
    setMicMuted() {},
    setVolume() {},
    async endSession() {},
  };
}

/** A small rendered figure (a loss landscape) written into the vault as a PNG. */
async function writeFigure(vault: string): Promise<void> {
  const c = document.createElement("canvas");
  c.width = 480;
  c.height = 320;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, c.width, c.height);
  for (let k = 9; k >= 1; k--) {
    g.beginPath();
    g.ellipse(200, 170, 22 * k, 11 * k, -0.2, 0, Math.PI * 2);
    g.fillStyle = `hsl(${210 + k * 14}, 70%, ${92 - k * 5}%)`;
    g.fill();
  }
  g.beginPath();
  g.arc(390, 90, 28, 0, Math.PI * 2);
  g.fillStyle = "hsl(20, 80%, 70%)";
  g.fill();
  g.fillStyle = "#333";
  g.font = "15px sans-serif";
  g.fillText("loss(α, β)", 16, 24);
  g.fillText("β →", 420, 306);
  g.fillText("α ↑", 12, 300);
  const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  const [dir, name] = [`${vault}/${FIG.split("/")[0]}`, FIG.split("/")[1]];
  await (window as any).__TAURI_INTERNALS__.invoke("write_binary_file_unique", { dir, name, bytes });
}

const vfsStart: Step = {
  run: async ({ vault }) => {
    phase = "idle";
    uploads.length = 0;
    (window as any).__vfsUploads = uploads;
    const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
    const v: any = await import(/* @vite-ignore */ "/src/voice-elevenlabs.ts");
    await writeFigure(vault);
    useStore.getState().newConversation();
    v.ensureVoiceConversation();
    // The before tree has no voice in fullscreen (no titlebar there, and Ctrl+D
    // lived in it): its lines land as plain text, as they would have been spoken.
    voiceLine = v.adoptVoiceSessionForPreview
      ? v.adoptVoiceSessionForPreview(scriptedConversation()).line
      : (role: string, text: string) => useStore.getState().appendMessage({ role: role === "user" ? "user" : "assistant", content: text });
  },
};

/** One scripted turn: Carl talks (input waves), tools run, the agent speaks (output waves), its line lands. */
const vfsTurn = (heard: string, calls: Array<[string, Record<string, unknown>]>, reply: string): Step[] => [
  { run: () => void (phase = "user") },
  { sleep: 1400 },
  {
    run: async () => {
      phase = "idle";
      voiceLine?.("user", heard);
      const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
      const v: any = await import(/* @vite-ignore */ "/src/voice-elevenlabs.ts");
      const h = v.buildClientToolHandlers();
      for (const [name, args] of calls) if (h[name]) await h[name](args);
      useStore.getState().setVoiceSpeaking(true);
      phase = "agent";
    },
  },
  { sleep: 1600 },
  {
    run: async () => {
      const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
      useStore.getState().setVoiceSpeaking(false);
      phase = "idle";
      voiceLine?.("agent", reply);
    },
  },
  { sleep: 900 },
];

const VFS = {
  u1: "so if the loss is alpha plus beta squared, what's the gradient with respect to beta?",
  a1: "It's two beta. The alpha term drops out, so the gradient is just two beta.",
  u2: "Pull up the loss landscape figure.",
  a2: "Here it is. The valley runs along beta equals zero, which matches that gradient.",
  u3: "What's this bump on the right?",
  a3: "That's a local maximum near theta sub one equals two; the descent steers around it.",
};

/** The display pass's answers (the fake model), per line. */
const VFS_MATH: Record<string, string> = {
  [VFS.u1]: "so if the loss is $\\alpha + \\beta^2$, what's the gradient with respect to $\\beta$?",
  [VFS.a1]: "It's $2\\beta$. The $\\alpha$ term drops out, so the gradient is just $2\\beta$.",
  [VFS.a2]: "Here it is. The valley runs along $\\beta = 0$, which matches that gradient.",
  [VFS.a3]: "That's a local maximum near $\\theta_1 = 2$; the descent steers around it.",
};

export const voiceScenarios: Scenario[] = [
  {
    id: "voice-fullscreen",
    title: "Voice in fullscreen chat — waves at the bottom, math rendered, it sees the image",
    group: "Voice · Fullscreen",
    notes:
      "Fullscreen chat (Ctrl+Shift+F), then voice — the composer's mic, or Ctrl+D, which now works in fullscreen too. The ElevenLabs side is scripted. After: the composer becomes a voice bar — the waves (Carl's input while he talks, the agent's output while it speaks), type, mute, End. Three turns: (1) “alpha plus beta squared…” — each line lands as spoken, then the display pass (the Background role's model, faked here) renders its math: α + β², 2β. The audio and the saved text stay as spoken. (2) “pull up the loss landscape figure” — ShowFile opens it; fullscreen has no viewer, so it shows in the thread, and the image goes to the voice conversation with a note (window.__vfsUploads lists what it was sent). (3) “what's this bump?” — LookAtScreen: the image is already in its context. Before: fullscreen had no voice (no titlebar mic, and Ctrl+D lived in the titlebar); the lines show as plain spoken text.",
    clock: "2026-10-13T10:00:00",
    build: (ctx) => P3.build(ctx),
    llm: {
      scripts: Object.entries(VFS_MATH).map(([line, out], i) => ({
        id: `voice-math-${i + 1}`,
        match: new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
        steps: [{ text: out, chunkMs: 4 }],
      })),
    },
    open: [
      { key: "ctrl+shift+F" },
      { wait: "[data-el='chats-sidebar']" },
      { sleep: 400 },
      vfsStart,
      { sleep: 600 },
      ...vfsTurn(VFS.u1, [], VFS.a1),
      ...vfsTurn(VFS.u2, [["ShowFile", { path: FIG }]], VFS.a2),
      ...vfsTurn(VFS.u3, [["LookAtScreen", {}]], VFS.a3),
      { sleep: 800 },
    ],
    surfaces: ["desktop"],
  },
  {
    id: "voice-box",
    title: "Voice on the box — its tools run there, long work goes to the agent",
    group: "Voice · Box",
    notes:
      "The ElevenLabs side is scripted (no mic in the preview). After: the session's lines are saved on the box as a voice conversation of its own (the thread moves to the box's id; open Chats: it is there, in BitNet 160M, like any chat). Plays three spoken turns in a fresh voice thread: (1) “what token budget does the writeup give?” — the agent reads the writeup; after: the Read runs on the box (“· on the box” on the marker, a box POST in the log). (2) “re-run the eval across the three seeds and update the table” — after: the agent hands it to the box's agent (AskAgent); a new running chat shows in Chats. The box finishes it. (3) “how's that going?” — AgentStatus reads the box chat's last reply. Before: every tool runs on the laptop and there is no AskAgent, so voice has to say it can't take the long job.",
    build: (ctx) => P3.build(ctx),
    host: (now) => ({
      sync: {
        box: BOX,
        boxChat: {
          convs: P2.boxConvsFor("voice-box", now) as any,
          live: true,
          voice: {
            results: {
              Read: "# BitNet 160M — writeup\n\n…Chinchilla's ~20 tokens per parameter gives ≈3.2B tokens for 160M; our runs used 1.7B, which matches the 0.13-nat gap.…",
            },
          },
          steps: [
            {
              append: { "v-agent-1": [{ role: "assistant", content: "Done. New three-seed table in writeup.md: 1.5571 / 1.5596 / 1.5580, mean 1.5582 ± 0.0010 — the mean moved by 0.0006, well under 0.005." }] },
              status: { "v-agent-1": "idle" },
              meta: { "v-agent-1": { state: "done", costUsd: 0.37 } },
              events: [{ type: "message", convId: "v-agent-1", role: "assistant" }, { type: "status", convId: "v-agent-1", status: "idle" }],
            },
          ],
        },
      },
    }),
    activeConversation: "p-seed44",
    open: [
      { file: NOTE },
      { chat: true },
      pause(800),
      startVoice,
      pause(600),
      voiceTurn("What token budget does the writeup say a 160M model should get?", [["Read", (_: string[], vault: string) => ({ path: `${vault}/${NOTE}` })]], (r) =>
        r[0] && !r[0].startsWith("Error") ? "Yeah — about 3.2 billion tokens, twenty per parameter. Your runs used 1.7 billion, which the writeup ties to the 0.13-nat gap." : "Hm, I couldn't read the writeup.",
      ),
      pause(1500),
      voiceTurn("Can you re-run the eval across all three seeds and update the table? Let me know if the mean moves.", [["AskAgent", { task: TASK, project: "BitNet 160M" }]], (r) =>
        idOf(r[0])
          ? "Sure — I've handed that to the agent on the box; it'll re-run the three seeds and rebuild the table. I'll check back with you when it's done."
          : "That's a long job — I can't run three evals from a voice call here. Start it in the chat and I'll help you read the results.",
      ),
      pause(1500),
      { click: CHATS },
      pause(2200),
      { key: "Escape" },
      pause(600),
      { run: () => (window as any).__preview?.boxNext?.() },
      pause(1500),
      voiceTurn("How's the eval going?", [["AgentStatus", (prev: string[]) => ({ conversationId: idOf(prev[0]) })]], (r) => {
        try {
          const s = JSON.parse(r[0] ?? "");
          return s.lastReply ? `It's ${s.state === "working" ? "still working" : "done"}. ${s.lastReply.replace(/^Done\. /, "")}` : `It's ${s.state}.`;
        } catch {
          return "There's nothing running for me to check on.";
        }
      }),
      pause(2000),
    ],
  },
];
