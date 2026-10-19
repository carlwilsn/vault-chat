// Voice on the board: the front of house of one conversation (D3, server/voice.ts), as on
// the phone and the laptop — GET /api/v1/voice/session mints the ElevenLabs session for the
// box's board agent with its prompt built from the conversation's pi session; every line said
// goes into that conversation (POST /api/v1/voice/transcript); its one tool that acts, Ask,
// hands Carl's request to the conversation's agent (POST /api/v1/voice/tool), which does it
// with its own tools (BoardSend, BoardMake, BoardInbox …); and the agent's answers and what
// Carl did elsewhere reach the live call (GET /api/v1/voice/updates, src/voiceFront.ts). No
// agent, tool or memory of its own.
//
// Which conversation: the one Carl is in — his most recently active chat (GET /conversations,
// the phone's list and filter), or the one he picked in the pill (switchChat) for as long as no
// other chat has been active since. Lines go into that conversation, so it stays the most
// recent while he talks on the board: a drop, an end and a new tap, a reload all continue it
// (Carl, 2026-10-18: each restart had landed on a different conversation). A chat he then
// continues on the laptop is followed: "continue that" on the board means that chat.
//
// A session that closes by itself (the network, ElevenLabs) is said, not hidden: the pill
// turns red with the reason, and the mic continues the same thread. Every close is reported
// with who closed it and why (`onClose`, the board's log "voice.close").
//
// What the board adds: while live, the voice agent knows the board. At the start, and
// 1.5 s after the pen lifts, a contextual update (the board's name, the inbox parts placed
// on it with their labels) and a downscaled picture of the visible region through the
// laptop's image path (src/voiceImages.ts: keyed, so an unchanged picture is never sent
// again), both held while the agent speaks (src/voiceQuiet.ts). A landed inbox entry is
// mentioned at the next pause, as on the laptop.
//
// And the agent can LOOK on demand: LookAtScreen is handled here, by the board page (BOARD_LOCAL_TOOLS), never
// sent to the box (which has no screen). It takes the visible region as drawn — ink, items, typeset math, PDF
// pages — as a downscaled JPEG through the same image path (an unchanged picture is not sent twice: the tool says
// so), with the board's name and its placed items as text. The session's prompt says it can (the box's prompt for the board, src/voicePrompt.ts deviceNote).
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
import { isControlLine } from "../../src/voicePrompt";
import { VoiceUpdates, pushStartImages, type UpdatesPage } from "../../src/voiceFront";
import type { Item } from "../../src/boardFormat";
import type { ChatRow, VoiceConfig } from "./api";

/** The SDK's conversation, as much of it as the board uses. */
export type VoiceConv = {
  endSession(): Promise<void>;
  setMicMuted(m: boolean): void;
  sendContextualUpdate(text: string, o?: { contextId?: string }): void;
  /** A user message (the box's [vc:result] updates, answered aloud). */
  sendUserMessage?(text: string): void;
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

/** The session as the box sends it (server/voice.ts voiceSession): the conversation, where its updates start, its images. */
export type BoardVoiceConfig = VoiceConfig & { convId?: string | null; cursor?: string | null; images?: { mime: string; dataBase64: string }[] };

export type VoiceApi = {
  listChats(): Promise<ChatRow[]>;
  voiceSession(convId: string | null): Promise<BoardVoiceConfig>;
  voiceTool(b: { name: string; args: unknown; convId: string | null; device: "board" }): Promise<{ result?: string; error?: string; convId?: string | null }>;
  voiceTranscript(b: { convId: string | null; role: string; text: string; system?: boolean; ended?: boolean; device: "board" }): Promise<{ convId?: string | null }>;
  /** One long poll of the call's updates (none: the call gets no updates). */
  voiceUpdates?(convId: string, cursor: string | null): Promise<UpdatesPage>;
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
  lines.push("A picture of what he sees comes with this when it changes; LookAtScreen looks again right now. To put something on his board, Ask the agent to send it to his board inbox. Don't describe the board unless he asks.]");
  return lines.join(" ");
}

/** Tools the board page answers itself (the box has no screen to look at). */
export const BOARD_LOCAL_TOOLS = new Set(["LookAtScreen"]);


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

/** Why a session ended (the board's log "voice.close"): who closed it, the SDK's reason, how long it was live. */
export type VoiceClose = { by: "mic" | "pill" | "switch" | "remote"; reason?: string; message?: string; code?: number; closeReason?: string; transport: "webrtc" | "websocket" | null; secs: number; conv: string | null };

export type VoiceDeps = {
  api: VoiceApi;
  /** Where the chat Carl picked in the pill is remembered across reloads (none: this page only). */
  threadStore?: { get(): string | null; set(id: string | null): void };
  /** Every close, with who closed it and why. */
  onClose?: (c: VoiceClose) => void;
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
  /** The conversation this call is attached to (its lines go there; null until the box made a new one). */
  private convId: string | null = null;
  /** The chat Carl picked in the pill, and when: it is continued until another chat is more recently active. */
  thread: string | null = null;
  private pickedAt = 0;
  private liveAt = 0;
  private lines: Promise<unknown> = Promise.resolve();
  private gen = 0;
  private updates: VoiceUpdates | null = null;
  /** Updates and pictures sent this session (for the preview and the tests). */
  readonly sent = { updates: [] as string[], images: 0, looks: 0 };

  constructor(private d: VoiceDeps) {
    try {
      this.thread = d.threadStore?.get() ?? null;
    } catch {
      this.thread = null;
    }
  }

  private setThread(id: string | null): void {
    this.pickedAt = Date.now();
    if (this.thread === id) return;
    this.thread = id;
    try {
      this.d.threadStore?.set(id);
    } catch {
      /* storage blocked: this page only */
    }
  }

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
    if (this.state.phase === "live" || this.state.phase === "connecting") void this.end("mic");
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
    // A picked chat; else the one picked in the pill while no other chat has been active since; else the most recent.
    const picked = this.thread ? chats.find((c) => c.id === this.thread) : null;
    const latest = chats[0] ?? null;
    const stillPicked = !!picked && (!latest || latest.id === picked.id || (latest.lastActivityAt ?? 0) <= Math.max(this.pickedAt, picked.lastActivityAt ?? 0));
    const chat = (chatId ? chats.find((c) => c.id === chatId) : null) ?? (stillPicked ? picked : null) ?? latest;
    this.set({ chats, chat });
    let cfg: BoardVoiceConfig | null = null;
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
    // The call is that conversation's voice: its lines and requests go into it (a new one when there is none yet).
    this.convId = cfg.convId ?? chat?.id ?? null;
    this.lastText = "";
    this.pusher.reset();
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
        clientTools: this.clientTools(cfg.toolNames ?? []),
        onConnect: () => {
          if (timedOut || gen !== this.gen) return;
          this.liveAt = Date.now();
          this.set({ phase: "live", error: "" });
          this.pushNow();
        },
        onDisconnect: (d) => {
          this.lastClose = { transport, reason: d?.reason, message: d?.message, code: d?.closeCode ?? d?.context?.code, closeReason: d?.closeReason ?? d?.context?.reason };
          console.warn("[board-voice] closed", JSON.stringify(this.lastClose));
          if (timedOut || gen !== this.gen) return;
          // Closed from the other side (the network, ElevenLabs): said, with the reason; the mic goes on with this chat.
          const was = this.state.phase;
          this.report("remote", d);
          const why = String((d?.reason === "error" ? (d?.message ?? d?.closeReason ?? d?.context?.reason) : (d?.reason ?? d?.closeReason)) ?? "").slice(0, 120);
          this.teardown(was === "connecting" ? "The voice connection closed before it started." : `Voice disconnected${why ? ` (${why})` : ""}. Tap the mic to go on with this chat.`);
        },
        onError: (m) => {
          if (gen === this.gen && this.state.phase !== "live") this.set({ error: typeof m === "string" ? m : ((m as Error)?.message ?? "voice error") });
        },
        onMessage: ({ message, role }) => {
          const raw = (message || "").trim();
          // The box's own updates ([vc:result] …) come back as user lines: they are not Carl's.
          if (role === "user" && isControlLine(raw)) return;
          const text = role === "user" ? raw : stripAudioTags(raw);
          if (text) this.saveLine(role === "user" ? "user" : "assistant", text);
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
      // The conversation's newest images (a phone photo, a pasted figure): this call has never seen them.
      void pushStartImages(conv, this.pusher, cfg.images, () => this.conv === conv)
        .then((r) => {
          this.sent.images += r.filter((x) => x === "sent").length;
        })
        .catch(() => {});
      // The agent's answers and what Carl did elsewhere, into the live call (held while the voice speaks).
      this.startUpdates(conv, cfg.cursor ?? null);
    } catch (e) {
      return this.fail(gen, `Voice couldn't connect: ${String((e as Error)?.message ?? e)}`);
    }
  }

  private startUpdates(conv: VoiceConv, cursor: string | null): void {
    this.updates?.stop();
    this.updates = null;
    const get = this.d.api.voiceUpdates;
    if (!get) return;
    this.updates = new VoiceUpdates({
      cursor,
      gate: this.gate,
      conv: () => (this.conv === conv ? conv : null),
      fetch: async (cur) => {
        // A new conversation exists once its first line or request made it.
        await this.lines;
        if (!this.convId) {
          await new Promise((r) => setTimeout(r, 1000));
          return { updates: [], cursor: cur ?? "" };
        }
        return get(this.convId, cur);
      },
    }).start();
  }

  /** What the box's updates put into the call so far (tests, diagnostics). */
  get delivered(): string[] {
    return (this.updates?.delivered ?? []).map((u) => u.text);
  }

  async end(by: "mic" | "pill" | "switch" = "mic"): Promise<void> {
    const c = this.conv;
    if (this.state.phase === "live" || this.state.phase === "connecting") this.report(by);
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
    // Picking a chat is the one deliberate change of the board's thread.
    this.setThread(id);
    await this.end("switch");
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

  /** LookAtScreen on the board: the part in view, now, as a picture (through the image path), and the board as text. */
  async lookAtBoard(): Promise<string> {
    const conv = this.conv, b = this.board;
    if (!b) return "Carl is not on a board right now (the board list is open), so there is nothing to look at.";
    const text = boardContextText({ name: b.name(), items: b.items(), strokes: b.strokes() }).replace(/^\[|\]$/g, "");
    let blob: Blob | null;
    try {
      blob = await b.snapshot();
    } catch (e) {
      return `Error: the board's picture could not be taken on the iPad (${String((e as Error)?.message ?? e)}). ${text}`;
    }
    if (!blob) return `The part of the board in view is empty: no handwriting or items there. ${text}`;
    if (!conv) return `Error: the call is not connected, so the picture could not be attached. ${text}`;
    const key = `board:${b.slug}:${await blobKey(blob)}`;
    const sink = { uploadFile: (x: Blob) => conv.uploadFile(x), sendMultimodalMessage: (m: { text?: string; fileId: string }) => conv.sendMultimodalMessage(m) };
    const [r] = await this.pusher.pushMany({ ...sink, sendFiles: (t, ids) => sendFilesMessage(sink, t, ids) }, [{ key, blob }], lookingAtNote(`his whiteboard "${b.name()}"`, "the part in view"), () => this.conv === conv);
    if (r === "sent") {
      this.sent.images++;
      this.sent.looks++;
      return `Attached a picture of the part of his board in view, as he sees it now — look at it. ${text}`;
    }
    if (r === "duplicate") {
      this.sent.looks++;
      return `Nothing in view has changed since the picture of his board you already have — look at that one. ${text}`;
    }
    return `Error: the picture could not be attached (${String(r)}). ${text}`;
  }

  private clientTools(names: string[]): Record<string, (p: unknown) => Promise<string>> {
    const tools: Record<string, (p: unknown) => Promise<string>> = {};
    for (const name of BOARD_LOCAL_TOOLS) tools[name] = () => this.lookAtBoard().catch((e) => `Error: ${String((e as Error)?.message ?? e)}`);
    for (const name of names) {
      if (BOARD_LOCAL_TOOLS.has(name)) continue;
      tools[name] = async (params) => {
        try {
          // A request reaches the agent after Carl's words before it (the lines are saved in order).
          await this.lines;
          const j = await this.d.api.voiceTool({ name, args: params ?? {}, convId: this.convId, device: "board" });
          if (typeof j.convId === "string" && j.convId) this.adopt(j.convId);
          return typeof j.result === "string" ? j.result : `Error: ${j.error ?? "no result"}`;
        } catch (e) {
          return `Error: the box did not take it (${String((e as Error)?.message ?? e)}). Nothing was done.`;
        }
      };
    }
    return tools;
  }

  /** The conversation the box made for this call (a new chat): its lines and requests go on there. */
  private adopt(id: string): void {
    if (this.convId === id) return;
    this.convId = id;
    const was = this.state.chat;
    if (was?.id !== id) this.set({ chat: { id, title: was?.title || "Voice", lastActivityAt: Date.now(), source: "voice" } });
  }

  /** The call's lines, saved into its conversation on the box, in order (the first makes a new one when there is none). */
  private saveLine(role: string, text: string, end = false): void {
    this.lines = this.lines.then(async () => {
      try {
        const j = await this.d.api.voiceTranscript({ convId: this.convId, role, text, device: "board", ...(end ? { system: true, ended: true } : {}) });
        if (j && typeof j.convId === "string" && j.convId && !end) this.adopt(j.convId);
      } catch {
        /* the box is away: the line is lost, the call goes on */
      }
    });
  }

  /** A close, reported once with who closed it and why. */
  private report(by: VoiceClose["by"], d?: { reason?: string; message?: string; closeCode?: number; closeReason?: string; context?: { reason?: string; code?: number } }): void {
    const code = d?.closeCode ?? d?.context?.code;
    const closeReason = d?.closeReason ?? d?.context?.reason;
    try {
      this.d.onClose?.({
        by,
        ...(d?.reason ? { reason: d.reason } : {}),
        ...(d?.message ? { message: String(d.message).slice(0, 160) } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(closeReason ? { closeReason: String(closeReason).slice(0, 160) } : {}),
        transport: this.transport,
        secs: this.liveAt ? Math.round((Date.now() - this.liveAt) / 1000) : 0,
        conv: this.convId,
      });
    } catch {
      /* a log must not break the call */
    }
  }

  private fail(gen: number, why: string): void {
    if (gen !== this.gen) return;
    this.gen++;
    const c = this.conv;
    this.conv = null;
    this.updates?.stop();
    this.updates = null;
    void c?.endSession().catch(() => {});
    this.dropMic();
    this.set({ phase: "error", error: why, speaking: false });
  }

  private teardown(why: string): void {
    const was = this.state.phase;
    if (was === "live") this.saveLine("assistant", "Voice session ended.", true);
    this.updates?.stop();
    this.updates = null;
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
