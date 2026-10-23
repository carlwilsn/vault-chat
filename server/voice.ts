// Voice on the box (D3: one brain). Voice is the front of house of ONE
// conversation — the chat Carl attached it to: its prompt is that
// conversation's pi session (what was typed and said, the compaction summary)
// plus the "you" layer; every line said on the call goes into that session (a
// vc-voice custom message: the agent hears it on its next turn); and every
// action is the agent's: voice's one tool that acts, Ask, hands Carl's request
// to pi in that conversation and returns at once, and the agent's answer comes
// back into the live call through /updates. Ask is a background side request,
// never a message in the thread and never a steer (Carl: "Do I even need to see
// the voice talking to the main agent? Why is that not a background task?"): a
// pi side thread forked from the conversation (always with the agent's tools, pi's
// file tools among them; an action the voice marked act waits for a running turn
// to end), its result said to Carl through /updates and kept in the thread as ONE
// collapsed row (VoiceAsk). Voice's acknowledgement ("on it") and the platform's
// filler ("One sec.") are spoken, never written. Tools that read or move a screen
// run on the device in front of Carl (src/voicePrompt.ts SCREEN_TOOLS).
//
// Routes (http.ts), each with an optional vault:
//   GET  /api/v1/voice/session    ?convId=&device=            → {conversationToken, signedUrl, systemPrompt, toolNames, convId, cursor, images, sessionId, handoff?, …}
//   POST /api/v1/voice/tool       {name, args, convId, device, sessionId?} → {result, convId?, moved?}
//   POST /api/v1/voice/transcript {convId, role, text, system?, ended?, tool?, images?, clientId?, device?, sessionId?} → {convId} | 409 {moved}
//   GET  /api/v1/voice/updates    ?convId=&cursor=&wait=&session= → {updates: [{id, kind, text, speak}], cursor, moved?}
//
// One voice at a time (Carl: "can I technically have 2 voices in the same conversation thread? That sounds
// like an inconsistency"): the box mints every session, so it keeps the one live session. Starting voice on
// another device hands off, like AirPods: the new session continues the live one's conversation (its prompt
// is that conversation, so it has the whole context) and the old one is told "moved" through its updates
// poll — its client ends its call and says "Voice moved to iPad". From then on the box refuses the old
// session's lines and tools (409 / an error result) and gives it no updates, so the thread has one voice,
// in order, and only one voice speaks. A client without a session id (an older build) is not refused.
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runGit } from "./git";
import { createConv, logOf, newMessageId, pictureOf, writeNotes, type NoteData } from "./engine/convs";
import { appendActivity, projectContextFor, youLayer } from "./activity";
import { voiceLineEntry } from "../src/activityCore";
import { stripAudioTags } from "../src/voiceTags";
import { speakMath, speechReady } from "./speakMath";
import { ASK, SCREEN_TOOLS, buildVoicePrompt, controlLine, isControlLine, isFillerLine, spokenReply, voiceDevice, voiceToolNames, type VoiceDevice } from "../src/voicePrompt";
import type { Item, Picture } from "../src/convlog/reduce";

export type VoiceDeps = {
  /** The vault's working copy, its name on the box, and whether it is the main one (the store's). */
  vault: string;
  name?: string;
  main?: boolean;
  /** The engine's /message: Ask hands Carl's request to the conversation's agent through it. */
  message?: (b: { text: string; convId?: string | null; source?: "voice"; via?: string; clientMsgId?: string; client?: string; context?: string }) => Promise<Record<string, unknown> | null>;
  /** After a line is saved: a sync cycle, so it reaches the laptop. */
  onWrite?: (paths?: string[]) => void;
  /** pi side threads (server/engine/pi/side.ts, the engine's sideStart): voice's Ask runs as one, forked from the
   *  conversation, always with pi's own file tools and the agent's ("act"; Ctrl+K / Ctrl+L stay read-only). */
  side?: {
    start(b: { kind: string; convId: string; text: string; tools?: "act" }): Promise<{ id?: unknown; error?: unknown }>;
    /** Until it is done: its final text, or why it failed. */
    wait(id: string): Promise<{ text: string; error: string | null }>;
  };
};

const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- paths (the vault file route, http.ts)

/** The real path of `p`, or of its deepest existing ancestor plus the rest (a file not yet written). */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      rest.push(cur.slice(up.length).replace(/^[\\/]+/, ""));
      cur = up;
    }
  }
}

function relIn(root: string, abs: string): string | null {
  const r = relative(root, abs);
  if (r === "") return "";
  if (r.startsWith("..") || isAbsolute(r)) return null;
  return r.split(sep).join("/");
}

const under = (rel: string, entry: string) => rel === entry || rel.startsWith(entry + "/");

/** Resolve a path (vault-relative or absolute) to an absolute path inside the vault, or throw the refusal. */
export function voicePath(vault: string, p: unknown, mode: "read" | "write"): { abs: string; rel: string } {
  const raw = s(p).trim();
  const root = realish(resolve(vault));
  const abs = realish(resolve(raw ? (isAbsolute(raw) ? raw : join(vault, raw)) : vault));
  const rel = relIn(root, abs);
  if (rel === null) throw `Refused: ${raw || "(empty path)"} is outside the vault.`;
  const parts = rel.split("/");
  if (parts.includes(".git")) throw `Refused: the .git folder is off limits.`;
  if (mode === "write" && (under(rel, ".vault-chat/conversations") || under(rel, ".vault-chat/local"))) {
    throw `Refused: ${rel} belongs to the server (conversations and local state are not written by tools).`;
  }
  return { abs, rel };
}

// ---------------------------------------------------------------- live sessions

/** A voice session with no tool call or transcript line for this long is over (a client that died without its end line). */
export const VOICE_IDLE_MS = 10 * 60_000;
/** Per vault: when its voice session last did anything. Present = a session is live. */
const voiceLive = new Map<string, number>();

/** A voice session is live in `vault` (its session was minted, a tool ran, a line was said) — or, `ended`, it is over. */
export function voiceActivity(vault: string, ended = false, now = Date.now()): void {
  if (ended) voiceLive.delete(vault);
  else voiceLive.set(vault, now);
}

/** Live voice sessions on this box (one per vault at most): the health's busy
 * counts them, so the updater never restarts the server under someone talking. */
export function activeVoiceSessions(now = Date.now()): number {
  let n = 0;
  for (const at of voiceLive.values()) if (now - at < VOICE_IDLE_MS) n++;
  return n;
}

// ---------------------------------------------------------------- one voice at a time

export type LiveVoice = { id: string; vault: string; device: VoiceDevice; convId: string | null; at: number; ended: boolean; movedTo: VoiceDevice | null };
/** Sessions minted on this box (the newest few, for their "moved" answers), and the live one. */
const voiceSessionsById = new Map<string, LiveVoice>();
let liveVoice: LiveVoice | null = null;

/** What Carl calls each device. */
export const deviceLabel = (d: VoiceDevice): string => (d === "board" ? "iPad" : d === "phone" ? "phone" : "laptop");
/** What the old device shows. */
export const movedLine = (to: VoiceDevice): string => `Voice moved to ${deviceLabel(to)}`;

/** The live session (minted, not ended, not idle past VOICE_IDLE_MS), or null. */
export function liveVoiceSession(now = Date.now()): LiveVoice | null {
  const v = liveVoice;
  return v && !v.ended && !v.movedTo && now - v.at < VOICE_IDLE_MS ? v : null;
}

/** A session id the box minted that another session has replaced (null: live, ended, or unknown). */
function supersededBy(sessionId: unknown): VoiceDevice | null {
  const id = s(sessionId);
  return id ? (voiceSessionsById.get(id)?.movedTo ?? null) : null;
}

/** A new session on `device`: the live one on another device moves here (its conversation with it). */
function startLiveVoice(vault: string, device: VoiceDevice, convId: string | null): { session: LiveVoice; from: LiveVoice | null } {
  const prev = liveVoiceSession();
  const id = `vs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // Another device's live call in this vault: its conversation continues here.
  const from = prev && prev.device !== device && prev.vault === vault ? prev : null;
  // Any earlier session ends here (the same device's too: a reconnect, a switched chat, a second tab).
  if (liveVoice && !liveVoice.ended && !liveVoice.movedTo) liveVoice.movedTo = device;
  const session: LiveVoice = { id, vault, device, convId: from?.convId ?? convId, at: Date.now(), ended: false, movedTo: null };
  voiceSessionsById.set(id, session);
  while (voiceSessionsById.size > 50) voiceSessionsById.delete(voiceSessionsById.keys().next().value as string);
  liveVoice = session;
  return { session, from };
}

/** A line, a tool call or a poll from `sessionId`: it is alive (and its conversation is `convId`). */
function touchSession(sessionId: unknown, convId?: string | null, ended = false): void {
  const v = voiceSessionsById.get(s(sessionId));
  if (!v || v.movedTo) return;
  v.at = Date.now();
  if (convId) v.convId = convId;
  if (ended) v.ended = true;
}

/** [tests] Forget every session. */
export function resetVoiceSessionsForTests(): void {
  voiceSessionsById.clear();
  liveVoice = null;
}

/** The end-of-session line the clients write ("Voice session ended."). */
const ENDED_LINE = /^voice session ended\b/i;

// ---------------------------------------------------------------- the attached conversation

const CONV_ID = /^[A-Za-z0-9_-]{6,80}$/;
/** The old missions system's threads: readable, never run, never attached. */
const ARCHIVED = new Set(["mission", "worker", "ask"]);

/** The conversation voice is attached to: `convId` when it is one (any chat Carl has), else — `create` — a new one
 * (under the client's id when it chose one: an optimistic new chat on the laptop), titled by `first`. */
async function attached(d: VoiceDeps, convId: unknown, create: false): Promise<string | null>;
async function attached(d: VoiceDeps, convId: unknown, create: true, first: string): Promise<string>;
async function attached(d: VoiceDeps, convId: unknown, create: boolean, first = "Voice"): Promise<string | null> {
  const id = s(convId).trim();
  const p = id ? pictureOf(d.vault, id) : null;
  if (p && !p.meta.deleted && !ARCHIVED.has(String(p.meta.source))) return id;
  if (!create) return null;
  const fresh = CONV_ID.test(id) && !logOf(d.vault).has(id) ? id : undefined;
  return (await createConv(d.vault, { source: "voice" }, first, fresh)).id;
}

// ---------------------------------------------------------------- transcripts

/** POST /api/v1/voice/transcript: one line of the call (Carl's, the voice's, a system line, a screen tool's row),
 * written into the attached conversation's pi session, in order. Carl's and the voice's lines are vc-voice custom
 * messages (in the agent's context); a system line or a tool row is a vc-note (shown, not in its context). A line
 * vault-chat itself sent into the call ([vc:…]) is never Carl's: it is not saved. */
export async function voiceTranscript(d: VoiceDeps, b: any): Promise<{ status: number; body: Record<string, unknown> }> {
  const said = s(b?.text).trim();
  if (!said) return { status: 400, body: { error: "empty transcript line" } };
  const system = b?.system === true;
  const role: "user" | "assistant" = b?.role === "user" ? "user" : "assistant";
  // Control tags ("[skip_turn]") and audio tags shape the call, not the transcript; our own [vc:…] messages are not his.
  const text = role === "assistant" && !system ? stripAudioTags(said) : said;
  const ended = b?.ended === true || (system && ENDED_LINE.test(text));
  // A session another device took over: nothing of it lands (one voice in the thread, in order).
  const moved = supersededBy(b?.sessionId);
  if (moved) return { status: 409, body: { error: movedLine(moved), moved: { to: moved, line: movedLine(moved) } } };
  voiceActivity(d.vault, ended);
  if (!text || (role === "user" && !system && isControlLine(text))) return { status: 200, body: { ok: true, convId: s(b?.convId) || null, skipped: true } };
  // Carl speaking again ends an Ask's acknowledgement window: voice's next line is its reply to him.
  if (role === "user" && !system && b?.convId) ackDue.delete(s(b.convId));
  // Spoken, never written: the platform's filler, voice's own "one sec / on it", and the line acknowledging an Ask.
  if (role === "assistant" && !system && !b?.tool && (isFillerLine(text) || takeAck(s(b?.convId), text))) {
    touchSession(b?.sessionId);
    return { status: 200, body: { ok: true, convId: s(b?.convId) || null, skipped: true, filler: true } };
  }
  // The end of a call where nothing was said: no conversation for it.
  const have = await attached(d, b?.convId, false);
  if (ended && !have) return { status: 200, body: { ok: true, convId: null } };
  const id = have ?? (await attached(d, b?.convId, true, role === "user" && !system ? text : "Voice"));
  const clientId = s(b?.clientId).slice(0, 80) || newMessageId();
  if (pictureOf(d.vault, id)?.items.some((x) => x.id === clientId)) return { status: 200, body: { ok: true, convId: id, duplicate: true } };
  const device = b?.device ? voiceDevice(b.device) : null;
  const tool = b?.tool && typeof b.tool === "object" && s(b.tool.name) ? b.tool : null;
  let note: NoteData;
  if (tool) note = { kind: "tool", name: s(tool.name).slice(0, 80), args: toolArgs(tool.args), result: s(tool.result).slice(0, 4000), via: "voice", clientId };
  else if (system) note = { kind: "notice", text: text.slice(0, 2000), level: "info", clientId };
  else {
    // Images Carl sent in the chat while voice was on: saved like any chat capture.
    const images = role === "user" && Array.isArray(b?.images) && b.images.length ? saveTranscriptImages(d.vault, id, b.images) : [];
    note = { kind: "line", role, text: text.slice(0, 20_000), via: "voice", voice: true, clientId, ...(device ? { device } : {}), ...(images.length ? { images } : {}) };
  }
  await writeNotes(d.vault, id, [note]);
  if (!tool && !system) {
    const e = voiceLineEntry(role, text, id);
    if (e) appendActivity(d.vault, { ...e, ...(device ? { device } : {}) });
  }
  touchSession(b?.sessionId, id, ended);
  d.onWrite?.();
  return { status: 200, body: { ok: true, convId: id } };
}

/** A tool call's arguments as the row shows them: an object, long strings cut. */
function toolArgs(a: unknown): Record<string, unknown> {
  if (!a || typeof a !== "object" || Array.isArray(a)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a as Record<string, unknown>).slice(0, 20)) {
    if (typeof v === "string") out[k] = v.length > 500 ? v.slice(0, 500) + "…" : v;
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else {
      const j = JSON.stringify(v) ?? "";
      out[k] = j.length > 500 ? j.slice(0, 500) + "…" : v;
    }
  }
  return out;
}

/** Save a voice line's images under .vault-chat/captures/ (≤ 5, ≤ 15 MB each), as the engine saves a chat's. */
function saveTranscriptImages(vault: string, convId: string, images: unknown[]): { path: string; dataUrl?: string }[] {
  const out: { path: string; dataUrl?: string }[] = [];
  images.slice(0, 5).forEach((raw, i) => {
    const img = (raw ?? {}) as { mime?: unknown; dataBase64?: unknown };
    const mime = s(img.mime) || "image/png";
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(mime)) return;
    const b64 = s(img.dataBase64).replace(/^data:[^,]*,/, "");
    const buf = Buffer.from(b64, "base64");
    if (!buf.length || buf.length > 15 * 1024 * 1024) return;
    const ext = /jpe?g/i.test(mime) ? ".jpg" : /webp/i.test(mime) ? ".webp" : /gif/i.test(mime) ? ".gif" : ".png";
    const rel = `.vault-chat/captures/${new Date().toISOString().replace(/[:.]/g, "-")}-${convId.slice(0, 8)}-v${i}${ext}`;
    mkdirSync(join(vault, ".vault-chat", "captures"), { recursive: true });
    writeFileSync(join(vault, rel), buf);
    out.push({ path: rel, ...(buf.length < 400_000 ? { dataUrl: `data:${mime};base64,${b64}` } : {}) });
  });
  return out;
}

// ---------------------------------------------------------------- the tool

// ---------------------------------------------------------------- spoken, never written

/** After an Ask: voice's next short line in that conversation, if it says one (a long task's "pulling the lecture
 *  notes"; it is told to say nothing for a quick one), is about the Ask, not a reply. Ends with the answer or when
 *  Carl speaks again (what voice says after that is its reply to him). */
const ackDue = new Map<string, number>();
const ACK_MS = 20_000;
function takeAck(convId: string, text: string): boolean {
  const until = convId ? ackDue.get(convId) : undefined;
  if (!until) return false;
  ackDue.delete(convId);
  return Date.now() < until && text.trim().length <= 160;
}

/** POST /api/v1/voice/tool {name, args, convId, device}. Never throws: errors are the result the voice hears. */
export async function voiceTool(d: VoiceDeps, body: any): Promise<{ result: string; convId?: string; moved?: { to: VoiceDevice; line: string } }> {
  const name = s(body?.name);
  const args = body?.args ?? body?.arguments ?? body?.parameters ?? {};
  if (!name) return { result: "Error: missing tool name." };
  const moved = supersededBy(body?.sessionId);
  if (moved) return { result: `Error: voice moved to Carl's ${deviceLabel(moved)}; this call is over and nothing was done. Say nothing.`, moved: { to: moved, line: movedLine(moved) } };
  voiceActivity(d.vault);
  touchSession(body?.sessionId, s(body?.convId) || null);
  const a = args && typeof args === "object" ? args : {};
  const device = voiceDevice(body?.device);
  try {
    if (name === ASK) return await ask(d, a, body?.convId, device);
    if (SCREEN_TOOLS.has(name)) {
      return {
        result:
          device === "phone"
            ? `Error: ${name} needs a screen, and this call is on Carl's phone: nothing was looked at or moved. Say you can't see his screen from the phone.`
            : `Error: ${name} runs on Carl's ${device} itself, and it did not answer: nothing was looked at or moved.`,
      };
    }
    return { result: `Error: "${name}" is not one of your tools. Hand it to the agent with ${ASK} — it has every tool. Nothing was done.` };
  } catch (e) {
    return { result: `Error: ${typeof e === "string" ? e : ((e as Error)?.message ?? String(e))}. Nothing was done.` };
  }
}

/** What the side thread is told with a request voice handed over (before Carl's words; not shown in the chat). */
export const ASK_CONTEXT =
  "[Carl asked this by voice, on a call (his spoken lines are in this conversation). You are a side request with the agent's tools (files, the shell, his board inbox): the conversation's own work goes on without you. If he asked for something to be made, changed or sent, do it now, carefully; for a question, look it up. Answer in two or three plain sentences: they are read out to him. Say only what you found or did, and checked.]";
/** For an action the voice marked (Ask {act: true}): it changes things, after the conversation's running turn. */
export const ACT_CONTEXT =
  "[Carl asked this by voice, on a call (his spoken lines are in this conversation). You are a side request with the file tools: do it now, in place, carefully; the conversation's own work goes on without you. Then say in two or three plain sentences what you did and checked: they are read out to him. If it needs a tool you don't have here, do nothing and say so.]";

/** A request id (its row in the transcript: voice-ask-<id>). */
const requestId = () => `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** What a voice Ask came back with, for the live call's updates (newest last; per vault). */
type AskDone = { vault: string; convId: string; id: string; at: number; text: string; error: string | null };
const asksDone: AskDone[] = [];
/** Voice Asks still running (tests, diagnostics). */
const asksRunning = new Map<string, Promise<void>>();
/** [tests] Until every running voice Ask has finished. */
export async function voiceAsksSettled(): Promise<void> {
  while (asksRunning.size) await Promise.all([...asksRunning.values()]);
}

/** Ask {request, act?}: Carl's request, in the background — a pi side thread forked from the attached conversation
 * (always with the agent's tools, pi's file tools among them; an action the voice marked act waits until a running
 * turn of the conversation ends). It never writes a message into the thread and never steers a running turn. Returns at once, so no timeout
 * of the call can drop it; the answer comes back through /updates and is kept as one collapsed row. The one
 * exception is the agent's own open question: Carl's spoken answer goes to it as his answer. */
async function ask(d: VoiceDeps, a: Record<string, unknown>, convId: unknown, device: VoiceDevice): Promise<{ result: string; convId?: string }> {
  const request = s(a.request ?? a.task).trim();
  if (!request) return { result: `Error: ${ASK} needs the request (Carl's words). Nothing was handed over.` };
  const id = await attached(d, convId, true, request);
  const rid = requestId();
  const p = pictureOf(d.vault, id);
  // The agent asked Carl something: his answer goes to it, as a typed answer would.
  if (p?.meta.asking && d.message) {
    const out = await d.message({ convId: id, text: request, source: "voice", via: "voice-ask", clientMsgId: rid, client: device, context: "[Carl answered your question by voice, on a call.]" });
    if (!out || out.error) return { result: `Error: the agent did not take his answer (${s(out?.error) || "no answer"}). Tell Carl.`, convId: id };
    ackDue.set(id, Date.now() + ACK_MS);
    return { result: `That went to the agent as Carl's answer to its question (request ${rid}). What it does next comes to you as a message starting [vc:result]. Say nothing now (no holding line).`, convId: id };
  }
  if (!d.side) return { result: "Error: the agent is not running on the box, so nothing was handed over. Tell Carl it didn't go through.", convId: id };
  const act = a.act === true || a.act === "true";
  const waits = act && !!p?.meta.running;
  const run = runAsk(d, { rid, convId: id, request, act }).finally(() => asksRunning.delete(rid));
  asksRunning.set(rid, run);
  ackDue.set(id, Date.now() + ACK_MS);
  const now = act
    ? waits
      ? `The agent will do it as a side request once its current work in this conversation finishes (request ${rid}).`
      : `The agent is doing it as a side request (request ${rid}).`
    : `The agent is looking it up as a side request (request ${rid}).`;
  return { result: `${now} Its answer will come to you as a message starting [vc:result]. Say nothing now (no "on it", no holding line) unless it will clearly take a while, then once, in a few plain words, what is happening; don't say it is done and don't guess the answer.`, convId: id };
}

/** Until the conversation has no running turn (an action never runs beside one: it would edit the same files). */
async function untilIdle(vault: string, convId: string, maxMs = 60 * 60_000): Promise<void> {
  const t0 = Date.now();
  while (pictureOf(vault, convId)?.meta.running && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 1000));
}

/** The side request, then its one row in the thread and its answer for the live call. */
async function runAsk(d: VoiceDeps, o: { rid: string; convId: string; request: string; act: boolean }): Promise<void> {
  let text = "";
  let error: string | null = null;
  try {
    if (o.act) await untilIdle(d.vault, o.convId);
    // A conversation no agent turn has run in has no session to fork: what was said comes with the request.
    const said = pictureOf(d.vault, o.convId)?.meta.threadId ? "" : conversationBlock(d.vault, o.convId, 4000);
    const prompt = `${o.act ? ACT_CONTEXT : ASK_CONTEXT}\n\n${said ? `${said}\n\n` : ""}${o.request}`;
    // Every Ask has the action tools (Carl, 2026-10-21: a read-only Ask refused to make an image four times): the
    // side thread is pi, which decides what the request needs. `act` only orders it after a running turn.
    const r = await d.side!.start({ kind: o.act ? "voice-act" : "voice-ask", convId: o.convId, text: prompt, tools: "act" });
    if (!r?.id || r.error) throw new Error(s(r?.error) || "the side request did not start");
    const done = await d.side!.wait(String(r.id));
    text = s(done.text).trim();
    error = done.error;
    if (!text && !error) error = "it came back with nothing";
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 300);
  }
  // One compact row in the thread: what voice asked and what came back (collapsed; never a bubble). A failure right
  // after the same failure adds no second red row (10-22: a stack of "failed: Connection error"); voice still hears it.
  const result = error ? `Error: ${error}` : text.slice(0, 4000);
  const lastItem = pictureOf(d.vault, o.convId)?.items.at(-1);
  const repeatFailure = !!error && lastItem?.kind === "tool" && lastItem.name === "VoiceAsk" && s(lastItem.result) === result;
  if (!repeatFailure) {
    await writeNotes(d.vault, o.convId, [
      { kind: "tool", name: "VoiceAsk", args: { request: o.request, ...(o.act ? { act: true } : {}) }, result, via: "voice", clientId: `voice-${o.rid}` },
    ]).catch((e) => console.warn("[voice] the Ask's row:", e));
    d.onWrite?.();
  }
  // The acknowledgement window ends with the answer: what voice says after it is its reply.
  ackDue.delete(o.convId);
  asksDone.push({ vault: d.vault, convId: o.convId, id: o.rid, at: Date.now(), text, error });
  while (asksDone.length > 200) asksDone.shift();
}

// ---------------------------------------------------------------- updates into the live call

/** One thing to put into a live call: `speak` (a [vc:result] / [vc:question] user message the voice answers
 * aloud) or not (a [vc:context] contextual update: already handled, never answered). */
export type VoiceUpdate = { id: string; kind: "result" | "question" | "context" | "you"; text: string; speak: boolean };

const RESULT_CAP = 1500;
/** How an Ask's answer is said (Carl, 2026-10-22: "Slowpoke, I found it already" while an Ask ran, and the voice
 *  still read the whole lookup out, then said it was "just passing along the lookup result"). */
export const TELL_RESULT =
  "Tell Carl now, briefly, in your own words — only what it says. But if he has since said he has it, found it, moved on or no longer needs it, say nothing (skip your turn) or one word at most: never the result, and never explain that you were passing it along.";
const parseCursor = (c: unknown): { at: number; you: number } | null => {
  const m = /^(\d+):(\d+)$/.exec(s(c));
  return m ? { at: Number(m[1]), you: Number(m[2]) } : null;
};
const cursorOf = (at: number, you: number) => `${Math.floor(at)}:${Math.floor(you)}`;

/** What happened in the conversation (and elsewhere) since `cur`: the agent's finished answers, its open question,
 * and the "you" layer. A turn still running is held until it ends (never a half answer). */
export function voiceUpdatesSince(d: VoiceDeps, convId: string | null, cur: { at: number; you: number }, o: { you?: boolean } = {}): { updates: VoiceUpdate[]; at: number; you: number } {
  const updates: VoiceUpdate[] = [];
  let at = cur.at;
  let you = cur.you;
  // Voice's own Asks, answered in the background (never held for a running turn: they are not its).
  for (const r of asksDone) {
    if (r.vault !== d.vault || r.convId !== convId || r.at <= cur.at) continue;
    updates.push({
      id: `v-${r.id}`,
      kind: "result",
      speak: true,
      text: r.error
        ? controlLine("result", `The agent could not do it (request ${r.id}): ${clip(oneLine(r.error), 400)}. Tell Carl it didn't happen.`)
        : controlLine("result", `The agent answered (request ${r.id}): ${speakMath(clip(r.text, RESULT_CAP))}\n${TELL_RESULT}`),
    });
    at = Math.max(at, r.at);
  }
  const c = convId ? pictureOf(d.vault, convId) : null;
  if (c) {
    const asking = c.meta.asking;
    if (asking && asking.at > at) {
      const opts = asking.options?.length ? ` (options: ${asking.options.join(" / ")})` : "";
      updates.push({ id: `q-${asking.at}`, kind: "question", speak: true, text: controlLine("question", `The agent asks Carl: ${speakMath(clip(oneLine(asking.question ?? ""), 600))}${speakMath(opts)}. Put it to him in your words; his answer goes back with ${ASK}.`) });
      at = Math.max(at, asking.at);
    }
    if (!c.meta.running) {
      const fresh = c.items.filter((x) => x.at > cur.at && x.status !== "streaming");
      const replies = fresh.filter((x) => x.kind === "assistant" && x.via !== "voice" && s(x.text).trim());
      if (replies.length) {
        const asked = fresh.some((x) => x.kind === "user" && x.via === "voice-ask");
        const typed = [...fresh].reverse().find((x) => x.kind === "user" && x.via !== "voice" && x.via !== "voice-ask");
        const failed = fresh.filter((x) => x.kind === "notice" && x.level === "error").map((x) => oneLine(s(x.text)));
        // The agent writes LaTeX for the chat (which renders it); the voice gets its math in words (server/speakMath.ts).
        const answer = speakMath(clip(replies.slice(-3).map((x) => s(x.text).trim()).join("\n"), RESULT_CAP));
        const last = replies[replies.length - 1]!;
        if (asked) {
          updates.push({
            id: `r-${last.id}`,
            kind: "result",
            speak: true,
            text: controlLine("result", `The agent answered: ${answer}${failed.length ? `\n(Its turn reported: ${clip(failed.join(" "), 300)})` : ""}\n${TELL_RESULT}`),
          });
        } else if (typed && last.at > typed.at) {
          // One agent on every surface: what the agent answered to his typed message is spoken by the call, in full
          // (code blocks and tables skipped), and the voice never answers the typed message itself.
          const spoken = speakMath(spokenReply(replies.filter((x) => x.at > typed.at).map((x) => s(x.text).trim()).join("\n\n")));
          if (spoken)
            updates.push({
              id: `t-${last.id}`,
              kind: "result",
              speak: true,
              text: controlLine("result", `Carl typed in the chat: "${speakMath(clip(oneLine(s(typed.text)), 300))}". The agent answered there. Read its answer to him aloud as it is, in full; don't answer his message yourself and add nothing:
${spoken}`),
            });
        } else {
          updates.push({ id: `c-${last.id}`, kind: "context", speak: false, text: controlLine("context", `Carl typed in the chat${typed ? `: "${speakMath(clip(oneLine(s(typed.text)), 300))}"` : ""}. The agent answered there: "${clip(oneLine(answer), 600)}". Already answered: don't answer it aloud.`) });
        }
      } else if (fresh.some((x) => x.kind === "notice" && x.level === "error") && fresh.some((x) => x.kind === "user" && x.via === "voice-ask")) {
        const why = fresh.filter((x) => x.kind === "notice" && x.level === "error").map((x) => oneLine(s(x.text))).join(" ");
        updates.push({ id: `f-${fresh[fresh.length - 1]!.id}`, kind: "result", speak: true, text: controlLine("result", `The agent could not do it: ${clip(why, 400)}. Tell Carl it didn't happen.`) });
      }
      if (fresh.length) at = Math.max(at, ...fresh.map((x) => x.at));
    }
  }
  if (o.you !== false) {
    const y = youLayer(d.vault, { since: cur.you, convId });
    if (y.text.trim()) updates.push({ id: `y-${y.until}`, kind: "you", speak: false, text: controlLine("context", `What Carl just did on his other surfaces (already handled; use it if he refers to it):\n${speakMath(y.text)}`) });
    you = Math.max(you, y.until);
  }
  return { updates, at, you };
}

/** GET /api/v1/voice/updates?convId=&cursor=&wait=: long-polled (≤ 25 s). No cursor: the current one, no updates. */
export async function voiceUpdates(
  d: VoiceDeps,
  q: { convId?: string | null; cursor?: string | null; waitMs?: number; signal?: { closed: boolean }; session?: string | null },
): Promise<{ updates: VoiceUpdate[]; cursor: string; moved?: { to: VoiceDevice; line: string } }> {
  const now = Date.now();
  // Another device took this session over: it hears nothing more, and is told so (its client ends the call).
  const movedNow = () => {
    const to = supersededBy(q.session);
    return to ? { to, line: movedLine(to) } : null;
  };
  const cur = parseCursor(q.cursor);
  const m0 = movedNow();
  if (m0) return { updates: [], cursor: s(q.cursor) || cursorOf(now, now), moved: m0 };
  if (!cur) return { updates: [], cursor: cursorOf(now, now) };
  touchSession(q.session);
  const convId = s(q.convId).trim() || null;
  const deadline = now + Math.max(0, Math.min(Number(q.waitMs) || 0, 25_000));
  voiceActivity(d.vault);
  await speechReady();
  let lastYou = 0;
  for (let i = 0; ; i++) {
    // The layer reads the activity log, the newest board and the notes: every 2 s, not every look.
    const withYou = Date.now() - lastYou >= 2000;
    if (withYou) lastYou = Date.now();
    const m = movedNow();
    if (m) return { updates: [], cursor: cursorOf(cur.at, cur.you), moved: m };
    const r = voiceUpdatesSince(d, convId, cur, { you: withYou });
    if (r.updates.length || Date.now() >= deadline || q.signal?.closed) return { updates: r.updates, cursor: cursorOf(r.at, r.you) };
    cur.at = r.at;
    cur.you = r.you;
    await new Promise((res) => setTimeout(res, 400));
  }
}

// ---------------------------------------------------------------- the session's context

/** The conversation as voice reads it: pi's session folded (the latest compaction summary, then the recent lines,
 * typed and spoken), oldest first. "" for none. */
export function conversationBlock(vault: string, convId: string | null, budget = 6000): string {
  const p: Picture | null = convId ? pictureOf(vault, convId) : null;
  if (!p) return "";
  const items = p.items;
  let from = 0;
  let summary = "";
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind === "compaction") {
      summary = s(items[i]!.text).trim();
      from = i + 1;
      break;
    }
  }
  const who = (x: Item) =>
    x.kind === "user" ? (x.via === "voice" ? "Carl (voice)" : x.via === "voice-ask" ? "Carl (by voice, handed to the agent)" : "Carl") : x.via === "voice" ? "You (voice)" : "Agent";
  // The lines, and the agent's tool calls between them as one short line per run of calls.
  const lines: string[] = [];
  let calls: string[] = [];
  const flush = () => {
    if (calls.length) lines.push(`(the agent ran ${calls.slice(0, 6).join(", ")}${calls.length > 6 ? `, and ${calls.length - 6} more` : ""})`);
    calls = [];
  };
  for (const x of items.slice(from)) {
    if (x.kind === "tool" && x.via !== "voice") calls.push(toolLine(x));
    else if ((x.kind === "user" || x.kind === "assistant") && (s(x.text).trim() || x.images?.length)) {
      flush();
      lines.push(`${who(x)}: ${clip(s(x.text).trim(), 400)}${imagesNote(vault, x)}`);
    }
  }
  flush();
  const cut = Math.max(0, lines.length - 30);
  lines.splice(0, cut);
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  let start = 0;
  while (start < lines.length - 1 && total > budget) total -= lines[start++]!.length + 1;
  const parts = [`This conversation — "${clip(s(p.meta.title), 120)}" (id ${p.id}). Its record so far, oldest first; you speak for it, "Agent" is the agent you hand requests to:`];
  if (summary) parts.push(`Earlier (the agent's summary of what came before):\n${clip(summary, 2500)}`);
  if (start + cut > 0) parts.push(`(${start + cut} earlier line${start + cut === 1 ? "" : "s"} left out)`);
  parts.push(...lines.slice(start));
  if (p.meta.running) parts.push("(The agent is working on something in this conversation right now.)");
  if (p.meta.asking) parts.push(`(The agent is waiting for Carl's answer to: "${clip(oneLine(s(p.meta.asking.question)), 300)}".)`);
  return parts.join("\n");
}

/** A tool call of the agent's, in a few words: its name and what it was about (never its whole input or result). */
function toolLine(x: Item): string {
  const a = (x.args && typeof x.args === "object" ? x.args : {}) as Record<string, unknown>;
  const about = ["title", "path", "query", "question", "request", "command", "id"].map((k) => a[k]).find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return `${x.name ?? "a tool"}${about ? ` "${clip(oneLine(about), 80)}"` : ""}${x.status === "error" ? " — it failed" : ""}`;
}

/** A line's images, said honestly: sent (its pixels come with the call on the phone and the board), or empty. */
function imagesNote(vault: string, x: Item): string {
  const imgs = x.images ?? [];
  if (!imgs.length) return "";
  const empty = imgs.filter((im) => !/^data:[^,]*,./.test(im.dataUrl ?? "") && !fileBytes(vault, im.path)).length;
  const ok = imgs.length - empty;
  const said = ok ? ` [sent ${ok === 1 ? "an image" : `${ok} images`}]` : "";
  return `${said}${empty ? ` [${empty === 1 ? "an image" : `${empty} images`} arrived empty: you have NOT seen ${empty === 1 ? "it" : "them"}]` : ""}`;
}

function fileBytes(vault: string, rel: string): number {
  if (!rel || rel.includes("..")) return 0;
  try {
    return statSync(join(vault, ...rel.split("/"))).size;
  } catch {
    return 0;
  }
}

/** The conversation's newest images (≤ `max`, newest last) as data, for a phone or board call's start (the laptop
 * pushes them from its own copy). Empty or missing ones are counted, never sent. */
export function threadImages(vault: string, convId: string | null, max = 3): { images: { mime: string; dataBase64: string }[]; empty: number } {
  const out: { mime: string; dataBase64: string }[] = [];
  let empty = 0;
  const p = convId ? pictureOf(vault, convId) : null;
  if (!p) return { images: out, empty };
  const picked: { path: string; dataUrl?: string }[] = [];
  for (const x of [...p.items].reverse()) {
    for (const im of x.images ?? []) if (picked.length < max) picked.push(im);
    if (picked.length >= max) break;
  }
  for (const im of picked.reverse()) {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(im.dataUrl ?? "");
    if (m) {
      out.push({ mime: m[1]!, dataBase64: m[2]! });
      continue;
    }
    const n = fileBytes(vault, im.path);
    if (!n || n > 8 * 1024 * 1024) {
      empty++;
      continue;
    }
    const ext = (im.path.split(".").pop() ?? "").toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
    out.push({ mime, dataBase64: readFileSync(join(vault, ...im.path.split("/"))).toString("base64") });
  }
  return { images: out, empty };
}

/** The vault's files for the laptop's ShowFile / ScrollTo, the cheap way: git's index (capped), minus .vault-chat. */
export async function fileIndex(vault: string, cap = 2000): Promise<string[]> {
  try {
    const r = await runGit(vault, ["ls-files", "--cached", "--others", "--exclude-standard"]);
    if (r.code !== 0) return [];
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith(".vault-chat/"))
      .slice(0, cap);
  } catch {
    return [];
  }
}

/** "Current date and time: …" — the voice's "now" (never inferred from files). */
function nowNote(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const stamp = new Intl.DateTimeFormat("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short", timeZone: tz }).format(new Date());
    return `Current date and time: ${stamp}.`;
  } catch {
    return "";
  }
}

const capped = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}\n…[truncated for voice]` : t);

/** The session's prompt for `convId` on `device` (src/voicePrompt.ts buildVoicePrompt): the vault's voice.md or the
 * default header, the honesty and Ask rules, the device's truth, Carl's rules, the conversation, the "you" layer. */
export async function voicePrompt(d: VoiceDeps, convId: string | null, device: VoiceDevice): Promise<string> {
  const meta = await import("../src/meta");
  const { loadSessionContext } = await import("../src/context");
  // (No memory block: the vault's memory is the agent's to read and write — voice has no files of its own.)
  const [header, northStar, rules] = await Promise.all([
    meta.loadVaultVoicePrompt(d.vault).catch(() => ""),
    meta.loadVaultNorthStar(d.vault).catch(() => ""),
    loadSessionContext(d.vault).catch(() => ""),
  ]);
  const p = convId ? pictureOf(d.vault, convId) : null;
  const project = typeof p?.meta.project === "string" && p.meta.project ? await projectContextFor(d.vault, p.meta.project) : "";
  return buildVoicePrompt({
    device,
    header,
    now: nowNote(),
    northStar: meta.northStarPromptBlock(northStar),
    rules: capped(rules, 6000),
    project,
    // What the voice may read out, with its math in words (the chat keeps the LaTeX).
    conversation: (await speechReady(), speakMath(conversationBlock(d.vault, convId))),
    you: speakMath(youLayer(d.vault, { convId }).text),
    ...(device === "laptop" ? { fileIndex: await fileIndex(d.vault), vaultRoot: d.vault } : {}),
  });
}

// ---------------------------------------------------------------- the session

/** GET /api/v1/voice/session: a signed ElevenLabs URL (and a WebRTC token) for the box's voice agent on `device`
 * (provisioned with that device's tools, src/voicePrompt.ts voiceToolDefs), and the prompt for the conversation
 * `convId` it is attached to (none: a new conversation, made by its first line or request). The key never leaves the box. */
export async function voiceSession(
  convId: string | null,
  d: VoiceDeps,
  choice: { llm?: string | null; voice?: string | null; device?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const v = await import("../src/voice-elevenlabs");
  const device = voiceDevice(choice.device);
  // The laptop's Settings choice (voice model, voice): the box's agent follows it; a changed model re-provisions.
  if (choice.llm && v.SUPPORTED_VOICE_LLMS.has(choice.llm)) localStorage.setItem("vault_chat_elevenlabs_llm", choice.llm);
  if (choice.voice && /^[A-Za-z0-9]{8,40}$/.test(choice.voice)) localStorage.setItem("vault_chat_elevenlabs_voice", choice.voice);
  v.resetAgentCreateBreaker();
  // One provisioned agent per vault and device (each device's own tools).
  const slot = `${d.main === false ? `vault:${d.name ?? d.vault}` : "main"}:${device}`;
  const agent = await v.voiceAgent({ device, slot });
  if (!agent) {
    const err = v.getLastAgentCreateError();
    return {
      status: 503,
      body: {
        error: err
          ? /^voice [A-Za-z0-9]+: /.test(err.body)
            ? `ElevenLabs won't use the picked ${err.body.slice(0, 400)} — pick another voice in Settings → Voice`
            : `ElevenLabs agent could not be provisioned (HTTP ${err.status})`
          : "voice is not ready on the box (no ElevenLabs key — the laptop's Settings sends it)",
      },
    };
  }
  // One voice at a time: a live call on another device moves here, with its conversation.
  const { session, from } = startLiveVoice(d.vault, device, await attached(d, convId, false));
  const id = await attached(d, session.convId, false);
  session.convId = id;
  if (from && id) {
    // Said in the thread where it happened (a note: shown, not in the agent's context).
    await writeNotes(d.vault, id, [{ kind: "notice", text: `Voice moved from the ${deviceLabel(from.device)} to the ${deviceLabel(device)}.`, level: "info", clientId: `voice-move-${session.id}` }]);
    d.onWrite?.();
  }
  const systemPrompt = await voicePrompt(d, id, device);
  const cursor = cursorOf(Date.now(), Date.now());
  // Both credentials, minted at once: a WebRTC conversation token (the recommended transport) and a signed URL (WebSocket).
  const [signedUrl, conversationToken] = await Promise.all([v.getSignedUrl(agent.elKey, agent.agentId, slot), v.getConversationToken(agent.elKey, agent.agentId)]);
  if (!signedUrl && !conversationToken) return { status: 502, body: { error: "ElevenLabs refused a signed URL and a conversation token" } };
  // Someone is about to talk: the box is busy until the session's end line (or VOICE_IDLE_MS of silence).
  voiceActivity(d.vault);
  const imgs = device === "laptop" ? { images: [], empty: 0 } : threadImages(d.vault, id);
  return {
    status: 200,
    body: {
      signedUrl,
      conversationToken,
      agentId: agent.agentId,
      voiceId: agent.voiceId,
      systemPrompt,
      dynamicVariables: device === "laptop" ? { viewport_context: "(no document open)" } : {},
      toolNames: voiceToolNames(device),
      device,
      convId: id,
      cursor,
      images: imgs.images,
      ...(imgs.empty ? { emptyImages: imgs.empty } : {}),
      // Where the prompt's paths point (the laptop maps them back for ScrollTo).
      vaultRoot: d.vault,
      onBox: true,
      // This call's id: its lines, tools and polls carry it, so the box can tell it when another device takes over.
      sessionId: session.id,
      ...(from ? { handoff: { from: from.device, convId: id } } : {}),
    },
  };
}
