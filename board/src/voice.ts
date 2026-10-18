// Voice on the board: the box's voice path, the one the phone uses (server/voice.ts) —
// GET /api/v1/voice/session mints the ElevenLabs session for the box's one voice agent,
// its tools run on the box (POST /api/v1/voice/tool, AskAgent hands work to the agent,
// which sends to the board with BoardSend/BoardMake), and its lines are saved there as a
// voice conversation (POST /api/v1/voice/transcript). No agent, tool or memory of its own.
//
// Which conversation: Carl's most recently active chat (GET /conversations, the phone's
// list and filter) — the session's prompt is built from that thread. Another chat can be
// picked; that restarts the session on it.
//
// What the board adds: while live, the voice agent knows the board. At the start, and
// 1.5 s after the pen lifts, a contextual update (the board's name, the inbox parts placed
// on it with their labels) and a downscaled picture of the visible region through the
// laptop's image path (src/voiceImages.ts: keyed, so an unchanged picture is never sent
// again), both held while the agent speaks (src/voiceQuiet.ts). A landed inbox entry is
// mentioned at the next pause, as on the laptop.
//
// The transport is WebRTC (ElevenLabs' recommended one: echo cancellation, jitter
// buffer) with the box's conversation token; WebSocket with the signed URL when the
// box has no token or WebRTC can't connect. One mic stream, the SDK's: the tap asks
// for the mic (Safari wants the gesture) and lets it go at once; the waves read the
// SDK's own levels.
//
// No DOM here: the pill (voicePill.ts) draws it, the tests drive it with a fake SDK.
import { QuietGate } from "../../src/voiceQuiet";
import { VoiceImagePusher, lookingAtNote, sendFilesMessage } from "../../src/voiceImages";
import { stripAudioTags } from "../../src/voiceTags";
import type { Item } from "../../src/boardFormat";
import type { ChatRow, VoiceConfig } from "./api";

/** The SDK's conversation, as much of it as the board uses. */
export type VoiceConv = {
  endSession(): Promise<void>;
  setMicMuted(m: boolean): void;
  sendContextualUpdate(text: string, o?: { contextId?: string }): void;
  uploadFile(b: Blob): Promise<{ fileId: string }>;
  sendMultimodalMessage(m: { text?: string; fileId: string }): void;
  getOutputVolume?(): number;
  getInputVolume?(): number;
};
export type SessionOpts = {
  signedUrl?: string;
  conversationToken?: string;
  connectionType: "webrtc" | "websocket";
  overrides: unknown;
  dynamicVariables: Record<string, string>;
  clientTools: Record<string, (p: unknown) => Promise<string>>;
  onConnect(): void;
  onDisconnect(d?: { reason?: string; message?: string; closeCode?: number; closeReason?: string; context?: { type?: string; reason?: string; code?: number } }): void;
  onError(m: unknown): void;
  onMessage(m: { message: string; role: string }): void;
  onModeChange(m: { mode: string }): void;
};
export type VoiceSdk = { Conversation: { startSession(o: SessionOpts): Promise<VoiceConv> } };

export type VoiceApi = {
  listChats(): Promise<ChatRow[]>;
  voiceSession(convId: string | null): Promise<VoiceConfig>;
  voiceTool(b: { name: string; args: unknown; convId: string | null; fromConvId: string | null }): Promise<{ result?: string; error?: string }>;
  voiceTranscript(b: { convId: string | null; fromConvId: string | null; role: string; text: string; system?: boolean; ended?: boolean }): Promise<{ convId?: string | null }>;
};

/** What the board tells voice (view.ts). */
export type BoardSource = {
  slug: string;
  name(): string;
  items(): Item[];
  strokes(): number;
  /** The visible region as a downscaled JPEG (null: nothing in view). */
  snapshot(): Promise<Blob | null>;
};

export type Phase = "idle" | "connecting" | "live" | "error";
export type VoiceState = { phase: Phase; error: string; muted: boolean; speaking: boolean; chat: ChatRow | null; chats: ChatRow[] };

/** The chats the phone lists: not the old missions system's threads. */
const NOT_CHATS = new Set(["ask", "worker", "mission"]);
export const recentChats = (rows: ChatRow[]) => rows.filter((c) => !NOT_CHATS.has(c.source)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));

/** One line naming an item on the board (its inbox label when it has one). */
function itemName(it: Item): string {
  const label = typeof it.label === "string" && it.label.trim() ? it.label.trim() : "";
  if (label) return `"${label.slice(0, 80)}"`;
  if (it.kind === "pdf") return `a PDF page${typeof it.page === "number" ? ` (page ${it.page})` : ""}`;
  return `${it.kind === "image" ? "an" : "a"} ${it.kind}${typeof it.alt === "string" && it.alt ? ` ("${it.alt.slice(0, 80)}")` : ""}`;
}

/** The contextual update: the board, the inbox parts on it (with their labels), the ink. */
export function boardContextText(b: { name: string; items: Item[]; strokes: number }): string {
  const fromInbox = b.items.filter((it) => it.inbox && typeof it.inbox === "object");
  const own = b.items.length - fromInbox.length;
  const lines = [`[Carl is on his iPad whiteboard, the board "${b.name.slice(0, 120)}".`];
  if (fromInbox.length) {
    const shown = fromInbox.slice(0, 20).map((it) => `${itemName(it)} (${it.kind})`);
    lines.push(`Placed on it from the board inbox: ${shown.join(", ")}${fromInbox.length > 20 ? `, and ${fromInbox.length - 20} more` : ""}.`);
  } else lines.push("Nothing from the board inbox is on it.");
  if (own) lines.push(`${own} picture${own === 1 ? "" : "s"} he inserted himself.`);
  lines.push(b.strokes ? `${b.strokes} stroke${b.strokes === 1 ? "" : "s"} of his handwriting.` : "No handwriting yet.");
  lines.push("A picture of what he sees comes with this when it changes. To put something on his board, ask the agent to send it to the board inbox. Don't describe the board unless he asks.]");
  return lines.join(" ");
}

/** FNV-1a over a picture's bytes: its key for the image path's dedupe. */
export async function blobKey(b: Blob): Promise<string> {
  const u = new Uint8Array(await b.arrayBuffer());
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i]!, 0x01000193);
  return `${(h >>> 0).toString(16)}-${u.length}`;
}

/** A start that failed, said plainly. */
export function micError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access is off. Allow it in Settings → Apps → Safari, then tap the mic.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found on this iPad.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return `The microphone didn't start: ${String((e as Error)?.message ?? e)}`;
}

export type VoiceDeps = {
  api: VoiceApi;
  sdk: () => Promise<VoiceSdk>;
  /** The mic stream (getUserMedia); throws as it does. Null: this page can't have a mic (not HTTPS). */
  mic: (() => Promise<MediaStream>) | null;
  /** Called synchronously in the tap, before anything awaits (iOS: audio must be unlocked in the gesture). */
  unlock?: () => void;
  debounceMs?: number;
  connectTimeoutMs?: number;
};

export class VoiceController {
  state: VoiceState = { phase: "idle", error: "", muted: false, speaking: false, chat: null, chats: [] };
  private listeners = new Set<(s: VoiceState) => void>();
  private conv: VoiceConv | null = null;
  private stream: MediaStream | null = null;
  private board: BoardSource | null = null;
  private gate = new QuietGate(() => this.state.speaking);
  private pusher = new VoiceImagePusher();
  private lastText = "";
  private debounceT: ReturnType<typeof setTimeout> | null = null;
  /** The session's own voice conversation (once a line made it) and the chat it continues. */
  private voiceConv: string | null = null;
  private lines: Promise<unknown> = Promise.resolve();
  private gen = 0;
  /** Updates and pictures sent this session (for the preview and the tests). */
  readonly sent = { updates: [] as string[], images: 0 };

  constructor(private d: VoiceDeps) {}

  on(fn: (s: VoiceState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }
  private set(p: Partial<VoiceState>): void {
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn(this.state);
  }

  /** The agent's output level, 0..1 (the pill's waves while it speaks). */
  outputLevel(): number {
    try {
      return this.state.speaking ? Math.min(1, (this.conv?.getOutputVolume?.() ?? 0) * 2.5) : 0;
    } catch {
      return 0;
    }
  }
  /** Carl's mic level, 0..1, from the SDK's own stream (flat while muted). */
  inputLevel(): number {
    try {
      return this.state.muted ? 0 : Math.min(1, (this.conv?.getInputVolume?.() ?? 0) * 2.5);
    } catch {
      return 0;
    }
  }
  /** How the live call connected (diagnostics). */
  transport: "webrtc" | "websocket" | null = null;
  /** The last close, with its reason (diagnostics). */
  lastClose: Record<string, unknown> | null = null;

  /** The mic button. */
  toggle(): void {
    if (this.state.phase === "live" || this.state.phase === "connecting") void this.end();
    else void this.start();
  }

  async start(chatId?: string): Promise<void> {
    if (this.state.phase === "live" || this.state.phase === "connecting") return;
    const gen = ++this.gen;
    try {
      this.d.unlock?.();
    } catch {
      /* no audio to unlock */
    }
    this.set({ phase: "connecting", error: "", muted: false, speaking: false });
    if (!this.d.mic) return this.fail(gen, "This page isn't on HTTPS, so Safari won't open the microphone. Open the board from its https://…ts.net address.");
    // The mic first, while the tap is still the gesture that asked for it.
    try {
      this.stream = await this.d.mic();
    } catch (e) {
      return this.fail(gen, micError(e));
    }
    // Permission only: the SDK opens the one mic stream the call uses.
    this.dropMic();
    if (gen !== this.gen) return;
    let chats: ChatRow[] = [];
    try {
      chats = recentChats(await this.d.api.listChats());
    } catch {
      /* no list: a session with no thread behind it */
    }
    const chat = (chatId ? chats.find((c) => c.id === chatId) : null) ?? chats[0] ?? null;
    this.set({ chats, chat });
    let cfg: VoiceConfig | null = null;
    let why = "";
    for (let a = 0; a < 3 && !cfg; a++) {
      try {
        cfg = await this.d.api.voiceSession(chat?.id ?? null);
      } catch (e) {
        why = String((e as Error)?.message ?? e);
        // The box said why (no key, a refused voice): no use asking again.
        if ((e as { status?: number })?.status === 503) break;
        if (a < 2) await new Promise((r) => setTimeout(r, 600 * (a + 1)));
      }
      if (gen !== this.gen) return;
    }
    if (!cfg) return this.fail(gen, why ? `Voice couldn't start: ${why}` : "Voice couldn't start.");
    this.voiceConv = null;
    this.lastText = "";
    this.pusher.reset();
    const from = chat?.id ?? null;
    try {
      const sdk = await this.d.sdk();
      let timedOut = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const token = cfg.conversationToken || null;
      const signed = cfg.signedUrl || null;
      let transport: "webrtc" | "websocket" = token ? "webrtc" : "websocket";
      const creds = () => (transport === "webrtc" ? { conversationToken: token!, connectionType: transport } : { signedUrl: signed!, connectionType: transport });
      const open = () => sdk.Conversation.startSession({
        ...creds(),
        overrides: { agent: { prompt: { prompt: cfg.systemPrompt || "" }, language: "en", firstMessage: "" }, tts: { voiceId: cfg.voiceId } },
        dynamicVariables: cfg.dynamicVariables || {},
        clientTools: this.clientTools(cfg.toolNames ?? [], from),
        onConnect: () => {
          if (timedOut || gen !== this.gen) return;
          this.set({ phase: "live", error: "" });
          this.pushNow();
        },
        onDisconnect: (d) => {
          this.lastClose = { transport, reason: d?.reason, message: d?.message, code: d?.closeCode ?? d?.context?.code, closeReason: d?.closeReason ?? d?.context?.reason };
          console.warn("[board-voice] closed", JSON.stringify(this.lastClose));
          if (!timedOut && gen === this.gen) this.teardown(this.state.phase === "connecting" ? "The voice connection closed before it started." : "");
        },
        onError: (m) => {
          if (gen === this.gen && this.state.phase !== "live") this.set({ error: typeof m === "string" ? m : ((m as Error)?.message ?? "voice error") });
        },
        onMessage: ({ message, role }) => {
          const raw = (message || "").trim();
          const text = role === "user" ? raw : stripAudioTags(raw);
          if (text) this.saveLine(role === "user" ? "user" : "assistant", text, from);
        },
        // Leaving "speaking" = the playback drained: the held pushes go after a settle.
        onModeChange: ({ mode }) => {
          this.set({ speaking: mode === "speaking" });
          this.gate.modeChanged();
        },
      });
      // WebRTC that can't connect (a network that blocks it): once more over WebSocket.
      const session = open().catch((e) => {
        if (transport !== "webrtc" || !signed || timedOut || gen !== this.gen || /NotAllowed|NotFound|NotReadable|Permission/i.test(String((e as Error)?.name) + String((e as Error)?.message))) throw e;
        console.warn("[board-voice] WebRTC failed, retrying over WebSocket:", String((e as Error)?.message ?? e));
        transport = "websocket";
        return open();
      });
      session
        .then((c) => {
          if (timedOut) void c.endSession().catch(() => {});
        })
        .catch(() => {});
      const conv = await Promise.race([
        session,
        new Promise<never>((_, rej) => {
          watchdog = setTimeout(() => {
            timedOut = true;
            rej(new Error("the connection timed out after 15 s"));
          }, this.d.connectTimeoutMs ?? 15_000);
        }),
      ]);
      clearTimeout(watchdog);
      if (gen !== this.gen) {
        void conv.endSession().catch(() => {});
        return;
      }
      this.conv = conv;
      this.transport = transport;
      // The SDK may connect before startSession resolves: what onConnect couldn't send yet goes now.
      if ((this.state.phase as Phase) === "live") this.pushNow();
    } catch (e) {
      return this.fail(gen, `Voice couldn't connect: ${String((e as Error)?.message ?? e)}`);
    }
  }

  async end(): Promise<void> {
    const c = this.conv;
    this.gen++;
    this.conv = null;
    try {
      await c?.endSession();
    } catch {
      /* already closed */
    }
    this.teardown("");
  }

  setMuted(m: boolean): void {
    this.set({ muted: m });
    try {
      this.conv?.setMicMuted(m);
    } catch {
      /* closed */
    }
  }

  /** Continue another chat: the session restarts on it (its prompt is built from that thread). */
  async switchChat(id: string): Promise<void> {
    if (this.state.chat?.id === id && this.state.phase === "live") return;
    const keep = this.state.chats;
    await this.end();
    this.set({ chats: keep });
    await this.start(id);
  }

  /** The chat list as the box has it now (the pill's switcher). */
  refreshChats(rows: ChatRow[]): void {
    this.set({ chats: recentChats(rows) });
  }

  /** The red state's close: back to idle. */
  dismiss(): void {
    if (this.state.phase === "error") this.set({ phase: "idle", error: "" });
  }

  /** The board on screen (null: none). */
  setBoard(b: BoardSource | null): void {
    if (this.board === b) return;
    this.board = b;
    this.lastText = "";
    if (b) this.pushNow();
  }
  /** The board changed (a pen-up, an eraser, a move, an add): tell voice once it has been still for a moment. */
  boardChanged(b: BoardSource): void {
    if (this.board !== b || this.state.phase !== "live") return;
    if (this.debounceT) clearTimeout(this.debounceT);
    this.debounceT = setTimeout(() => {
      this.debounceT = null;
      this.pushNow();
    }, this.d.debounceMs ?? 1500);
  }

  /** A line to mention at the next natural pause (the inbox: "… is in your board inbox."). */
  announce(line: string): void {
    const conv = this.conv;
    if (!conv || !line.trim()) return;
    this.gate.run(`announce:${line}`, () => {
      if (this.conv !== conv) return;
      try {
        conv.sendContextualUpdate(`Heads-up for Carl, to mention in one short sentence at the next natural pause (do not interrupt him): ${line.trim()}`);
      } catch {
        /* closed */
      }
    });
  }

  /** The board's context and picture, now (each held while the agent speaks). */
  pushNow(): void {
    const conv = this.conv, b = this.board;
    if (!conv || !b || this.state.phase !== "live") return;
    const text = boardContextText({ name: b.name(), items: b.items(), strokes: b.strokes() });
    if (text !== this.lastText) {
      this.lastText = text;
      this.gate.run("board", () => {
        if (this.conv !== conv) return;
        try {
          // A stable context id: the newer board state replaces the older (never a user turn).
          conv.sendContextualUpdate(text, { contextId: "board" });
          this.sent.updates.push(text);
        } catch {
          /* closed */
        }
      });
    }
    void b.snapshot().then(async (blob) => {
      if (!blob || this.conv !== conv) return;
      const key = `board:${b.slug}:${await blobKey(blob)}`;
      if (this.pusher.has(key)) return;
      this.gate.run("board-image", () => {
        const sink = { uploadFile: (x: Blob) => conv.uploadFile(x), sendMultimodalMessage: (m: { text?: string; fileId: string }) => conv.sendMultimodalMessage(m) };
        void this.pusher
          .pushMany({ ...sink, sendFiles: (t, ids) => sendFilesMessage(sink, t, ids) }, [{ key, blob }], lookingAtNote(`his whiteboard "${b.name()}"`, "the part in view"), () => this.conv === conv)
          .then((r) => {
            if (r[0] === "sent") this.sent.images++;
          });
      });
    }).catch(() => {});
  }

  // ---------------------------------------------------------------- the box's path

  private clientTools(names: string[], from: string | null): Record<string, (p: unknown) => Promise<string>> {
    const tools: Record<string, (p: unknown) => Promise<string>> = {};
    for (const name of names) {
      tools[name] = async (params) => {
        try {
          // SetProject's target is this session's voice conversation once a line made it.
          if (name === "SetProject") await this.lines;
          const j = await this.d.api.voiceTool({ name, args: params ?? {}, convId: this.voiceConv, fromConvId: from });
          return typeof j.result === "string" ? j.result : `error: ${j.error ?? "no result"}`;
        } catch (e) {
          return `error: ${String((e as Error)?.message ?? e)}`;
        }
      };
    }
    return tools;
  }

  /** The session's lines, saved on the box in order (the first makes its voice conversation). */
  private saveLine(role: string, text: string, from: string | null, end = false): void {
    this.lines = this.lines.then(async () => {
      try {
        const j = await this.d.api.voiceTranscript({ convId: this.voiceConv, fromConvId: from, role, text, ...(end ? { system: true, ended: true } : {}) });
        if (j && typeof j.convId === "string") this.voiceConv = j.convId;
      } catch {
        /* the box is away: the line is lost, the call goes on */
      }
    });
  }

  private fail(gen: number, why: string): void {
    if (gen !== this.gen) return;
    this.gen++;
    const c = this.conv;
    this.conv = null;
    void c?.endSession().catch(() => {});
    this.dropMic();
    this.set({ phase: "error", error: why, speaking: false });
  }

  private teardown(why: string): void {
    const was = this.state.phase;
    if (was === "live") this.saveLine("assistant", "Voice session ended.", this.state.chat?.id ?? null, true);
    if (this.debounceT) clearTimeout(this.debounceT);
    this.debounceT = null;
    this.conv = null;
    this.dropMic();
    this.set(why ? { phase: "error", error: why, speaking: false, muted: false } : { phase: "idle", error: "", speaking: false, muted: false });
  }

  private dropMic(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
  }
}
