// Voice on the board: the conversation's own agent, as on the phone and the laptop. The box hears (its pipeline:
// Silero, Smart Turn, ElevenLabs Scribe), pi answers in the conversation, the box speaks (ElevenLabs Flash) —
// server/voiceBrain.ts. The iPad is the mic and the speaker (src/voiceBrainClient.ts). What is on the board the agent
// sees with its own BoardLook tool (server/boardLook.ts), like any turn.
//
// Which conversation: Main, the one main conversation every surface continues (src/threads.ts), or the thread he
// picked in the pill (switchChat: a project's thread) for as long as no other thread has been active since.
//
// A call that closes by itself (the network, the box) is said, not hidden: the pill turns red with the reason, and the
// mic continues the same thread. Every close is reported with who closed it and why (`onClose`, the board's log
// "voice.close").
//
// No DOM here: the pill (voicePill.ts) draws it, the tests drive it with a fake call.
import { MicPin, canPickOutput, deviceLists, type MicDevice } from "../../src/voiceMic";
import type { Item } from "../../src/boardFormat";
import type { ChatRow } from "./api";
import { MAIN_ID, isOlderChat } from "../../src/threads";
import { BrainConversation, type BrainOptions } from "../../src/voiceBrainClient";

/** The live call, as much of it as the board uses. */
export type VoiceConv = {
  endSession(): Promise<void>;
  setMicMuted(m: boolean): void;
  getOutputVolume?(): number;
  getInputVolume?(): number;
  changeInputDevice?(c: { inputDeviceId: string }): Promise<void>;
  changeOutputDevice?(c: { outputDeviceId: string }): Promise<void>;
};

export type VoiceApi = {
  listChats(): Promise<ChatRow[]>;
  /** The box's call routes (POST /api/v1/brain/...). */
  brainPost(path: string, body: Record<string, unknown>): Promise<any>;
};

/** What the board tells voice (view.ts): the board on screen. */
export type BoardSource = {
  slug: string;
  name(): string;
  items(): Item[];
  strokes(): number;
  /** The visible region as a downscaled JPEG (null: nothing in view). */
  snapshot(): Promise<Blob | null>;
  idle?(): Promise<void>;
};

export type Phase = "idle" | "connecting" | "live" | "error";
export type VoiceState = {
  phase: Phase;
  error: string;
  muted: boolean;
  speaking: boolean;
  chat: ChatRow | null;
  chats: ChatRow[];
};

/** The chats the phone lists: not the old missions system's threads. */
const NOT_CHATS = new Set(["ask", "worker", "mission"]);
/** The threads voice can continue: Main, the projects' threads, separate chats (never an older chat: read only). */
export const recentChats = (rows: ChatRow[]) => {
  const known = rows.some((c) => typeof c.kind === "string" && c.kind);
  return rows.filter((c) => !NOT_CHATS.has(c.source) && (!known || !isOlderChat(c))).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
};

/** A start that failed, said plainly. */
export function micError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is off. Allow it in Settings → Apps → Safari, then tap the mic.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found on this iPad.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return `The microphone didn't start: ${String((e as Error)?.message ?? e)}`;
}

/** Why a call ended (the board's log "voice.close"): who closed it, the reason, how long it was live. */
export type VoiceClose = { by: "mic" | "pill" | "switch" | "remote"; reason?: string; message?: string; secs: number; conv: string | null };

export type VoiceDeps = {
  api: VoiceApi;
  /** Where the chat Carl picked in the pill is remembered across reloads (none: this page only). */
  threadStore?: { get(): string | null; set(id: string | null): void };
  /** Every close, with who closed it and why. */
  onClose?: (c: VoiceClose) => void;
  /** The mic permission (getUserMedia); throws as it does. Null: this page can't have a mic (not HTTPS). */
  mic: (() => Promise<MediaStream>) | null;
  /** The device list and its devicechange (navigator.mediaDevices when left out; null: none). */
  devices?: { enumerateDevices(): Promise<MicDevice[]>; addEventListener?(t: "devicechange", f: () => void): void; removeEventListener?(t: "devicechange", f: () => void): void } | null;
  /** The board's log (mic pinned, switched, devices changed, the call's events). */
  log?: (event: string, data: Record<string, unknown>) => void;
  /** Called synchronously in the tap, before anything awaits (iOS: audio must be unlocked in the gesture). */
  unlock?: () => void;
  /** [tests, preview] Start the call: the real one is BrainConversation.start. */
  startCall?: (o: BrainOptions) => Promise<VoiceConv>;
  /** [tests] The call's browser parts (mic, peer connection, audio). */
  brainDeps?: BrainOptions["deps"];
};

export class VoiceController {
  state: VoiceState = { phase: "idle", error: "", muted: false, speaking: false, chat: null, chats: [] };
  private listeners = new Set<(s: VoiceState) => void>();
  private conv: VoiceConv | null = null;
  private stream: MediaStream | null = null;
  private list = async () => {
    const md = this.media();
    if (!md) throw new Error("no device listing");
    return (await md.enumerateDevices()).map((d) => ({ deviceId: d.deviceId, groupId: d.groupId, label: d.label, kind: d.kind }));
  };
  private pin = new MicPin({ list: () => this.list(), log: (ev, data) => this.d.log?.(ev, data) });
  private outPin = new MicPin({ list: () => this.list(), log: (ev, data) => this.d.log?.(ev, data), kind: "audiooutput" });
  private unwatchDevices: (() => void) | null = null;
  /** The conversation this call is on. */
  private convId: string | null = null;
  /** The chat Carl picked in the pill, and when: it is continued until another chat is more recently active. */
  thread: string | null = null;
  private pickedAt = 0;
  private liveAt = 0;
  private gen = 0;
  /** The last close, with its reason (diagnostics). */
  lastClose: Record<string, unknown> | null = null;

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

  /** The voice's output level, 0..1 (the pill's waves while it speaks). */
  outputLevel(): number {
    try {
      return this.state.speaking ? Math.min(1, (this.conv?.getOutputVolume?.() ?? 0) * 2.5) : 0;
    } catch {
      return 0;
    }
  }
  /** Carl's mic level, 0..1 (flat while muted). */
  inputLevel(): number {
    try {
      return this.state.muted ? 0 : Math.min(1, (this.conv?.getInputVolume?.() ?? 0) * 2.5);
    } catch {
      return 0;
    }
  }

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
    // The mic first, while the tap is still the gesture that asked for it; then let go (the call opens its own).
    try {
      this.stream = await this.d.mic();
    } catch (e) {
      return this.fail(gen, micError(e));
    }
    this.dropMic();
    if (gen !== this.gen) return;
    let chats: ChatRow[] = [];
    try {
      chats = recentChats(await this.d.api.listChats());
    } catch {
      /* no list: Main */
    }
    // A picked chat; else the one picked in the pill while no other chat has been active since; else Main (one main
    // conversation, every surface's default: src/threads.ts).
    const picked = this.thread ? chats.find((c) => c.id === this.thread) : null;
    const latest = chats[0] ?? null;
    const stillPicked = !!picked && (!latest || latest.id === picked.id || (latest.lastActivityAt ?? 0) <= Math.max(this.pickedAt, picked.lastActivityAt ?? 0));
    const chat = (chatId ? chats.find((c) => c.id === chatId) : null) ?? (stillPicked ? picked : null) ?? chats.find((c) => c.id === MAIN_ID) ?? null;
    this.set({ chats, chat });
    const convId = chat?.id ?? MAIN_ID;
    this.convId = convId;
    try {
      const listed = await this.pin.devices();
      const micId = await this.pin.atStart(listed);
      const outId = canPickOutput() ? await this.outPin.atStart(listed) : (this.outPin.reset(), undefined);
      if (gen !== this.gen) return;
      const opts: BrainOptions = {
        post: (path, body) => this.d.api.brainPost(path, body),
        convId,
        device: "board",
        ...(micId ? { inputDeviceId: micId } : {}),
        ...(outId ? { outputDeviceId: outId } : {}),
        ...(this.d.brainDeps ? { deps: this.d.brainDeps } : {}),
        log: (ev, data) => this.d.log?.(ev, data),
        onConnect: () => {
          if (gen !== this.gen) return;
          this.liveAt = Date.now();
          this.set({ phase: "live", error: "" });
        },
        onMode: (mode) => {
          if (gen === this.gen) this.set({ speaking: mode === "speaking" });
        },
        onDisconnect: (d) => {
          this.lastClose = { reason: d.reason, message: d.message };
          if (gen !== this.gen) return;
          this.report("remote", d);
          this.teardown(`Voice disconnected (${d.message ?? d.reason}). Tap the mic to go on with this chat.`);
        },
      };
      const conv = await (this.d.startCall ? this.d.startCall(opts) : (BrainConversation.start(opts) as unknown as Promise<VoiceConv>));
      if (gen !== this.gen) {
        void conv.endSession().catch(() => {});
        return;
      }
      this.conv = conv;
      this.watchDevices(conv);
      if (!chat) this.set({ chat: { id: convId, title: "Main", lastActivityAt: Date.now(), source: "main" } });
    } catch (e) {
      return this.fail(gen, `Voice couldn't connect: ${String((e as Error)?.message ?? e)}`);
    }
  }

  private media(): VoiceDeps["devices"] {
    if (this.d.devices !== undefined) return this.d.devices;
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    return md?.enumerateDevices ? md : null;
  }

  /** The pinned mic and output follow the system's devices (unplugged: the best remaining one). */
  private watchDevices(conv: VoiceConv): void {
    this.unwatchDevices?.();
    this.unwatchDevices = null;
    const md = this.media();
    if (!md?.addEventListener) return;
    const on = async () => {
      if (this.conv !== conv) return;
      const listed = await this.pin.devices();
      const devs: MicDevice[] = listed ?? [];
      this.d.log?.("voice devices changed", { ...deviceLists(devs), mic: this.pin.pinned?.label ?? null, outputDevice: this.outPin.pinned?.label ?? null });
      if (!listed || this.conv !== conv) return;
      if (conv.changeOutputDevice) await this.outPin.devicesChanged(devs, (id) => conv.changeOutputDevice!({ outputDeviceId: id }));
      if (conv.changeInputDevice && this.conv === conv) await this.pin.devicesChanged(devs, (id) => conv.changeInputDevice!({ inputDeviceId: id }));
    };
    const handler = () => void on();
    md.addEventListener("devicechange", handler);
    this.unwatchDevices = () => md.removeEventListener?.("devicechange", handler);
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

  /** Continue another chat: the call restarts on it. */
  async switchChat(id: string): Promise<void> {
    if (this.state.chat?.id === id && this.state.phase === "live") return;
    const keep = this.state.chats;
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

  /** The board on screen (null: none). The agent looks at it itself (BoardLook) when it needs to: nothing to push. */
  setBoard(_b: BoardSource | null): void {}
  /** The board changed: nothing to push either. */
  boardChanged(_b: BoardSource): void {}

  private report(by: VoiceClose["by"], d?: { reason?: string; message?: string }): void {
    try {
      this.d.onClose?.({
        by,
        ...(d?.reason ? { reason: d.reason } : {}),
        ...(d?.message ? { message: String(d.message).slice(0, 160) } : {}),
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
    void c?.endSession().catch(() => {});
    this.dropMic();
    this.set({ phase: "error", error: why, speaking: false });
  }

  private teardown(why: string): void {
    this.conv = null;
    this.unwatchDevices?.();
    this.unwatchDevices = null;
    this.pin.reset();
    this.outPin.reset();
    this.dropMic();
    this.set(why ? { phase: "error", error: why, speaking: false, muted: false } : { phase: "idle", error: "", speaking: false, muted: false });
  }

  private dropMic(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
  }
}
