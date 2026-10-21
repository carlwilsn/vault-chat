// Silence means idle (Carl, 2026-10-21: "I don't want to have to tell it over and over that I'm still
// working. It should just sit idle."). The voice agent as provisioned (src/voice-elevenlabs.ts
// buildAgentCreateBody, v30-idle) and prompted (src/voicePrompt.ts VOICE_SILENCE_RULE), run on a simulated
// ElevenLabs that follows the platform's documented turn-taking (never the real one):
//   - turn.turn_timeout: after this much silence the agent is re-engaged (docs: 1–30 s, no "off");
//   - skip_turn with params.wait_timeout_secs -1: after it, the agent stays silent until the caller speaks
//     (SkipTurnToolConfig);
//   - turn.soft_timeout_config: the filler while waiting for the model's response, once per response
//     (max_soft_timeouts_per_generation), never before the first user message
//     (disable_until_first_user_message);
//   - turn.silence_end_call_timeout: -1 never ends the call on silence (a TurnConfig field);
//   - a contextual update never triggers a response; a user message does.
// The model is faked: it follows the prompt's silence rule when the prompt has it (and checks in when it
// doesn't, as models do — the control that shows the simulation can fail).
// Plus the client: the box's updates during silence ([vc:context] stays silent, a [vc:result] waits until
// Carl isn't mid-speech) and the mic health detector over a long quiet spell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-voiceidle-");
installFakeTauri(vault);

const voice = await import("../../src/voice-elevenlabs.ts");
const P = await import("../../src/voicePrompt.ts");
const H = await import("../../src/voiceHealth.ts");
const { QuietGate } = await import("../../src/voiceQuiet.ts");
const { VoiceUpdates } = await import("../../src/voiceFront.ts");

const body = (device: "laptop" | "phone" | "board" = "board"): any =>
  voice.buildAgentCreateBody({ llm: "gpt-6-luna", info: null, tools: P.voiceToolDefs(device), voiceId: "v1" });

// ---- the config, exactly -------------------------------------------------------
test("config: the longest re-engage ElevenLabs allows, skip_turn silent until he speaks, no hang-up on silence, the filler only after his first line", () => {
  const cc = body().conversation_config;
  assert.equal(cc.turn.turn_timeout, 30, "the documented maximum (1–30 s)");
  assert.equal(cc.turn.initial_wait_time, undefined, "unset: the start waits turn_timeout too");
  assert.equal(cc.turn.silence_end_call_timeout, -1, "in turn (TurnConfig), where ElevenLabs reads it");
  assert.equal(cc.conversation.silence_end_call_timeout, undefined, "not a ConversationConfig field");
  assert.equal(cc.conversation.max_duration_seconds, 7200);
  assert.deepEqual(cc.turn.soft_timeout_config, {
    timeout_seconds: 3,
    message: "One sec.",
    use_llm_generated_message: false,
    max_soft_timeouts_per_generation: 1,
    disable_until_first_user_message: true,
  });
  assert.equal(cc.turn.retranscribe_on_turn_timeout, undefined);
  for (const device of ["laptop", "phone", "board"] as const) {
    const tools = body(device).conversation_config.agent.prompt.tools;
    const skip = tools.find((t: any) => t.name === "skip_turn");
    assert.deepEqual(skip, { type: "system", name: "skip_turn", description: "", params: { system_tool_type: "skip_turn", wait_timeout_secs: -1 } }, device);
    assert.ok(!tools.some((t: any) => t.name === "end_call"), "no end_call: it hung up on study silences");
  }
});

test("prompt: the silence rule is always there, under any header (a vault's voice.md replaces only the header)", () => {
  for (const header of ["", "You are my custom voice."]) {
    for (const device of ["laptop", "phone", "board"] as const) {
      const prompt = P.buildVoicePrompt({ device, header });
      assert.ok(prompt.includes(P.VOICE_SILENCE_RULE), `${device} / ${header || "default"}`);
    }
  }
  const r = P.VOICE_SILENCE_RULE;
  assert.match(r, /call skip_turn and say nothing at all\. Every time/);
  assert.match(r, /\[vc:context\] updates .* never answer them aloud and never take a turn for them/);
  assert.match(r, /A \[vc:result\] or \[vc:question\] is different/);
  assert.match(r, /Never end, wind down/);
  assert.doesNotMatch(P.DEFAULT_VOICE_PROMPT_HEADER, /skip_turn/, "not in the replaceable header any more");
});

// ---- a simulated ElevenLabs ----------------------------------------------------
type Said = { at: number; text: string; why: "reply" | "filler" | "reengage" | "result" | "check-in" };
type Turn = { kind: "user" | "result" | "reengage"; text?: string };
/** What the fake model does with a turn: its latency and either speech or a tool call. */
type Model = (t: Turn, prompt: string) => { ms: number; say?: string; tool?: string };

class SimElevenLabs {
  now = 0;
  said: Said[] = [];
  tools: { at: number; name: string }[] = [];
  context: string[] = [];
  ended: { at: number; why: string } | null = null;
  private lastActivity = 0;
  private lastUserAt = 0;
  private userLines = 0;
  /** After skip_turn (wait_timeout_secs -1): silent until the caller speaks. */
  private waitingForCaller = false;
  private pending: { turn: Turn; doneAt: number; out: { say?: string; tool?: string }; fillers: number; startedAt: number } | null = null;
  private checkInAt: number | null = null;
  /** Carl is talking (the meter the client reads). */
  carlTalking = false;

  constructor(
    private cc: any,
    private prompt: string,
    private model: Model,
  ) {}

  private get turn() {
    return this.cc.turn;
  }
  private request(turn: Turn): void {
    const r = this.model(turn, this.prompt);
    this.pending = { turn, doneAt: this.now + r.ms, out: r, fillers: 0, startedAt: this.now };
  }
  /** Carl says a line (a user transcript). */
  userSays(text: string): void {
    this.userLines++;
    this.lastUserAt = this.now;
    this.lastActivity = this.now;
    this.waitingForCaller = false;
    this.checkInAt = null;
    this.request({ kind: "user", text });
  }
  // The SDK's conversation, as the client's update loop uses it.
  sendContextualUpdate(text: string): void {
    this.context.push(text); // documented: informs the model, never triggers a response
  }
  sendUserMessage(text: string): void {
    this.lastActivity = this.now;
    this.request({ kind: "result", text });
  }
  getInputVolume(): number {
    return this.carlTalking ? 0.3 : 0;
  }

  /** Advance the clock in 100 ms steps. */
  run(ms: number): void {
    const end = this.now + ms;
    while (this.now < end && !this.ended) {
      this.now += 100;
      this.step();
    }
  }
  private step(): void {
    const t = this.turn;
    const silenceEnd = Number(t.silence_end_call_timeout ?? -1);
    if (silenceEnd > 0 && this.now - this.lastUserAt >= silenceEnd * 1000) {
      this.ended = { at: this.now, why: "silence_end_call_timeout" };
      return;
    }
    if (this.now >= Number(this.cc.conversation?.max_duration_seconds ?? 600) * 1000) {
      this.ended = { at: this.now, why: "max_duration_seconds" };
      return;
    }
    const p = this.pending;
    if (p) {
      const soft = t.soft_timeout_config ?? {};
      const fillerOn = Number(soft.timeout_seconds ?? -1) > 0 && !(soft.disable_until_first_user_message && this.userLines === 0);
      if (fillerOn && p.fillers < Number(soft.max_soft_timeouts_per_generation ?? 1) && this.now - p.startedAt >= Number(soft.timeout_seconds) * 1000 * (p.fillers + 1) && this.now < p.doneAt) {
        p.fillers++;
        this.said.push({ at: this.now, text: soft.message ?? "Hhmmmm...yeah.", why: "filler" });
      }
      if (this.now >= p.doneAt) {
        this.pending = null;
        this.lastActivity = this.now;
        if (p.out.tool) {
          this.tools.push({ at: this.now, name: p.out.tool });
          if (p.out.tool === "skip_turn") {
            const skip = (this.cc.agent.prompt.tools ?? []).find((x: any) => x.name === "skip_turn");
            const wait = Number(skip?.params?.wait_timeout_secs ?? -1);
            if (wait === -1) this.waitingForCaller = true;
            else this.checkInAt = this.now + wait * 1000;
          }
        }
        if (p.out.say) this.said.push({ at: this.now, text: p.out.say, why: p.turn.kind === "reengage" ? "reengage" : p.turn.kind === "result" ? "result" : "reply" });
      }
      return;
    }
    if (this.checkInAt !== null && this.now >= this.checkInAt) {
      this.checkInAt = null;
      this.said.push({ at: this.now, text: "Just checking in — still there?", why: "check-in" });
      this.lastActivity = this.now;
      return;
    }
    if (this.waitingForCaller || this.checkInAt !== null) return;
    const wait = this.userLines === 0 && t.initial_wait_time != null ? Number(t.initial_wait_time) : Number(t.turn_timeout ?? 7);
    if (wait > 0 && this.now - this.lastActivity >= wait * 1000) this.request({ kind: "reengage" });
  }
}

/** A model that does what the prompt says: skip_turn on a re-engage when the silence rule is there (else it checks in). */
const obedient: Model = (t, prompt) => {
  if (t.kind === "reengage") return prompt.includes(P.VOICE_SILENCE_RULE) ? { ms: 700, tool: "skip_turn" } : { ms: 700, say: "Are you still there?" };
  if (t.kind === "result") return { ms: 900, say: "The agent says it's 91." };
  return { ms: 4_000, say: "Right, that's the chain rule." }; // a slow reply to Carl: the filler's case
};

const MIN = 60_000;
const boardPrompt = () => P.buildVoicePrompt({ device: "board" });

test("5 minutes of silence from the start: no speech, one tool call (skip_turn), the call stays open", () => {
  const sim = new SimElevenLabs(body().conversation_config, boardPrompt(), obedient);
  sim.run(5 * MIN);
  assert.deepEqual(sim.said, [], "nothing said: no check-in, no filler");
  assert.deepEqual(sim.tools.map((x) => x.name), ["skip_turn"], "the one re-engage at 30 s, answered silently");
  assert.equal(sim.tools[0]!.at, 30_700);
  assert.equal(sim.ended, null);
});

test("after a conversation, 5 minutes of silence: only skip_turn, and the filler only on his line", () => {
  const sim = new SimElevenLabs(body().conversation_config, boardPrompt(), obedient);
  sim.run(2_000);
  sim.userSays("why does the derivative of sine give cosine");
  sim.run(5_000);
  assert.deepEqual(sim.said.map((s) => s.why), ["filler", "reply"], "his line, a slow model: the filler, then the reply");
  assert.equal(sim.said[0]!.at, 5_000, "3 s after his line");
  const before = sim.said.length;
  sim.run(5 * MIN);
  assert.deepEqual(sim.said.slice(before), [], "5 minutes of his silence: not a word");
  assert.deepEqual(sim.tools.map((x) => x.name), ["skip_turn"]);
  assert.ok(sim.tools.every((x) => x.name === "skip_turn"));
  assert.equal(sim.ended, null);
  // He speaks again: the voice answers (skip_turn waited for exactly this).
  sim.userSays("ok and tangent?");
  sim.run(5_000);
  assert.deepEqual(sim.said.slice(before).map((s) => s.why), ["filler", "reply"]);
});

test("context updates during silence (board, focus, screen) are never answered aloud", async () => {
  const sim = new SimElevenLabs(body().conversation_config, boardPrompt(), obedient);
  const gate = new QuietGate(() => false, 0);
  let n = 0;
  const pages = [
    { id: "c1", kind: "context", speak: false, text: "[vc:context] Carl wrote on the board: d/dx sin x = cos x." },
    { id: "y1", kind: "you", speak: false, text: "[vc:context] What Carl just did on his other surfaces: opened lecture 7, page 3." },
    { id: "c2", kind: "context", speak: false, text: "[vc:context] Carl typed in the chat. The agent answered there. Already answered: don't answer it aloud." },
  ];
  const u = new VoiceUpdates({
    cursor: "0:0",
    gate,
    conv: () => sim,
    userSpeaking: () => sim.carlTalking,
    fetch: async () => {
      await new Promise((r) => setTimeout(r, 5));
      const p = pages[n++];
      return { cursor: String(n), updates: p ? [p] : [] };
    },
  }).start();
  // The updates arrive spread over the silence.
  for (let i = 0; i < 10; i++) {
    sim.run(30_000);
    await new Promise((r) => setTimeout(r, 10));
  }
  u.stop();
  assert.equal(sim.context.length, 3, "every update reached the voice");
  assert.deepEqual(sim.said, [], "and none was answered");
  assert.deepEqual(sim.tools.map((x) => x.name), ["skip_turn"]);
});

test("a [vc:result] he is waiting for is spoken — once he isn't mid-sentence", async () => {
  const sim = new SimElevenLabs(body().conversation_config, boardPrompt(), obedient);
  const gate = new QuietGate(() => false, 0);
  const u = new VoiceUpdates({ cursor: "0:0", gate, conv: () => sim, userSpeaking: () => sim.carlTalking, quietMs: 60, pollMs: 10, fetch: () => new Promise(() => {}) });
  sim.carlTalking = true;
  u.deliver({ id: "r1", kind: "result", speak: true, text: "[vc:result] The agent answered: 91." });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(u.delivered.length, 0, "held while he talks");
  sim.carlTalking = false;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(u.delivered.length, 0, "not in the gap between two words");
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(u.delivered.map((x) => x.id), ["r1"], "delivered once he has been quiet");
  sim.run(2_000);
  assert.deepEqual(sim.said.map((s) => s.why), ["result"]);
  u.stop();
});

test("no idle hang-up: an hour and a half of silence leaves the call open", () => {
  const sim = new SimElevenLabs(body().conversation_config, boardPrompt(), obedient);
  sim.userSays("I'm going to work through problem 4");
  sim.run(90 * MIN);
  assert.equal(sim.ended, null);
  assert.deepEqual(sim.tools.map((x) => x.name), ["skip_turn"]);
  assert.equal(sim.said.filter((s) => s.why !== "filler" && s.why !== "reply").length, 0);
});

test("control: the old setup (skip_turn without its wait, the rule out of the prompt) would nag — the simulation can fail", () => {
  const cc = body().conversation_config;
  const old = structuredClone(cc);
  old.agent.prompt.tools = old.agent.prompt.tools.map((t: any) => (t.name === "skip_turn" ? { ...t, params: { system_tool_type: "skip_turn", wait_timeout_secs: 60 } } : t));
  const noRule = new SimElevenLabs(old, "You are a voice.", obedient);
  noRule.run(5 * MIN);
  assert.ok(noRule.said.filter((s) => s.why === "reengage").length >= 5, "a model without the rule checks in every 30 s");
  const withWait = new SimElevenLabs(old, boardPrompt(), obedient);
  withWait.run(5 * MIN);
  assert.ok(withWait.said.some((s) => s.why === "check-in"), "a skip_turn with a wait checks in after it");
  const filler = structuredClone(cc);
  filler.turn.soft_timeout_config.disable_until_first_user_message = false;
  const slowStart = new SimElevenLabs(filler, boardPrompt(), (t, p) => (t.kind === "reengage" ? { ms: 4_000, tool: "skip_turn" } : obedient(t, p)));
  slowStart.run(2 * MIN);
  assert.deepEqual(slowStart.said.map((s) => s.text), ["One sec."], "without disable_until_first_user_message a slow re-engage at the start says the filler");
  const ours = new SimElevenLabs(cc, boardPrompt(), (t, p) => (t.kind === "reengage" ? { ms: 4_000, tool: "skip_turn" } : obedient(t, p)));
  ours.run(2 * MIN);
  assert.deepEqual(ours.said, [], "with it: silent");
});

// ---- the mic health detector over a long quiet spell ------------------------------
test("health: 5 minutes of silence (a live mic reading zero, room noise, a pencil's taps) — no verdict at all", () => {
  const ev: any[] = [];
  const h = new H.VoiceHealth((e) => ev.push(e));
  h.connected(0);
  h.userTranscript(1_000); // he said something, then went quiet to write
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let t = 1_100; t <= 5 * MIN; t += 100) {
    const minute = Math.floor(t / MIN);
    // Minute 0–1: noise suppression reads exact zero. 2–3: low room tone. 4: taps (short bursts over speech level).
    const input = minute < 2 ? 0 : minute < 4 ? 0.005 + rnd() * 0.01 : rnd() < 0.08 ? 0.06 : 0.004;
    h.sample({ now: t, input, output: 0, muted: false, speaking: false, trackLive: true });
  }
  assert.deepEqual(ev, [], "no mic-dead, no mic-unheard");
  // Before he ever spoke, too.
  const ev2: any[] = [];
  const h2 = new H.VoiceHealth((e) => ev2.push(e));
  h2.connected(0);
  for (let t = 100; t <= 5 * MIN; t += 100) h2.sample({ now: t, input: t % 20_000 < 300 ? 0.06 : 0, output: 0, muted: false, speaking: false, trackLive: true });
  assert.deepEqual(ev2, []);
  // A track that stopped delivering (muted by its source) still reads as dead.
  const ev3: any[] = [];
  const h3 = new H.VoiceHealth((e) => ev3.push(e));
  h3.connected(0);
  for (let t = 100; t <= 10_000; t += 100) h3.sample({ now: t, input: 0, output: 0, muted: false, speaking: false, trackLive: false });
  assert.deepEqual(ev3.map((e) => e.kind), ["mic-dead"]);
});

test("the filler said into his silence is told apart (and logged on the laptop): only a slow reply to his line earns it", async () => {
  const { FillerWatch } = await import("../../src/voiceTimeout.ts");
  const w = new FillerWatch();
  assert.equal(w.agentLine(true), true, "before he has said anything: into his silence");
  w.userLine();
  assert.equal(w.agentLine(true), false, "after his line: the filler's job");
  assert.equal(w.agentLine(false), false);
  assert.equal(w.agentLine(true), true, "after the voice answered, with no new line of his: into his silence");
  w.userLine();
  assert.equal(w.agentLine(true), false);
});
