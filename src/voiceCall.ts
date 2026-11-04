// The laptop's voice call. The voice is the conversation's own agent: the box hears (its pipeline: Silero, Smart Turn,
// ElevenLabs Scribe), pi answers in the conversation, the box speaks (ElevenLabs Flash) — server/voiceBrain.ts and
// voice-pipeline/bot.py. This module starts and ends the call (src/voiceBrainClient.ts carries the audio), keeps the
// store's voice state, and gives the waves their levels.
import { useStore } from "./store";
import { onVlog, vlog as debugVlog } from "./debugLog";
import { VoiceLogShipper } from "./voiceShip";
import { MicPin, canPickOutput, listAudioDevices } from "./voiceMic";
import { BrainConversation, type BrainPost } from "./voiceBrainClient";
import { MAIN_ID } from "./threads";

/** The voice's diagnostics: the local trail, and the box (voiceShip.ts: <state>/logs/voice.jsonl). */
const ship = new VoiceLogShipper({ device: "laptop" });
function vlog(tag: string, data?: unknown): void {
  debugVlog(tag, data);
  ship.add(tag, data);
}
onVlog((tag, data) => {
  if (tag.startsWith("console.") && typeof data === "string" && data.startsWith("[voice]")) ship.add("voice console", { level: tag.slice(8), line: data });
});
// Legacy agent settings are inert. Leave unrelated local preferences and history untouched.

/** [tests] The laptop's voice-log shipper. */
export function voiceShipperForTests(): VoiceLogShipper {
  return ship;
}

/** What the live call needs from its conversation object (BrainConversation; the preview's scripted stand-in). */
type Conv = {
  setMicMuted(muted: boolean): void;
  setVolume(o: { volume: number }): void;
  getInputByteFrequencyData(): Uint8Array;
  getOutputByteFrequencyData(): Uint8Array;
  endSession(): Promise<void>;
};

let active: Conv | null = null;
/** This start's number: only the newest call's close may clear the call's state. */
let liveCall = 0;
const micPin = new MicPin({ list: listAudioDevices, log: (ev, data) => vlog(ev, data) });
const outPin = new MicPin({ list: listAudioDevices, log: (ev, data) => vlog(ev, data), kind: "audiooutput" });

function isMicProblem(e: unknown): boolean {
  const n = (e as { name?: string })?.name ?? "";
  return n === "NotAllowedError" || n === "NotFoundError" || n === "NotReadableError" || /microphone|getUserMedia|permission/i.test(String((e as Error)?.message ?? e));
}

function reportVoiceError(message: string): void {
  console.error("[voice] voice start failed:", message);
  // The waves turn red (VoiceCockpit) until the next start attempt or a successful connect.
  useStore.setState({ voiceError: message, voiceMode: false });
  useStore.getState().setVoiceConnecting(false);
}

/** Start a call on the conversation that is open (Main when none is). Errors end it with one plain line. */
export async function startVoiceCall(): Promise<void> {
  if (active) return;
  const myCall = ++liveCall;
  const state = useStore.getState();
  const { boxLinkFor, boxPost, boxGet } = await import("./boxChat");
  const link = await boxLinkFor(state.vaultPath);
  if (!link) {
    reportVoiceError("Connect your box to talk — voice runs on the box (Settings → Box).");
    return;
  }
  const readiness = await boxGet(link, "/api/v1/brain/engine", 4000).catch(() => null);
  if (!readiness?.pipeline || readiness.error) {
    reportVoiceError(readiness?.error || "The box’s voice is not ready. Open Settings → Voice → Health.");
    return; // Refuse BEFORE microphone access, including enumeration.
  }
  if (myCall !== liveCall || !useStore.getState().voiceMode) return;
  ship.post = async (body) => {
    const r = await boxPost(link, "/api/v1/board/log", body);
    if (!r.ok) throw new Error(r.error ?? "not sent");
  };
  ship.installPageHide();
  useStore.getState().setVoiceConnecting(true);
  useStore.setState({ voiceNotice: null });
  // The voice he picked here before the box kept it: the box's from now on (once is enough; harmless again).
  const picked = localStorage.getItem("vault_chat_elevenlabs_voice");
  if (picked) void boxPost(link, "/api/v1/brain/voice", { voiceId: picked }).catch(() => null);
  const post: BrainPost = async (path, body) => {
    const r = await boxPost(link, path, body);
    if (!r.ok) throw new Error(r.error ?? "the box did not answer");
    return r.data;
  };
  const startedAt = Date.now();
  try {
    const listed = await micPin.devices();
    const micId = await micPin.atStart(listed);
    const outId = canPickOutput() ? await outPin.atStart(listed) : (outPin.reset(), undefined);
    const conv: BrainConversation = await BrainConversation.start({
      post,
      convId: state.activeConversationId ?? MAIN_ID,
      device: "laptop",
      ...(micId ? { inputDeviceId: micId } : {}),
      ...(outId ? { outputDeviceId: outId } : {}),
      log: (ev, data) => vlog(ev, data),
      onConnect: () => {
        vlog("voice connected", { transport: "brain", connectMs: Date.now() - startedAt });
        useStore.setState({ voiceError: null });
        useStore.getState().setVoiceConnecting(false);
        useStore.getState().setVoiceListening(true);
        useStore.getState().setVoiceSpeaking(false);
        useStore.getState().setVoiceThinking(false);
      },
      onMode: (mode) => {
        useStore.getState().setVoiceListening(mode === "listening");
        useStore.getState().setVoiceSpeaking(mode === "speaking");
        useStore.getState().setVoiceThinking(mode === "thinking");
      },
      onDisconnect: (d) => {
        vlog("voice closed", { transport: "brain", reason: d.reason, message: d.message, afterMs: Date.now() - startedAt });
        if (active !== conv || myCall !== liveCall) return;
        void endVoiceCall("connection lost").finally(() => reportVoiceError(`Voice dropped: ${d.message ?? d.reason}.`));
      },
    });
    if (myCall !== liveCall || !useStore.getState().voiceMode) {
      // Ended while it connected.
      await conv.endSession().catch(() => {});
      return;
    }
    active = conv;
  } catch (e) {
    console.error("[voice] the voice did not start:", e);
    active = null;
    const msg = (e as Error)?.message ?? String(e);
    if (isMicProblem(e)) {
      reportVoiceError(`Microphone access denied or unavailable: ${msg}. Check Windows Settings → Privacy → Microphone, and the system's default input device.`);
      return;
    }
    reportVoiceError(`The voice couldn't start: ${msg}.`);
  }
}

/** Ends the call. `by` says who ended it, in the log. Nothing on a layout change calls this: the call is this
 *  module's, not a component's. */
export async function endVoiceCall(by = "app"): Promise<void> {
  if (active) vlog("voice end", { by });
  const conv = active;
  active = null;
  liveCall++;
  if (conv) {
    try {
      conv.setMicMuted(true);
    } catch {
      /* */
    }
  }
  useStore.setState({ voiceMode: false, voiceMicMuted: false });
  useStore.getState().setVoiceListening(false);
  useStore.getState().setVoiceSpeaking(false);
  useStore.getState().setVoiceThinking(false);
  useStore.getState().setVoiceConnecting(false);
  if (!conv) return;
  try {
    await conv.endSession();
  } catch (e) {
    console.warn("[voice] end session failed:", e);
  }
}

/** The mic button and Ctrl+D: start a call, or end the live one. A press while the call is still connecting does
 *  nothing (it connects, or fails and says so; then the mic toggles as always). */
export function toggleVoice(by: string = "toggle"): void {
  const who = typeof by === "string" ? by : "toggle";
  if (useStore.getState().voiceConnecting && !active) {
    vlog("voice toggle ignored", { why: "connecting", by: who });
    return;
  }
  if (!useStore.getState().voiceMode) {
    vlog("voice start", { by: who });
    useStore.setState({ voiceMode: true, voiceError: null });
    void startVoiceCall();
  } else {
    void endVoiceCall(who);
  }
}

export function isVoiceSessionActive(): boolean {
  return active !== null;
}

/** The mute toggle (the composer's Mute button, Ctrl+Shift+M): no audio leaves the laptop while the voice can still
 *  speak a result; unmuting is instant. No live call: nothing. */
export function toggleVoiceMute(): boolean {
  if (!active) return false;
  const next = !useStore.getState().voiceMicMuted;
  setVoiceMicMuted(next);
  vlog("voice mute", { on: next, by: "carl" });
  return true;
}

export function setVoiceMicMuted(muted: boolean): void {
  if (!active) return;
  try {
    active.setMicMuted(muted);
    useStore.setState({ voiceMicMuted: muted });
  } catch (e) {
    console.warn("[voice] setMicMuted failed:", e);
  }
}

/** The text panel silences the reply while he types (and brings it back when he sends). */
export function setVoiceOutputMuted(muted: boolean): void {
  try {
    active?.setVolume({ volume: muted ? 0 : 1 });
  } catch (e) {
    console.warn("[voice] setVolume failed:", e);
  }
}

/** A typed line during a call: the same kind of turn as a spoken one, a message to the conversation; the voice says
 *  the reply. */
export function sendVoiceUserText(text: string): boolean {
  const trimmed = text.trim();
  if (!active || !trimmed) return false;
  void import("./boxChat").then(({ boxSend }) => boxSend({ text: trimmed, convId: useStore.getState().activeConversationId }));
  return true;
}

/** A typed line with an image (the panel's capture): a message with the image attached. */
export async function sendVoiceUserMultimodal(text: string, imageDataUrl: string): Promise<boolean> {
  if (!active) return false;
  const { boxSend } = await import("./boxChat");
  return boxSend({ text: text.trim(), attachments: [{ imageDataUrl }], convId: useStore.getState().activeConversationId });
}

/**
 * One frame of the voice waves' raw levels (0..1 per bar): the reply's output while the voice speaks, else his mic
 * (flat while muted: a muted mic is honestly silent). The chat popout gets these from the main window (sync.ts).
 */
export function voiceBarLevels(n: number): number[] {
  const s = useStore.getState();
  if (!active) return new Array(n).fill(0);
  if (s.voiceSpeaking) {
    const out = bins(active.getOutputByteFrequencyData(), n);
    if (out.reduce((a, b) => a + b, 0) > 0.05) return out;
  }
  return s.voiceMicMuted ? new Array(n).fill(0) : bins(active.getInputByteFrequencyData(), n);
}

function bins(data: Uint8Array, n: number): number[] {
  const out: number[] = [];
  const per = Math.max(1, Math.floor(data.length / n));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < per; j++) sum += data[i * per + j] ?? 0;
    out.push(sum / per / 255);
  }
  return out;
}

/** [preview harness] Run the live-call UI against a scripted conversation (the preview has no mic or box): levels,
 *  mute, end. Null ends it. */
export function adoptVoiceSessionForPreview(conv: unknown): void {
  if (conv) {
    active = conv as Conv;
    useStore.setState({ voiceMode: true, voiceMicMuted: false });
    useStore.getState().setVoiceConnecting(false);
  } else {
    active = null;
    useStore.setState({ voiceMode: false, voiceMicMuted: false });
  }
}
