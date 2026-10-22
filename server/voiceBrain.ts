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
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Speakable } from "./speakable";
import { speechReady } from "./speakMath";

export type BrainEngine = {
  message(b: { convId?: string | null; text?: string; source?: string; via?: string; client?: string; clientMsgId?: string }): Promise<Record<string, unknown> | null>;
  setTalker(convId: string, t: { model: string; rules: string; thinking?: string } | null): void;
  tap(convId: string, fn: (ev: any) => void): () => void;
  isRunning(convId: string): boolean;
  interrupt(convId: string, byUser: boolean): Promise<boolean>;
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
};

export const brainEnabled = (): boolean => process.env.VC_VOICE_BRAIN === "pi";
/** The talker: a fast model for turns while a call is live (the conversation's own model does the delegated work). */
export const talkerModel = (): string => process.env.VC_VOICE_TALKER_MODEL || "google/gemini-3.8-flash";
/** The talker's thinking (pi's levels: off, minimal, low, medium, high): a spoken reply wants little. */
export const talkerThinking = (): string => process.env.VC_VOICE_TALKER_THINKING || "low";

type Device = "laptop" | "board" | "phone";
const DEVICES: Device[] = ["laptop", "board", "phone"];

/** What pi is told once, in front of the call's first turn (it stays in the session). */
export function voiceCallRules(device: Device): string {
  const where = device === "board" ? "his iPad board" : device === "phone" ? "his phone" : "his laptop";
  // One reply, written as always (markdown); the voice reads it aloud as written (server/speakable.ts). Only a light
  // nudge on length, and the one rule a live call needs: slow work goes to Delegate, so the voice never goes quiet.
  return `[A voice call is live on ${where}: your replies are shown as always and also read aloud as written. Keep them conversational in length. Anything that takes more than a few seconds goes to Delegate {title, task}: say in a line that you've sent it and carry on; its report comes back to you as a "Delegated work finished" turn, then tell him the result. Say something was done only when it was.]`;
}

// ---------------------------------------------------------------- calls

type Sink = { res: ServerResponse; id: string; sent: number; t0: number; tFirst: number | null; tDelta: number | null; deltas: number; text: string; created: number; done: boolean };

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
  /** Text since the last cut (spoken form), one per turn. */
  speak: Speakable;
  /** The pipeline's speak channel(s). */
  channels: Set<ServerResponse>;
  untap: () => void;
  engine: BrainEngine;
  turns: number;
  /** Its last request or speak-channel activity (a call whose pipeline died without ending it is reaped). */
  lastActive: number;
  /** A barge-in stopped the turn that was talking: the next request waits for it to end. */
  stopping: Promise<unknown> | null;
};

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
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(convId)) return { status: 400, body: { error: "convId required" } };
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
    speak: new Speakable(),
    channels: new Set(),
    untap: () => {},
    engine,
    turns: 0,
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
    // The reply's spoken part is over once it calls a tool after saying something ("on it", then Delegate):
    // the pipeline's response ends here, so the voice is free; what the turn says later goes to the channel.
    if (c.sink && c.sink.sent > 0) finishSink(c, c.sink);
  } else if (ev?.type === "vc_turn_end") {
    say(c, c.speak.flush());
    if (c.sink) {
      log(d, { ev: "turn.end", call: c.id, req: c.sink.id, firstMs: c.sink.tFirst != null ? c.sink.tFirst - c.sink.t0 : null, deltaMs: c.sink.tDelta != null ? c.sink.tDelta - c.sink.t0 : null, deltas: c.sink.deltas, ms: Date.now() - c.sink.t0, chars: c.sink.text.length });
      finishSink(c, c.sink);
    }
    c.dropping = false;
  }
}

/** Sentences to the voice: the open response if there is one, else the speak channel. */
function say(c: Call, pieces: string[]): void {
  for (const p of pieces) {
    if (!p) continue;
    if (c.sink && !c.sink.done) {
      writeChunk(c.sink, p);
    } else if (!c.dropping) {
      const line = `data: ${JSON.stringify({ text: p, at: Date.now() })}\n\n`;
      for (const ch of c.channels) ch.write(line);
    }
  }
}

function writeChunk(s: Sink, text: string): void {
  if (s.tFirst == null) s.tFirst = Date.now();
  const piece = (s.sent > 0 ? " " : "") + text;
  s.sent++;
  s.text += piece;
  s.res.write(`data: ${JSON.stringify({ id: s.id, object: "chat.completion.chunk", created: s.created, model: "pi", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
}

function finishSink(c: Call, s: Sink): void {
  if (s.done) return;
  s.done = true;
  if (c.sink === s) c.sink = null;
  try {
    s.res.write(`data: ${JSON.stringify({ id: s.id, object: "chat.completion.chunk", created: s.created, model: "pi", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    s.res.write("data: [DONE]\n\n");
    s.res.end();
  } catch {
    /* the pipeline went away */
  }
}

/** Carl's newest words in an OpenAI-shaped request (the pipeline sends its whole context; only these matter). */
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
  c.lastActive = Date.now();
  res.on("close", () => {
    if (!s.done) {
      // The pipeline cancelled it: Carl spoke. Before anything was said, his new words steer the same turn
      // (the next request). Mid-reply, he barged in: the rest of the reply is not said, and the turn stops.
      s.done = true;
      if (c.sink === s) c.sink = null;
      if (s.sent > 0) {
        c.dropping = true;
        c.stopping = c.engine.interrupt(c.convId, false).catch(() => false);
      }
      log(d, { ev: "turn.cut", call: c.id, req: s.id, afterMs: Date.now() - t0, spokenChars: s.text.length, stopped: s.sent > 0 });
    }
  });
  const out = await c.engine.message({ convId: c.convId, text, source: "voice", via: "voice", client: c.device, clientMsgId: `v-${s.id}` }).catch((e): Record<string, unknown> => ({ error: (e as Error).message }));
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
  if (path === "/api/v1/brain/calls" && method === "GET") {
    json(res, 200, { calls: liveCalls(), model: talkerModel(), now: Date.now() });
    return true;
  }
  return false;
}
