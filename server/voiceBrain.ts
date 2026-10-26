// Voice with one brain (VC_VOICE_BRAIN=pi). The call's ears and mouth are a
// box-hosted Pipecat pipeline (voice-pipeline/bot.py: WebRTC from the device
// over the tailnet, Silero VAD + Smart Turn v3, ElevenLabs STT and TTS called
// outbound); its brain is the conversation's own pi agent. Nothing is public:
// the pipeline reaches this server on loopback only.
//
//   device ──WebRTC (tailnet)──▶ bot.py ──STT──▶ "Carl said X"
//        POST /v1/chat/completions (loopback, the call's token)
//          → engine.message(convId, X): a turn of THE conversation, on the
//            talker model while the call is live; pi's text deltas stream
//            back as completion chunks, cut into speakable sentences.
//   Anything else the conversation says during the call (a typed turn, a
//   Delegate result's turn) streams to the pipeline's speak channel
//   (GET /api/v1/brain/call/<id>/speak, SSE) and is spoken the same way.
//
// One record: every line, typed or spoken, is a turn of the pi session; the
// pipeline keeps no memory of its own (it sends only Carl's newest words).
// Slow work goes to Delegate (a background pi subagent) and comes back as a
// turn of the conversation; the waiting-on line reads meta.subagents.
//
// Routes:
//   POST /api/v1/brain/call            {convId, device}         → {callId, model}         (any authorised client)
//   POST /api/v1/brain/offer           {callId, sdp, type}      → {sdp, type, pc_id}      (proxied to the pipeline)
//   POST /api/v1/brain/call/<id>/end                            → {ok}
//   GET  /api/v1/brain/calls                                    → the live calls (diagnostics)
//   POST /v1/chat/completions          OpenAI-compatible, SSE   (loopback + the call's token only)
//   GET  /api/v1/brain/call/<id>/speak SSE {text, turn}        (loopback + the call's token only)
import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Speakable } from "./speakable";
import { speechReady } from "./speakMath";
import { calibFrom } from "../src/voiceWaitLine";

export type BrainEngine = {
  message(b: { convId?: string | null; text?: string; context?: string; source?: string; via?: string; client?: string; clientMsgId?: string; continues?: boolean; unqueue?: string }): Promise<Record<string, unknown> | null>;
  setTalker(convId: string, t: { model: string; rules: string; thinking?: string } | null): void;
  tap(convId: string, fn: (ev: any) => void): () => void;
  isRunning(convId: string): boolean;
  interrupt(convId: string, byUser: boolean): Promise<boolean>;
  /** Stop the running turn and the work started since `since` (his previous line; server/engine stopWork). */
  stopWork?(convId: string, since?: number, stopped?: string[]): Promise<number>;
  /** What a voice on the conversation waits on (the waiting line's inputs). */
  waitInputs?(convId: string): { works: unknown[]; plan: unknown; samples: Record<string, number[]>; running?: boolean } | null;
};

export type BrainDeps = {
  vault: string;
  engine: () => Promise<BrainEngine>;
  /** The box's ElevenLabs key (the key store); never logged. */
  elKey: () => string | null;
  voiceId: () => string;
  /** Where the pipeline listens (loopback). */
  botUrl: string;
  /** This server, as the pipeline reaches it (loopback). */
  selfUrl: string;
  /** Where brain.jsonl goes (one line per spoken turn: the latency figures). */
  logDir: string | null;
  /** Where the voice engine choice is kept (Settings → Voice engine: every device follows the box's). */
  stateDir?: string | null;
  /** The engine changed (the server starts or stops the pipeline: server/voicePipeline.ts). */
  onEngine?: (e: VoiceEngine) => void;
};

/** The routes are on unless the box turns them off; which voice a device uses is the engine setting below. */
/** A whole utterance that means "stop what you're doing" (never a sentence that merely contains "stop"). */
// "Stop" / "never mind" as he says it: the line opens with it (after a filler: "actually, never mind that", "nah forget it",
// "no, wait, stop") and it is the clause, ending there or before a pause or a new clause ("never mind, I found it",
// "stop, I got it", "never mind I found it"). Never when it takes an object ("never mind the second part, do the
// first", "stop the timer", "cancel my 3pm") or isn't at the start ("I don't mind", "don't stop").
const STOP_FILLER = String.raw`(?:(?:actually|oh|ok(?:ay)?|nah|no|nope|wait|um+|uh+|hey|so|right|alright|well|sorry)[,.!]?\s+)*`;
const STOP_PHRASE = String.raw`(?:stop(?: (?:it|that|now))?|never ?mind(?: (?:that|it))?|cancel(?: (?:it|that))?|forget (?:it|that|about it)|scratch that|don'?t bother|(?:you can|please) stop(?: now)?|no need|don'?t worry about it)`;
const STOP_END = String.raw`(?:$|[,.!;?\u2014\u2013-]|\s+(?:i|i'm|i've|i'll|we|thanks|thank you)\b)`;
export const STOP_RE = new RegExp(String.raw`^\s*` + STOP_FILLER + STOP_PHRASE + String.raw`(?:,?\s*please)?\s*` + STOP_END, "i");

/** The same words again within this long, with no new line from Carl in the pipeline's context, are the pipeline
 * re-asking, never a second turn. A new line with the same words is Carl asking again (he didn't catch it): answered. */
export const REASK_MS = 10_000;

export const brainEnabled = (): boolean => process.env.VC_VOICE_BRAIN !== "off";

export type VoiceEngine = "classic" | "new";
const engineFile = (d: { stateDir?: string | null }) => (d.stateDir ? join(d.stateDir, "voice-engine.json") : null);
/** The box's voice engine: "new" (one brain, the box's pipeline) or "classic" (ElevenLabs' agent). Classic until chosen. */
export function voiceEngine(d: { stateDir?: string | null }): VoiceEngine {
  const f = engineFile(d);
  if (!f) return "classic";
  try {
    return JSON.parse(readFileSync(f, "utf8"))?.engine === "new" ? "new" : "classic";
  } catch {
    return "classic";
  }
}
function setVoiceEngine(d: { stateDir?: string | null }, e: VoiceEngine): boolean {
  const f = engineFile(d);
  if (!f) return false;
  mkdirSync(d.stateDir!, { recursive: true });
  writeFileSync(f, JSON.stringify({ engine: e, at: new Date().toISOString() }));
  return true;
}
/** Is the pipeline up (its /health on loopback, 1.5 s)? */
async function pipelineUp(d: BrainDeps): Promise<boolean> {
  try {
    const r = await fetch(`${d.botUrl}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}
/** The talker: a fast model for turns while a call is live (the conversation's own model does the delegated work). */
export const talkerModel = (): string => process.env.VC_VOICE_TALKER_MODEL || "anthropic/claude-haiku-5.5";
/** The talker's thinking (pi's levels: off, minimal, low, medium, high): a spoken reply wants little. */
export const talkerThinking = (): string => process.env.VC_VOICE_TALKER_THINKING || "off";

type Device = "laptop" | "board" | "phone";
const DEVICES: Device[] = ["laptop", "board", "phone"];

/** What pi is told once, in front of the call's first turn (it stays in the session). */
export function voiceCallRules(device: Device): string {
  const where = device === "board" ? "his iPad board" : device === "phone" ? "his phone" : "his laptop";
  // One reply, written as always (markdown); the voice reads it aloud as written (server/speakable.ts). Only a light
  // nudge on length, and the one rule a live call needs: slow work goes to Delegate, so the voice never goes quiet.
  return `[A voice call is live on ${where}: your replies are shown as always and also read aloud as written. Keep them short: two or three spoken sentences answer what he asked (offer more, don't give it); when he is thinking aloud rather than asking, a line at most. A lookup in his notes is one Lookup {query} call (it finds and reads together); independent calls go at once, not one after another. Anything that takes more than a few seconds — making, changing or rebuilding a file (a PDF, a sheet, a page) always does, and a change to a source includes rebuilding what is built from it (the PDF he reads) — goes to Delegate {title, task, expect: "short" or "long"}: say in a line that you've sent it and carry on; its report comes back to you as a "Delegated work finished" turn, then tell him the result. Say something was done only when it was.]`;
}

// ---------------------------------------------------------------- calls

type Sink = {
  res: ServerResponse;
  id: string;
  sent: number;
  t0: number;
  tFirst: number | null;
  tDelta: number | null;
  deltas: number;
  text: string;
  created: number;
  done: boolean;
  /** An opener ("Yo.", "Okay, cool."): its reply waits until then in `queued`, so the rest of his line can still come. */
  holdUntil?: number;
  queued?: string[];
  flushT?: NodeJS.Timeout;
  /** The turn ended while its reply was still held: the response ends when it is written. */
  endAfter?: boolean;
};

type Call = {
  id: string;
  token: Buffer;
  vault: string;
  convId: string;
  device: Device;
  model: string;
  startedAt: number;
  /** The completion request now answering (the pipeline's LLM call for what Carl just said). */
  sink: Sink | null;
  /** The rest of an interrupted reply is not spoken (until the next request or the turn's end). */
  dropping: boolean;
  /** The running turn is this call's to speak: its own lines, a typed line on its own device, its work's results.
   *  A reply to something typed on another surface is that surface's (one context, each surface its own exchange). */
  ownTurn: boolean;
  /** Text since the last cut (spoken form), one per turn. */
  speak: Speakable;
  /** The pipeline's speak channel(s). */
  channels: Set<ServerResponse>;
  untap: () => void;
  engine: BrainEngine;
  turns: number;
  /** The turn now speaking (counts pi's turns on the call): the speak channel's pieces of one result share it, so the
   *  pipeline waits for a gap once, at the result's start, then says its pieces back to back. */
  utt: number;
  /** The last words sent to pi, and when (the same words again at once are a re-ask, not a new turn). */
  lastText: { text: string; at: number; lines: number; endedAt?: number } | null;
  /** Its last request or speak-channel activity (a call whose pipeline died without ending it is reaped). */
  lastActive: number;
  /** A barge-in stopped the turn that was talking: the next request waits for it to end. */
  stopping: Promise<unknown> | null;
  /** His line was cut off by more of his own words before anything was said (a pause mid-thought ended the turn):
   *  what that turn says is held, not spoken — if he went on, it answered half a thought and is dropped (the chat keeps
   *  it); if no words follow (a noise cut it), it is said after HOLD_MS. Only the turn running at the cut (`utt`). */
  held: { utt: number; pieces: string[]; timer: NodeJS.Timeout } | null;
  /** The text now streaming answers his newest words: false from a steer until pi delivers it (what comes before is
   *  the answer to the words he went on from). */
  armed: boolean;
  /** He asked not to be told the answers ("don't spoil it"): every line of his carries that, until he lifts it. */
  noSpoil: boolean;
  /** His last line, sent as a steer pi has not delivered yet: the rest of it (after a pause) is joined to it, one line. */
  steer: { clientId: string; text: string } | null;
};

/** A reply to words he went on from is held this long for his next words before it is said after all. */
export const HOLD_MS = 2_500;
/** The reply to an opener ("Yo.", "Okay, cool.", "Hmm.": three words or fewer, no question) starts this long after
 *  his line at the earliest — the rest of what he is saying usually follows (the roleplay: "Yo." got "Hey Carl, what
 *  do you need?" spoken 1.7 s in, cut by the rest of his line). */
export const OPENER_MS = 1_200;
export const isOpener = (text: string): boolean => {
  const t = text.trim();
  return !!t && t.split(/\s+/).length <= 3 && !/\?\s*$/.test(t) && !STOP_RE.test(t);
};
/** "Don't spoil it" (and the like) asks for no answers until he lifts it ("just tell me", "next question"). */
export const NO_SPOIL_RE = /\b(?:don'?t|do not|no)\s+spoil|\bdon'?t (?:give|tell) me the (?:answer|rest)|\bwithout (?:your|any) help\b|\btrying to (?:do|work out|figure out) (?:it|this|that|the rest) (?:myself|on my own)\b/i;
export const SPOIL_OK_RE = /\b(?:you can spoil it|spoil it now|just tell me|tell me the answer|give me the answer|show me the (?:answer|solution)|next (?:question|problem)|new problem|(?:question|problem) (?:two|three|four|five|[2-9])\b|part (?:b|c|d|two|three)\b)/i;
/** Him thinking aloud, not asking (a long line, no question, no request): one short line back at most, or nothing.
 *  The call rules ask for that once; Haiku drifted to 70 s replies, so each such line carries it. */
export const THINKING_ALOUD_NOTE =
  "[He is thinking aloud, not asking: answer in one short spoken line at most — agree, or flag the one thing that is wrong — or say nothing.]";
const REQUEST_RE = /\?|\b(?:can|could|would|will) you\b|\bplease\b|^(?:\W*\w+\W+){0,3}?(?:make|send|find|show|read|open|give|check|write|draw|put|look|tell|explain|summari[sz]e|build|fix|delete|start|stop|help)\b|\b(?:what|how|why|where|which|who|when)\b|\b(?:right|correct|yeah)\s*[?.!]*\s*$/i;
export const isThinkingAloud = (text: string): boolean => {
  const t = text.trim();
  return t.split(/\s+/).length >= 12 && !REQUEST_RE.test(t);
};
export const NO_SPOIL_NOTE =
  "[He asked not to be told the answers (\"don't spoil it\"), and that holds until he lifts it: confirm or correct only what he just said (look the problem up to check it: that is not spoiling), and ask him what comes next; never state the next step, a later value or the answer.]";

const calls = new Map<string, Call>();
/** A call with no request and no open speak channel for this long is over (its pipeline died without ending it). */
export const CALL_IDLE_MS = 15 * 60_000;
let reaper: NodeJS.Timeout | null = null;
function reapLater(d: { logDir: string | null }): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const c of [...calls.values()]) if (!c.channels.size && !c.sink && now - c.lastActive > CALL_IDLE_MS) endCall(d, c.id, "idle");
    if (!calls.size && reaper) {
      clearInterval(reaper);
      reaper = null;
    }
  }, 60_000);
  reaper.unref?.();
}
const callByConv = new Map<string, string>();

const rid = (n = 9) => randomBytes(n).toString("base64url");

function log(d: BrainDeps | { logDir: string | null }, o: Record<string, unknown>): void {
  if (!d.logDir) return;
  try {
    mkdirSync(d.logDir, { recursive: true });
    appendFileSync(join(d.logDir, "brain.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
  } catch {
    /* logging never breaks a call */
  }
}

/** Start a call on `convId`: its turns go to the talker model, its pi events to the call. One call per conversation. */
export async function startCall(d: BrainDeps, b: { convId?: unknown; device?: unknown; model?: unknown; thinking?: unknown }): Promise<{ status: number; body: Record<string, unknown> }> {
  const convId = typeof b.convId === "string" ? b.convId.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(convId)) return { status: 400, body: { error: "convId required" } };
  const device: Device = DEVICES.includes(b.device as Device) ? (b.device as Device) : "phone";
  // One voice at a time on a conversation: a new call replaces the old one.
  const old = callByConv.get(convId);
  if (old) endCall(d, old, "replaced");
  const engine = await d.engine();
  await speechReady();
  const token = randomBytes(32);
  const call: Call = {
    id: `bc-${Date.now().toString(36)}-${rid(4)}`,
    token,
    vault: d.vault,
    convId,
    device,
    // A call may name its talker (measurements, Settings); else the box's.
    model: typeof b.model === "string" && /^[\w.~:/-]{3,80}$/.test(b.model) ? b.model : talkerModel(),
    startedAt: Date.now(),
    sink: null,
    dropping: false,
    ownTurn: true,
    speak: new Speakable(),
    channels: new Set(),
    untap: () => {},
    engine,
    turns: 0,
    utt: 0,
    held: null,
    armed: true,
    steer: null,
    noSpoil: false,
    lastText: null,
    lastActive: Date.now(),
    stopping: null,
  };
  const thinking = typeof b.thinking === "string" && /^(off|minimal|low|medium|high)$/.test(b.thinking) ? b.thinking : talkerThinking();
  engine.setTalker(convId, { model: call.model, rules: voiceCallRules(device), thinking });
  call.untap = engine.tap(convId, (ev) => onPi(d, call, ev));
  calls.set(call.id, call);
  reapLater(d);
  callByConv.set(convId, call.id);
  log(d, { ev: "call.start", call: call.id, convId, device, model: call.model });
  return { status: 200, body: { ok: true, callId: call.id, model: call.model, token: token.toString("base64url") } };
}

export function endCall(d: { logDir: string | null }, id: string, why = "ended"): boolean {
  const c = calls.get(id);
  if (!c) return false;
  calls.delete(id);
  if (callByConv.get(c.convId) === id) callByConv.delete(c.convId);
  c.untap();
  if (c.held) clearTimeout(c.held.timer);
  c.engine.setTalker(c.convId, null);
  if (c.sink) finishSink(c, c.sink);
  for (const ch of c.channels) ch.end();
  log(d, { ev: "call.end", call: id, why, turns: c.turns, ms: Date.now() - c.startedAt });
  return true;
}

export function liveCalls(): Record<string, unknown>[] {
  return [...calls.values()].map((c) => ({ id: c.id, convId: c.convId, device: c.device, model: c.model, sinceMs: Date.now() - c.startedAt, turns: c.turns, channels: c.channels.size }));
}

/** [tests] */
export function resetBrainForTests(): void {
  for (const id of [...calls.keys()]) endCall({ logDir: null }, id, "reset");
}

function callOf(req: IncomingMessage, id?: string): Call | null {
  const h = String(req.headers.authorization ?? "");
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) return null;
  const given = Buffer.from(m[1]!, "base64url");
  const pool = id ? [calls.get(id)].filter(Boolean) as Call[] : [...calls.values()];
  for (const c of pool) if (given.length === c.token.length && timingSafeEqual(given, c.token)) return c;
  return null;
}

// ---------------------------------------------------------------- pi's events → speech

function onPi(d: BrainDeps, c: Call, ev: any): void {
  if (ev?.type === "vc_delivered" && c.steer?.clientId === ev.clientId) c.steer = null;
  if (ev?.type === "vc_delivered" || (ev?.type === "message_start" && ev.message?.role === "user")) {
    // pi delivered a message (his steer): what streams from here answers it.
    if (!c.armed) c.speak.flush();
    c.armed = true;
    return;
  }
  if (ev?.type === "vc_turn_start") {
    c.utt++;
    c.steer = null;
    if (!c.armed) c.speak.flush();
    c.armed = true;
    const origin = typeof ev.origin === "string" ? ev.origin : null;
    c.ownTurn = ev.kind !== "user" || !origin || origin === "voice" || origin === c.device;
    if (!c.ownTurn) log(d, { ev: "turn.other-surface", call: c.id, origin });
    return;
  }
  if (ev?.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
    if (c.sink && !c.sink.done) {
      c.sink.tDelta ??= Date.now();
      c.sink.deltas++;
    }
    say(c, c.speak.push(String(ev.assistantMessageEvent.delta ?? "")));
  } else if (ev?.type === "message_end" && ev.message?.role === "assistant") {
    // An assistant message ended (before its tool calls, or the turn's last): what is left of it is a sentence.
    say(c, c.speak.flush());
  } else if (ev?.type === "tool_execution_start") {
    // Whether the reply said anything before reaching for a tool (nothing is said for it; the waiting line covers the wait):
    // counted from this log.
    if (c.sink && !c.sink.done) {
      log(d, { ev: "turn.tool", call: c.id, req: c.sink.id, tool: String(ev.toolName ?? ""), spokeFirst: c.sink.sent > 0, afterMs: Date.now() - c.sink.t0 });
    }
    // The reply's spoken part is over once it calls a tool after saying something ("on it", then Delegate):
    // the pipeline's response ends here, so the voice is free; what the turn says later goes to the channel.
    if (c.sink && (c.sink.sent > 0 || c.sink.queued?.length)) finishSink(c, c.sink);
  } else if (ev?.type === "vc_turn_end") {
    say(c, c.speak.flush());
    if (c.sink) {
      log(d, { ev: "turn.end", call: c.id, req: c.sink.id, firstMs: c.sink.tFirst != null ? c.sink.tFirst - c.sink.t0 : null, deltaMs: c.sink.tDelta != null ? c.sink.tDelta - c.sink.t0 : null, deltas: c.sink.deltas, ms: Date.now() - c.sink.t0, chars: c.sink.text.length });
      finishSink(c, c.sink);
    }
    if (c.lastText) c.lastText.endedAt ??= Date.now();
    c.dropping = false;
  }
}

/** Sentences to the voice: the open response if there is one, else the speak channel. */
function say(c: Call, pieces: string[]): void {
  for (const p of pieces) {
    if (!p) continue;
    // The answer to the words he went on from: shown in the chat, never said (his newest words get the answer).
    if (!c.armed) continue;
    if (c.sink && !c.sink.done) {
      writeChunk(c.sink, p);
    } else if (!c.dropping && c.ownTurn) {
      if (c.held && c.held.utt === c.utt) c.held.pieces.push(p);
      else toChannel(c, p, c.utt);
    }
  }
}

function toChannel(c: Call, p: string, utt: number): void {
  const line = `data: ${JSON.stringify({ text: p, utt, at: Date.now() })}\n\n`;
  for (const ch of c.channels) ch.write(line);
}

/** No more words came after the cut (a noise cut it, not him): what the turn said is said after all. */
function releaseHeld(c: Call): void {
  const h = c.held;
  if (!h) return;
  clearTimeout(h.timer);
  c.held = null;
  if (!c.dropping && c.ownTurn) for (const p of h.pieces) toChannel(c, p, h.utt);
}

function writeChunk(s: Sink, text: string): void {
  if (s.holdUntil && Date.now() < s.holdUntil) {
    (s.queued ??= []).push(text);
    s.flushT ??= setTimeout(() => flushQueued(s), Math.max(0, s.holdUntil - Date.now()));
    return;
  }
  if (s.tFirst == null) s.tFirst = Date.now();
  const piece = (s.sent > 0 ? " " : "") + text;
  s.sent++;
  s.text += piece;
  s.res.write(`data: ${JSON.stringify({ id: s.id, object: "chat.completion.chunk", created: s.created, model: "pi", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
}

/** An opener's held reply: he didn't go on, so it is said now (and the response ends if its turn already did). */
function flushQueued(s: Sink): void {
  s.holdUntil = 0;
  if (s.flushT) clearTimeout(s.flushT);
  s.flushT = undefined;
  if (s.done) return;
  const q = s.queued ?? [];
  s.queued = [];
  for (const p of q) writeChunk(s, p);
  if (s.endAfter) endSink(s);
}

function finishSink(c: Call, s: Sink): void {
  if (s.done) return;
  if (c.sink === s) c.sink = null;
  if (s.queued?.length && s.holdUntil) {
    // Its reply is still held for his next words: the response ends once it is written (or he goes on and it isn't).
    s.endAfter = true;
    return;
  }
  endSink(s);
}

function endSink(s: Sink): void {
  if (s.done) return;
  s.done = true;
  try {
    s.res.write(`data: ${JSON.stringify({ id: s.id, object: "chat.completion.chunk", created: s.created, model: "pi", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    s.res.write("data: [DONE]\n\n");
    s.res.end();
  } catch {
    /* the pipeline went away */
  }
}

/** Carl's newest words in an OpenAI-shaped request (the pipeline sends its whole context; only these matter). */
// ---------------------------------------------------------------- the waiting line's calibration

let calibCache: { at: number; dir: string; calib: Record<string, { n: number; p50Ms: number; p90Ms: number }> } | null = null;

/** What work took before, from the box's turn log (logs/turns.jsonl, its last few MB): "turn" (a turn that used tools,
 *  start to end) and each tool by name. The waiting line's pace when the agent didn't say (src/voiceWaitLine.ts). */
export function workCalibration(dir: string | null, now = Date.now()): Record<string, { n: number; p50Ms: number; p90Ms: number }> {
  if (!dir) return {};
  if (calibCache && calibCache.dir === dir && now - calibCache.at < 60_000) return calibCache.calib;
  const samples: Record<string, number[]> = {};
  const add = (k: string, ms: unknown) => {
    if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) (samples[k] ??= []).push(ms);
  };
  try {
    const f = join(dir, "turns.jsonl");
    const size = statSync(f).size;
    const fd = openSync(f, "r");
    const len = Math.min(size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      let t: any;
      try {
        t = JSON.parse(line);
      } catch {
        continue;
      }
      if (t?.ev !== "turn" || t.outcome !== "ok" || !Array.isArray(t.tools) || !t.tools.length) continue;
      add("turn", t.ms);
      for (const x of t.tools) add(String(x?.name ?? "?"), x?.ms);
    }
  } catch {
    /* no log yet: no calibration, the line's defaults */
  }
  const calib: Record<string, { n: number; p50Ms: number; p90Ms: number }> = {};
  for (const [k, xs] of Object.entries(samples)) {
    if (xs.length < 3) continue;
    xs.sort((a, b) => a - b);
    const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))]!;
    calib[k] = { n: xs.length, p50Ms: q(0.5), p90Ms: q(0.9) };
  }
  calibCache = { at: now, dir, calib };
  return calib;
}

/** How many lines from Carl the pipeline's context holds. */
export function userLines(body: any): number {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  return msgs.filter((m: any) => m?.role === "user").length;
}

export function lastUserText(body: any): string {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== "user") return "";
  const c = last.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) return c.map((p: any) => (p?.type === "text" ? String(p.text ?? "") : "")).join(" ").trim();
  return "";
}

/** POST /v1/chat/completions: what Carl said, as a turn of the conversation; pi's reply streamed back as it is spoken. */
async function completions(d: BrainDeps, req: IncomingMessage, res: ServerResponse, body: any): Promise<void> {
  const c = callOf(req);
  if (!c) return void json(res, 401, { error: { message: "unknown call" } });
  const t0 = Date.now();
  const text = lastUserText(body);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const s: Sink = { res, id: `chatcmpl-${rid(6)}`, sent: 0, t0, tFirst: null, tDelta: null, deltas: 0, text: "", created: Math.floor(t0 / 1000), done: false };
  if (isOpener(text)) s.holdUntil = t0 + OPENER_MS;
  if (!text) {
    // Nothing new from Carl (an empty turn): nothing to say.
    finishSink(c, s);
    return;
  }
  // A newer request replaces an open one (he spoke again): the old response ends where it is.
  if (c.sink) finishSink(c, c.sink);
  // He cut a reply short: that turn is being stopped; his new words start a turn of their own.
  if (c.stopping) {
    await c.stopping;
    for (let i = 0; i < 30 && c.engine.isRunning(c.convId); i++) await new Promise((r) => setTimeout(r, 100));
    c.stopping = null;
  }
  c.sink = s;
  c.dropping = false;
  c.turns++;
  // The pipeline asking again with nothing new from Carl (a retry after an interruption that carried no words): the
  // same turn, not a second one — the reply already on its way streams into this response.
  // A re-ask carries no new line from him; the same words as a new line are him asking again (he didn't catch it, or
  // talked over the answer), and silence would look broken (the 30-minute sessions: 24, then 2, went unanswered).
  const lines = userLines(body);
  const last = c.lastText;
  const again = !!last && last.text === text && Date.now() - last.at < REASK_MS && lines <= last.lines;
  c.lastText = { text, at: Date.now(), lines };
  c.lastActive = Date.now();
  res.on("close", () => {
    if (!s.done) {
      // The pipeline cancelled it: Carl spoke. Before anything was said, his new words steer the same turn
      // (the next request). Mid-reply, he barged in: the rest of the reply is not said, and the turn stops.
      s.done = true;
      if (c.sink === s) c.sink = null;
      if (s.flushT) clearTimeout(s.flushT);
      if (s.sent > 0) {
        c.dropping = true;
        c.stopping = c.engine.interrupt(c.convId, false).catch(() => false);
      } else if (!c.held) {
        // Cut before a word was said: he may be going on (a pause ended his turn mid-thought). Hold what it says.
        c.held = { utt: c.utt, pieces: [...(s.queued ?? [])], timer: setTimeout(() => releaseHeld(c), HOLD_MS) };
      } else if (s.queued?.length) c.held.pieces.push(...s.queued);
      log(d, { ev: "turn.cut", call: c.id, req: s.id, afterMs: Date.now() - t0, spokenChars: s.text.length, stopped: s.sent > 0 });
    }
  });
  if (again) {
    // Nothing new from him: what the turn says streams into this response (no longer held for his next words).
    if (c.held) {
      clearTimeout(c.held.timer);
      c.held = null;
    }
    log(d, { ev: "turn.reask", call: c.id, req: s.id });
    // That turn already answered: nothing more is coming for this response (it used to stay open until he spoke).
    if (last?.endedAt != null) finishSink(c, s);
    return;
  }
  // He went on after a pause that ended his turn: the answer to the first half is not said (it stays in the chat), and
  // if that turn is still running his words steer it — what it says from their delivery on is the answer.
  const wentOn = !!c.held;
  if (c.held) {
    clearTimeout(c.held.timer);
    log(d, { ev: "turn.merge", call: c.id, req: s.id, dropped: c.held.pieces.length });
    c.held = null;
  }
  if (wentOn && c.engine.isRunning(c.convId)) c.armed = false;
  // The first half is still waiting to be delivered as a steer: take it back and send the whole line as he said it
  // (pi answered each half as its own message: "Make the component graph." / "Topologically sort it." / …).
  let said = text;
  if (wentOn && c.steer) {
    const back = await c.engine.message({ convId: c.convId, unqueue: c.steer.clientId }).catch(() => null);
    if (back?.ok) said = `${c.steer.text} ${text}`;
    c.steer = null;
  }
  // "Stop" / "never mind": the running work stops first (in code, not left to the model), then the words go to pi
  // like any line, so the conversation records them and it can answer in a word.
  const notes: string[] = [];
  if (STOP_RE.test(text) && c.engine.stopWork) {
    // What he just asked for: work started since his previous line (never older work he didn't mention).
    const stopped: string[] = [];
    const turn = c.engine.isRunning(c.convId);
    const n = await c.engine.stopWork(c.convId, last?.at, stopped).catch(() => 0);
    log(d, { ev: "turn.stop", call: c.id, req: s.id, workers: n });
    // pi is told what the code already did, so its line is true (it said "I can't stop the worker" when it was stopped).
    const what = [...(turn ? ["the turn that was running"] : []), ...stopped.map((t) => `the background worker "${t}"`)];
    if (what.length) notes.push(`[Stopped in code as he said it: ${what.join(" and ")}. It is already stopped; don't try to stop it again, and say so in a line.]`);
  }
  if (NO_SPOIL_RE.test(text)) c.noSpoil = true;
  else if (SPOIL_OK_RE.test(text)) c.noSpoil = false;
  if (c.noSpoil) notes.push(NO_SPOIL_NOTE);
  if (isThinkingAloud(said)) notes.push(THINKING_ALOUD_NOTE);
  const out = await c.engine.message({ convId: c.convId, text: said, ...(notes.length ? { context: notes.join("\n") } : {}), via: "voice", client: c.device, clientMsgId: `v-${s.id}`, ...(wentOn ? { continues: true } : {}) }).catch((e): Record<string, unknown> => ({ error: (e as Error).message }));
  if (!out?.steered) c.armed = true;
  c.steer = out?.steered ? { clientId: `v-${s.id}`, text: said } : null;
  log(d, { ev: "turn.start", call: c.id, req: s.id, chars: text.length, steered: !!out?.steered, msgMs: Date.now() - t0, ...(out?.error ? { error: String(out.error).slice(0, 200) } : {}) });
  if (!out || out.error) {
    writeChunk(s, "Sorry, that didn't reach the agent.");
    finishSink(c, s);
  }
}

/** GET /api/v1/brain/call/<id>/speak: what the conversation says outside a request (typed turns, results). */
function speakChannel(d: BrainDeps, req: IncomingMessage, res: ServerResponse, id: string): void {
  const c = callOf(req, id);
  if (!c) return void json(res, 401, { error: "unknown call" });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": open\n\n");
  c.channels.add(res);
  c.lastActive = Date.now();
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  res.on("close", () => {
    clearInterval(ping);
    c.channels.delete(res);
    c.lastActive = Date.now();
  });
  log(d, { ev: "speak.open", call: c.id });
}

/** POST /api/v1/brain/offer: the device's WebRTC offer, handed to the pipeline with the call's secrets (loopback). */
async function offer(d: BrainDeps, b: any): Promise<{ status: number; body: Record<string, unknown> }> {
  const c = calls.get(String(b?.callId ?? ""));
  if (!c) return { status: 404, body: { error: "no such call" } };
  const key = d.elKey();
  if (!key) return { status: 503, body: { error: "no ElevenLabs key on the box" } };
  try {
    const r = await fetch(`${d.botUrl}/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sdp: b.sdp,
        type: b.type,
        pc_id: b.pc_id ?? null,
        call: { id: c.id, token: c.token.toString("base64url"), base: d.selfUrl, elKey: key, voiceId: d.voiceId() },
      }),
    });
    const out = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: r.ok ? 200 : 502, body: r.ok ? out : { error: `the voice pipeline refused: ${String(out.error ?? r.status)}` } };
  } catch (e) {
    return { status: 502, body: { error: `the voice pipeline is not running (${(e as Error).message})` } };
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** The brain's routes. Returns false when `path` is not one of them. `loopback`: the request came from this machine. */
export async function brainRoute(
  d: BrainDeps,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  loopback: boolean,
  readJson: () => Promise<any>,
): Promise<boolean> {
  if (path === "/v1/chat/completions" && method === "POST") {
    if (!loopback) return json(res, 403, { error: { message: "loopback only" } }), true;
    await completions(d, req, res, await readJson());
    return true;
  }
  const sp = /^\/api\/v1\/brain\/call\/([^/]+)\/speak$/.exec(path);
  if (sp && method === "GET") {
    if (!loopback) return json(res, 403, { error: "loopback only" }), true;
    speakChannel(d, req, res, decodeURIComponent(sp[1]!));
    return true;
  }
  if (path === "/api/v1/brain/call" && method === "POST") {
    const r = await startCall(d, await readJson());
    // The token is the pipeline's (on this machine), never a device's.
    const { token: _t, ...body } = r.body;
    json(res, r.status, loopback ? r.body : body);
    return true;
  }
  const end = /^\/api\/v1\/brain\/call\/([^/]+)\/end$/.exec(path);
  if (end && method === "POST") {
    json(res, 200, { ok: endCall(d, decodeURIComponent(end[1]!)) });
    return true;
  }
  if (path === "/api/v1/brain/offer" && method === "POST") {
    const r = await offer(d, await readJson());
    json(res, r.status, r.body);
    return true;
  }
  // Settings → Voice engine (every device reads it when voice starts).
  if (path === "/api/v1/brain/engine" && method === "GET") {
    json(res, 200, { engine: voiceEngine(d), pipeline: await pipelineUp(d), model: talkerModel() });
    return true;
  }
  if (path === "/api/v1/brain/engine" && method === "POST") {
    const b = await readJson();
    const e: VoiceEngine = b?.engine === "new" ? "new" : "classic";
    if (!setVoiceEngine(d, e)) return json(res, 503, { error: "no state dir" }), true;
    log(d, { ev: "engine", engine: e });
    d.onEngine?.(e);
    // A first switch to New sets the pipeline up (minutes once): say so rather than "not running".
    if (e === "new") await new Promise((r) => setTimeout(r, 1500));
    json(res, 200, { ok: true, engine: e, pipeline: await pipelineUp(d) });
    return true;
  }
  // The waiting line for a surface with no conversation feed of its own (the iPad board): its inputs, and the box's
  // calibration merged with this conversation's history.
  const wait = /^\/api\/v1\/brain\/wait\/([A-Za-z0-9_-]{1,80})$/.exec(path);
  if (wait && method === "GET") {
    const engine = await d.engine();
    const w = engine.waitInputs?.(wait[1]!) ?? { works: [], plan: null, samples: {}, running: false };
    json(res, 200, { works: w.works, plan: w.plan, running: !!w.running, calib: calibFrom(w.samples, workCalibration(d.logDir)), now: Date.now() });
    return true;
  }
  if (path === "/api/v1/brain/expect" && method === "GET") {
    json(res, 200, { calib: workCalibration(d.logDir) });
    return true;
  }
  if (path === "/api/v1/brain/calls" && method === "GET") {
    json(res, 200, { calls: liveCalls(), model: talkerModel(), now: Date.now() });
    return true;
  }
  return false;
}
