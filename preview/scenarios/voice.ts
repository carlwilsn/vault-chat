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
  },
});

/** A fresh voice thread, as the mic tap makes one. */
const startVoice: Step = {
  run: async () => {
    lastResults = [];
    const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
    const v: any = await import(/* @vite-ignore */ "/src/voice-elevenlabs.ts");
    useStore.getState().newConversation();
    v.ensureVoiceConversation();
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

export const voiceScenarios: Scenario[] = [
  {
    id: "voice-box",
    title: "Voice on the box — its tools run there, long work goes to the agent",
    group: "Voice · Box",
    notes:
      "The ElevenLabs side is scripted (no mic in the preview). Plays three spoken turns in a fresh voice thread: (1) “what token budget does the writeup give?” — the agent reads the writeup; after: the Read runs on the box (“· on the box” on the marker, a box POST in the log). (2) “re-run the eval across the three seeds and update the table” — after: the agent hands it to the box's agent (AskAgent); a new running chat shows in Chats. The box finishes it. (3) “how's that going?” — AgentStatus reads the box chat's last reply. Before: every tool runs on the laptop and there is no AskAgent, so voice has to say it can't take the long job.",
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
