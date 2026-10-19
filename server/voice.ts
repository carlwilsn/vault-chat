// Voice on the box (D3: one brain). Voice is the front of house of ONE
// conversation — the chat Carl attached it to: its prompt is that
// conversation's pi session (what was typed and said, the compaction summary)
// plus the "you" layer; every line said on the call goes into that session (a
// vc-voice custom message: the agent hears it on its next turn); and every
// action is the agent's: voice's one tool that acts, Ask, hands Carl's request
// to pi in that conversation and returns at once, and the agent's answer comes
// back into the live call through /updates. Tools that read or move a screen
// run on the device in front of Carl (src/voicePrompt.ts SCREEN_TOOLS).
//
// Routes (http.ts), each with an optional vault:
//   GET  /api/v1/voice/session    ?convId=&device=            → {conversationToken, signedUrl, systemPrompt, toolNames, convId, cursor, images, …}
//   POST /api/v1/voice/tool       {name, args, convId, device} → {result, convId?}
//   POST /api/v1/voice/transcript {convId, role, text, system?, ended?, tool?, images?, clientId?, device?} → {convId}
//   GET  /api/v1/voice/updates    ?convId=&cursor=&wait=      → {updates: [{id, kind, text, speak}], cursor}
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fsCommands } from "./commands/fs";
import { runGit } from "./git";
import { createConv, logOf, newMessageId, pictureOf, writeNotes, type NoteData } from "./engine/convs";
import { appendActivity, projectContextFor, youLayer } from "./activity";
import { voiceLineEntry } from "../src/activityCore";
import { stripAudioTags } from "../src/voiceTags";
import { speakMath, speechReady } from "./speakMath";
import { ASK, SCREEN_TOOLS, buildVoicePrompt, controlLine, isControlLine, voiceDevice, voiceToolNames, type VoiceDevice } from "../src/voicePrompt";
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

function listLines(cmd: "read_deny_lines" | "read_humanized", vault: string): string[] {
  try {
    const v = (fsCommands[cmd] as any)({ vault });
    return Array.isArray(v) ? v.map((x: unknown) => s(x).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean) : [];
  } catch {
    return [];
  }
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
  for (const d of listLines("read_deny_lines", vault)) if (under(rel, d)) throw `Refused: ${rel} is restricted from the agent.`;
  if (mode === "write") for (const h of listLines("read_humanized", vault)) if (rel === h) throw `Refused: ${rel} is a humanized file; the agent does not write it.`;
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
  voiceActivity(d.vault, ended);
  if (!text || (role === "user" && !system && isControlLine(text))) return { status: 200, body: { ok: true, convId: s(b?.convId) || null, skipped: true } };
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

/** POST /api/v1/voice/tool {name, args, convId, device}. Never throws: errors are the result the voice hears. */
export async function voiceTool(d: VoiceDeps, body: any): Promise<{ result: string; convId?: string }> {
  const name = s(body?.name);
  const args = body?.args ?? body?.arguments ?? body?.parameters ?? {};
  if (!name) return { result: "Error: missing tool name." };
  voiceActivity(d.vault);
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

/** What the agent is told with a request voice handed over (before Carl's words; not shown in the chat). */
export const ASK_CONTEXT =
  "[Carl asked this by voice, on a call (his spoken lines are in this conversation). Do it now, in place; then answer in two or three plain sentences: they are read out to him. Say only what you did and checked.]";

/** A request id: the pi message's client id (its item in the transcript). */
const requestId = () => `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Ask {request}: Carl's request to the conversation's agent, as a pi turn in the attached conversation (or into
 * its running turn, or as the answer to its open question). Returns at once — never waits on the agent, so no
 * timeout of the call (ElevenLabs' 30 s for a tool, its cascade's 15 s) can drop it; the answer comes back
 * through /updates. */
async function ask(d: VoiceDeps, a: Record<string, unknown>, convId: unknown, device: VoiceDevice): Promise<{ result: string; convId?: string }> {
  const request = s(a.request ?? a.task).trim();
  if (!request) return { result: `Error: ${ASK} needs the request (Carl's words). Nothing was handed over.` };
  if (!d.message) return { result: "Error: the agent is not running on the box, so nothing was handed over. Tell Carl it didn't go through." };
  const id = await attached(d, convId, true, request);
  const rid = requestId();
  const out = await d.message({ convId: id, text: request, source: "voice", via: "voice-ask", clientMsgId: rid, client: device, context: ASK_CONTEXT });
  if (!out || out.error) return { result: `Error: the agent did not take it (${s(out?.error) || "no answer"}). Nothing was done — tell Carl.`, convId: id };
  const now = out.answered
    ? `The agent had asked Carl a question; this went to it as his answer (request ${rid}).`
    : out.steered
      ? `The agent was already working in this conversation; this was added to its work (request ${rid}).`
      : `The agent has it (request ${rid}) and is working on it in this conversation.`;
  return { result: `${now} Its answer will come to you as a message starting [vc:result]. Now say only a short line ("on it"); don't say it is done and don't guess the answer.`, convId: id };
}

// ---------------------------------------------------------------- updates into the live call

/** One thing to put into a live call: `speak` (a [vc:result] / [vc:question] user message the voice answers
 * aloud) or not (a [vc:context] contextual update: already handled, never answered). */
export type VoiceUpdate = { id: string; kind: "result" | "question" | "context" | "you"; text: string; speak: boolean };

const RESULT_CAP = 1500;
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
            text: controlLine("result", `The agent answered: ${answer}${failed.length ? `\n(Its turn reported: ${clip(failed.join(" "), 300)})` : ""}\nTell Carl now, briefly, in your own words — only what it says.`),
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
export async function voiceUpdates(d: VoiceDeps, q: { convId?: string | null; cursor?: string | null; waitMs?: number; signal?: { closed: boolean } }): Promise<{ updates: VoiceUpdate[]; cursor: string }> {
  const now = Date.now();
  const cur = parseCursor(q.cursor);
  if (!cur) return { updates: [], cursor: cursorOf(now, now) };
  const convId = s(q.convId).trim() || null;
  const deadline = now + Math.max(0, Math.min(Number(q.waitMs) || 0, 25_000));
  voiceActivity(d.vault);
  await speechReady();
  let lastYou = 0;
  for (let i = 0; ; i++) {
    // The layer reads the activity log, the newest board and the notes: every 2 s, not every look.
    const withYou = Date.now() - lastYou >= 2000;
    if (withYou) lastYou = Date.now();
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

/** The vault's files for the laptop's ShowFile / ScrollTo, the cheap way: git's index (capped), minus .vault-chat and denied entries. */
export async function fileIndex(vault: string, cap = 2000): Promise<string[]> {
  try {
    const r = await runGit(vault, ["ls-files", "--cached", "--others", "--exclude-standard"]);
    if (r.code !== 0) return [];
    const deny = listLines("read_deny_lines", vault);
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith(".vault-chat/") && !deny.some((x) => under(l, x)))
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
  const id = await attached(d, convId, false);
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
    },
  };
}
