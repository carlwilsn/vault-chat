import { Conversation, type VoiceConversation } from "@elevenlabs/client";
import { invoke } from "@tauri-apps/api/core";
import { useStore, type ChatMessage, type Viewport } from "./store";
import { SCREEN_TOOLS, isControlLine, isFillerLine, voiceToolDefs, type VoiceDevice, type VoiceToolDef } from "./voicePrompt";
import { VoiceUpdates } from "./voiceFront";
import { cachedVoiceMath, displayVoiceMath, prefetchVoiceMath } from "./voiceMath";
import { VoiceImagePusher, lookingAtNote, sendFilesMessage, thumbDataUrl, voiceImageMime, type PushResult } from "./voiceImages";
import { fileKind, isUnreadableAsText } from "./fileKind";
import { awaitScroll } from "./scrollTarget";
import { stripAudioTags } from "./voiceTags";
import { QuietGate } from "./voiceQuiet";
import { RECONNECT_NUDGE, RECONNECTING_LINE, FillerWatch, TimeoutRetry, VoiceTurnStats, couldntReconnectLine, isLlmTimeoutClose, plainCloseReason, reconnectRecap } from "./voiceTimeout";
import { onVlog, vlog as debugVlog } from "./debugLog";
import { VoiceLogShipper } from "./voiceShip";
import { SPEECH_LEVEL, VoiceHealth, connectionOptions, pickTransport, type HealthEvent, type Transport } from "./voiceHealth";
import { AUDIO_WARN_LINE, MicPin, audioBlocked, canPickOutput, deviceLists, listAudioDevices, type MicDevice } from "./voiceMic";
import { PlaybackMonitor, roomAudioStats } from "./voiceStats";
import { layoutLine, sideOf } from "./paneLayout";

/** The voice's diagnostics: the local trail, and the box (voiceShip.ts: <state>/logs/voice.jsonl). */
const ship = new VoiceLogShipper({ device: "laptop" });
function vlog(tag: string, data?: unknown): void {
  debugVlog(tag, data);
  ship.add(tag, data);
}
// The voice's console lines ("[voice-eleven] microphone not reaching ElevenLabs", a failed start) go with them.
onVlog((tag, data) => {
  if (tag.startsWith("console.") && typeof data === "string" && data.startsWith("[voice-eleven]")) ship.add("voice console", { level: tag.slice(8), line: data });
});
/** [tests] The laptop's voice-log shipper. */
export function voiceShipperForTests(): VoiceLogShipper {
  return ship;
}
import { DEFAULT_VOICE_LLM, isVoiceLlm, llmInfo, normalizeVoiceLlm, reasoningEffortFor, voiceLlmList, type VoiceLlmInfo } from "./voiceLlms";

// Voice mode runs as an ElevenLabs Conversational AI session: their
// platform owns the audio loop (STT + LLM + TTS). Voice is the front of house
// of the conversation that is open (D3, one brain): the box builds its prompt
// from that conversation's pi session, saves every line into it, and runs its
// one tool that acts (Ask: a request to the conversation's agent); this laptop
// runs the tools that read or move its screen and puts the box's updates (the
// agent's answers, what Carl did elsewhere) into the live call.

// WebKitGTK (Linux) can't play Web Audio on the current Ubuntu stack, so there
// voice runs over the WebSocket transport and the agent's voice is routed to
// native playback in the Rust backend (16 kHz PCM chunks). Everywhere else voice
// runs over WebRTC (ElevenLabs' recommended transport) and the SDK plays it —
// no audio code of ours on that path.

// Hand an agent-audio chunk to the native player. The SDK's
// onAudio gives base64 PCM (16 kHz mono s16le) — exactly what the Rust
// command expects.
function playAgentAudioNative(audioBase64: string): void {
  if (!audioBase64) return;
  // Rust command is a no-op off Linux, so no platform gate needed.
  void invoke("agent_audio_play", { b64: audioBase64 }).catch(() => {});
}
function stopAgentAudioNative(): void {
  void invoke("agent_audio_stop").catch(() => {});
}

const AGENT_NAME = "vault-chat";

// Box mode: the session's lines are saved on the box as they land (voiceBox.ts
// voiceTranscriptMirror). Null when voice runs here.
let transcriptMirror: { push: (m: ChatMessage) => unknown; id?: () => string; done?: () => Promise<unknown>; follow?: (to: string) => void } | null = null;
// The live session's chats: its own thread (box mode: the box's id once the
// first line made it) and the one it started from.
let voiceChats: { own: () => string | null; from: string | null; local?: string } | null = null;
// The box's vault root (absolute paths in the box's prompt) — mapped back to
// this vault for ScrollTo.
let boxVaultRoot: string | null = null;
// The live call's updates from the box (src/voiceFront.ts).
let updates: VoiceUpdates | null = null;
async function fetchUpdates(link: import("./boxChat").Link, convId: string, cursor: string | null, sessionId: string | null) {
  const { boxVoiceUpdates } = await import("./voiceBox");
  return boxVoiceUpdates(link, convId, cursor, undefined, sessionId);
}
function voiceAppend(m: ChatMessage): void {
  if (m.role === "assistant" && !m.system && typeof m.content === "string") {
    const content = stripAudioTags(m.content);
    if (!content) return;
    if (content !== m.content) m = { ...m, content };
  }
  // Box mode: the line is the box's to write (its voice conversation's log); this client shows it
  // under the same id until the log brings it (voiceBox.ts) — it never writes a box conversation.
  if (transcriptMirror) {
    void transcriptMirror.push(m);
    return;
  }
  // A tool call: the chat's tool row (its marker is only for the box's older readers).
  if (m.toolCalls?.length) {
    useStore.getState().appendMessage({ role: "assistant", content: "", toolCalls: m.toolCalls });
    return;
  }
  // Spoken math shows as notation (voiceMath.ts): already formatted (the agent's
  // lines are prefetched while their audio plays), or formatted when it returns.
  const shown = m.system ? undefined : cachedVoiceMath(String(m.content ?? ""));
  useStore.getState().appendMessage(shown ? { ...m, display: shown } : m);
  if (shown === undefined && !m.system) {
    const last = useStore.getState().messages[useStore.getState().messages.length - 1];
    if (last && last.content === m.content) displayVoiceMath(last);
  }
}
// The voice model — Settings → Models → Voice; stored as `vault_chat_elevenlabs_llm`.
// The ids, the default and the old-id mapping are src/voiceLlms.ts; what each
// model can take (images, documents) comes from ElevenLabs' own list.
export const DEFAULT_LLM = DEFAULT_VOICE_LLM;
const LLM_STORAGE = "vault_chat_elevenlabs_llm";
const AGENT_LLM_KEY = "vault_chat_elevenlabs_agent_llm";

/** Every id a client may send (current, and old ones that map to a current one). */
export const SUPPORTED_VOICE_LLMS = { has: (v: string) => isVoiceLlm(v) };

// A stored old id maps to the nearest current one; nothing stored is the default.
function getCurrentLlm(): string {
  return normalizeVoiceLlm(localStorage.getItem(LLM_STORAGE));
}

/** What the current model takes, from the cached list (sync; null = not known yet). */
function cachedLlmInfo(llm: string): VoiceLlmInfo | null {
  try {
    const raw = localStorage.getItem("vault_chat_elevenlabs_llm_list");
    return raw ? llmInfo((JSON.parse(raw) as { list: VoiceLlmInfo[] }).list, llm) : null;
  } catch {
    return null;
  }
}
/** The model reads an uploaded PDF itself (else it gets PdfExtract and no upload). */
function readsDocuments(llm: string): boolean {
  return cachedLlmInfo(llm)?.documents === true;
}
/** The model sees uploaded images (unknown counts as yes, as before the list). */
function seesImages(llm: string): boolean {
  return cachedLlmInfo(llm)?.images !== false;
}
const AGENT_ID_KEY = "vault_chat_elevenlabs_agent_id";
// Bump whenever the agent-create body changes in a way that affects
// the agent itself — tool schema, expects_response flags, override
// permissions. Mismatch with the cached agent triggers re-provision
// on next session, so updates roll out without manual intervention.
// v28-front: voice is the conversation's front of house — Ask plus the device's screen tools, one agent per device.
// v29-normalise: ElevenLabs' own text normaliser before speech (numbers and symbols the model still writes).
// v30-idle: silence is idle (Carl: "I don't want to have to tell it over and over that I'm still working"):
//   skip_turn waits silently until he speaks (wait_timeout_secs -1), the filler never before his first line,
//   silence_end_call_timeout where ElevenLabs reads it (turn, not conversation).
// v31-side-ask: Ask takes `act` (a change, not a question) and runs as a background side request.
const AGENT_CONFIG_VERSION = "v32-quiet";
const AGENT_VERSION_KEY = "vault_chat_elevenlabs_agent_config_version";
// The voice the provisioned agent speaks with. The session also overrides it
// (platform_settings allows tts.voice_id), but the agent's own voice is set too
// (PATCH), so the voice never rests on the override alone and ElevenLabs says
// at once, in words, when it refuses a voice.
const AGENT_VOICE_KEY = "vault_chat_elevenlabs_agent_voice";

const VOICE_ID_STORAGE = "vault_chat_elevenlabs_voice";
const DEFAULT_VOICE_ID = "nPczCjzI2devNBz1zQrb"; // Brian — Jarvis-adjacent baseline.
const SCROLL_DEBOUNCE_MS = 600;
const VIEWPORT_TEXT_CAP = 4000;

type ActiveConversation = VoiceConversation;

let activeConversation: ActiveConversation | null = null;
/** The newest call started (each start takes the next number). */
let liveCall = 0;
/** The soft-timeout filler said into his silence (it belongs only to a slow reply to his line): logged. */
const fillerWatch = new FillerWatch();
// The SDK's entry point ([tests] replaceable: a mocked SDK).
let voiceSdk: { startSession(o: any): Promise<any> } = Conversation;
/** [tests] Replace the ElevenLabs SDK's Conversation (null: the real one). */
export function setVoiceSdkForTests(sdk: { startSession(o: any): Promise<any> } | null): void {
  voiceSdk = sdk ?? Conversation;
}
// The live session's transport; WebSocket on Linux is the one with native playback.
let activeTransport: Transport | null = null;
const nativePlayback = () => activeTransport === "websocket" && isLinuxWebview();
function isLinuxWebview(): boolean {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Linux/.test(ua) && !/Android/.test(ua);
}
// A call ElevenLabs closed because the model timed out reconnects once (voiceTimeout.ts).
const timeoutRetry = new TimeoutRetry();
// Each turn's time to the first response and the session's size, for the log.
const turnStats = new VoiceTurnStats();
// While a timeout reconnect runs: a failed start is said once, in the reconnect's own words.
let reconnecting: { error: string | null } | null = null;
let restartForTests: ((recap: string) => Promise<void>) | null = null;
/** [tests] Replace the reconnect's session start (null: the real one). */
export function setVoiceRestartForTests(fn: ((recap: string) => Promise<void>) | null): void {
  restartForTests = fn;
}
function logTurn(data: Record<string, unknown> | null): void {
  if (data) vlog("voice turn", { ...data, images: imagePusher.uploaded });
}
let scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastViewportSent: string | null = null;
// Store subscription that watches active-pane / current-file and
// pushes a contextual update when either changes. Set up at session
// start, torn down at session end.
let unsubscribeViewportWatch: (() => void) | null = null;

// FIFO queue of agent messages that haven't been flushed to the chat
// pane yet, plus a flag tracking whether a silence-wait is currently
// in flight. Multiple agent messages in rapid succession would
// previously cause the earlier one to flush *immediately* (so message
// N+1 could take the single pending slot), which raced the transcript
// ahead of the audio. Now each message takes its turn: one silence
// window per message, in order.
const pendingAgentQueue: string[] = [];
let agentQueueDraining = false;

async function drainAgentQueue(): Promise<void> {
  if (agentQueueDraining) return;
  agentQueueDraining = true;
  // Pin the conversation we started for. If the session swaps mid-
  // drain (disconnect → user re-toggles voice → new session), the
  // post-await iteration would otherwise consume the new session's
  // queued messages and append them under a stale silence-wait. Bail
  // out instead — onDisconnect's flushAgentQueueImmediate already
  // handled the old queue.
  const ownerConv = activeConversation;
  try {
    while (pendingAgentQueue.length > 0) {
      await waitForSpeechEnd();
      if (activeConversation !== ownerConv) break;
      const next = pendingAgentQueue.shift();
      if (next === undefined) break;
      voiceAppend({ role: "assistant", content: next });
    }
  } finally {
    agentQueueDraining = false;
  }
}

function flushAgentQueueImmediate(): void {
  while (pendingAgentQueue.length > 0) {
    const text = pendingAgentQueue.shift();
    if (text === undefined) break;
    voiceAppend({ role: "assistant", content: text });
  }
}

// Monotonic generation counter + target slot for ScrollTo coalescing.
// Every ScrollTo invocation bumps scrollGen and overwrites
// pendingScrollTarget; only the call whose myGen still matches when its
// silence-wait resolves actually applies the scroll. See ScrollTo
// handler for the why.
let scrollGen = 0;
let pendingScrollTarget: { path: string; anchor: string } | null = null;
// ScrollTo's budget, inside ElevenLabs' 30 s for a client tool: the words playing, then the viewer's answer.
const SCROLL_SPEECH_WAIT_MS = 8000;
const SCROLL_SPEECH_START_MS = 1200;
const SCROLL_ANSWER_MS = 9000;

const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

/** Move the viewer of `path` (opened first when it is not on screen) and say what happened, in the viewer's words. */
async function scrollViewer(path: string, anchor: string): Promise<string> {
  const s = useStore.getState();
  const name = path.split(/[\\/]/).pop() ?? path;
  const shown = [s.currentFile, ...s.panes.map((p) => p.file)].find((f): f is string => !!f && samePath(f, path));
  if (shown) path = shown;
  else {
    try {
      const content = isUnreadableAsText(path) ? "" : await invoke<string>("read_text_file", { path });
      s.setCurrentFile(path, content);
    } catch (e) {
      return `Error: couldn't open ${name}: ${(e as Error)?.message ?? String(e)}`;
    }
  }
  const kind = fileKind(path).kind;
  // HTML, markdown (reading view) and PDF answer with where they moved, or why they could not.
  const answers = kind === "html" || kind === "markdown" || kind === "pdf";
  const answer = answers ? awaitScroll(path, anchor, SCROLL_ANSWER_MS) : null;
  useStore.getState().requestScrollAnchor(path, anchor);
  if (!answer) return `Scrolled to ${anchor} in ${name}`;
  return (await answer) ?? `Error: the viewer of ${name} did not answer in ${SCROLL_ANSWER_MS / 1000} s (is it still loading?). Try again in a moment.`;
}

/** Tools that act on the viewer: they run here, never on the box (src/voicePrompt.ts). */
export const LOCAL_VOICE_TOOLS = SCREEN_TOOLS;
/** A voice tool run elsewhere (the box): name + args -> the result the agent hears. */
export type RemoteVoiceTool = (name: string, args: any) => Promise<string>;

function isMicProblem(e: unknown): boolean {
  return /NotAllowed|NotFound|NotReadable|Overconstrained|Permission|microphone/i.test(`${(e as any)?.name ?? ""} ${(e as any)?.message ?? String(e)}`);
}

export async function startElevenLabsSession(opts?: { recap?: string }): Promise<void> {
  if (activeConversation) return;
  // This start's own number: only the newest call's close may clear the call's state (transcript, updates).
  const myCall = ++liveCall;
  const state = useStore.getState();
  // Voice is the box's: its agent, its key, its tools (one agent, one key
  // place). No box, or the box out of reach: voice says so and does not start.
  const { boxVoice, boxVoiceSession, voiceTranscriptMirror, voiceToolVia } = await import("./voiceBox");
  const box = await boxVoice(state.vaultPath);
  if (box) {
    const { boxPost } = await import("./boxChat");
    ship.post = async (body) => {
      const r = await boxPost(box.link, "/api/v1/board/log", body);
      if (!r.ok) throw new Error(r.error ?? "not sent");
    };
    ship.installPageHide();
  }
  if (!box) {
    reportVoiceError("Connect your box to talk — voice runs on the box (Settings → Box).");
    return;
  }

  // "Connecting…" lights up the cockpit immediately so the user
  // knows the click registered. Cleared in onConnect (success) or
  // any of the error paths below.
  useStore.getState().setVoiceConnecting(true);

  // No mic pre-flight of our own: the SDK opens the one mic stream (a second
  // getUserMedia here could leave Windows capturing with other settings); a
  // refused mic surfaces from startSession below, in the same words.

  // Voice is the front of house of the conversation that is open (a new one when none is): its prompt is that
  // conversation's pi session, its lines go into it, its requests are the agent's turns in it (server/voice.ts).
  let convId = state.activeConversationId ?? useStore.getState().newConversation();
  useStore.setState({ voiceNotice: null });
  const r = await boxVoiceSession(box, convId);
  if (!r.session) {
    useStore.getState().setVoiceConnecting(false);
    const { BOX_UNREACHABLE, unreachableWhy } = await import("./boxChat");
    reportVoiceError(
      r.unreachable
        ? `${BOX_UNREACHABLE}: ${unreachableWhy(r.error ?? "")}. Voice runs on the box.`
        : r.unsupported
          ? "The box has no voice for this vault (is the vault on the box, and the box up to date?)."
          : `The box couldn't start voice: ${r.error ?? "no answer"}.`,
    );
    return;
  }
  const boxSession = r.session;
  // One voice at a time: voice was live on another device — this call continues its conversation (the box says which).
  const sessionId = boxSession.sessionId ?? null;
  if (boxSession.handoff?.convId && boxSession.handoff.convId !== convId) {
    convId = boxSession.handoff.convId;
    vlog("voice handoff", { from: boxSession.handoff.from });
    try {
      useStore.getState().selectConversation(convId);
    } catch (e) {
      console.warn("[voice-eleven] couldn't open the handed-over conversation:", e);
    }
  }
  // Credentials for both transports: a WebRTC conversation token (preferred)
  // and a signed URL (WebSocket: Linux, or the fallback).
  const signedUrl = boxSession.signedUrl ?? null;
  const conversationToken = boxSession.conversationToken ?? null;
  let override: string | null = null;
  try {
    override = localStorage.getItem("vault_chat_voice_transport");
  } catch {
    /* no storage */
  }
  const picked = pickTransport({ ua: navigator.userAgent, override, hasToken: !!conversationToken, hasSignedUrl: !!signedUrl });
  if (!picked) {
    useStore.getState().setVoiceConnecting(false);
    reportVoiceError("ElevenLabs gave no way to connect (no conversation token, no signed URL).");
    return;
  }
  let transport: Transport = picked;

  lastViewportSent = null;
  sentPdfPaths.clear();
  imagePusher.reset();
  quietGate.reset();
  resetAgentEnvelope();
  stopHealthWatch();

  // The call's lines go into the attached conversation on the box, in order (the box writes them into its pi session).
  transcriptMirror = voiceTranscriptMirror(box, convId, undefined, sessionId);
  voiceChats = { own: () => convId, from: convId, local: convId };
  followCall = (to) => {
    convId = to;
    transcriptMirror?.follow?.(to);
    voiceChats = { own: () => convId, from: to, local: to };
  };
  boxVaultRoot = boxSession.vaultRoot ?? null;
  startViewportWatch();

  const voiceState = useStore.getState();
  const basePrompt = boxSession.systemPrompt;
  // A reconnect after a timeout: what was in flight, and to carry on in small steps.
  const systemPrompt = opts?.recap ? `${basePrompt}\n\n${opts.recap}` : basePrompt;
  turnStats.startSession(systemPrompt.length);
  fillerWatch.reset();
  vlog("voice session", { promptChars: systemPrompt.length, llm: getCurrentLlm(), reconnect: !!opts?.recap, transport });
  const dynamicVariables = buildDynamicVariables(voiceState);
  const voiceId = boxSession.voiceId ?? localStorage.getItem(VOICE_ID_STORAGE) ?? DEFAULT_VOICE_ID;
  // One line per start, so a report of "the voice didn't work" has the voice it asked for.
  console.info(`[voice-eleven] starting: voice ${voiceId}, the box's agent`);

  try {
    activeTransport = transport;
    const startedAt = Date.now();
    // The mic: the physical device behind the system default, pinned for the whole call (voiceMic.ts) — Windows
    // flipping its default/communications endpoints mid-call no longer moves or ends it. Logged ("voice mic pinned").
    const listed = await micPin.devices();
    let micId = await micPin.atStart(listed);
    // The agent's output too, where the page can pick one (Chromium's setSinkId; Linux's WebSocket plays natively).
    let outId = canPickOutput() && !(transport === "websocket" && isLinuxWebview()) ? await outPin.atStart(listed) : (outPin.reset(), undefined);
    const start = () => voiceSdk.startSession({
      ...connectionOptions(transport, { conversationToken, signedUrl }),
      ...(micId ? { inputDeviceId: micId } : {}),
      ...(outId ? { outputDeviceId: outId } : {}),
      overrides: {
        agent: {
          prompt: { prompt: systemPrompt },
          firstMessage: "",
          language: "en",
        },
        tts: { voiceId },
      },
      dynamicVariables,
      // Ask runs on the box in the attached conversation (whatever chat is open meanwhile), after the lines before it.
      clientTools: buildClientToolHandlers(voiceToolVia(box.link, box.vault, undefined, () => convId, () => sessionId), boxSession.toolNames, () => transcriptMirror?.done?.()),
      // Agent audio arrived (the health watch compares it with what plays).
      // Linux (WebSocket): the webview can't play Web Audio, so the chunk is
      // played natively and feeds the bars' envelope. WebRTC: the SDK plays it.
      onAudio: (audioBase64: string) => {
        health.audioReceived(Date.now());
        if (!nativePlayback()) return;
        playAgentAudioNative(audioBase64);
        try {
          pushAgentEnvelope(audioBase64);
        } catch {}
      },
      onInterruption: () => {
        // "It cut out and said a different sentence": a barge-in ElevenLabs
        // detected (the user's voice — or, on WebSocket, the agent's own echo).
        vlog("voice interruption", { transport, heldPushes: quietGate.pending });
        if (nativePlayback()) {
          stopAgentAudioNative();
          resetAgentEnvelope();
        }
      },
      onStatusChange: ({ status }: { status: string }) => vlog("voice status", { status, transport }),
      onConversationMetadata: (m: any) =>
        vlog("voice metadata", { conversationId: m?.conversation_id, inFormat: m?.user_input_audio_format, outFormat: m?.agent_output_audio_format }),
      onConnect: ({ conversationId }: { conversationId?: string } = {}) => {
        vlog("voice connected", { transport, conversationId, connectMs: Date.now() - startedAt });
        useStore.setState({ voiceError: null });
        useStore.getState().setVoiceConnecting(false);
        useStore.getState().setVoiceListening(false);
        useStore.getState().setVoiceSpeaking(false);
        useStore.getState().setVoiceThinking(false);
      },
      onDisconnect: (details?: any) => {
        // An earlier call's close (one that a later start replaced) is not this call's: it tears nothing down.
        if (myCall !== liveCall) {
          vlog("voice closed (an earlier call)", { reason: details?.reason });
          return;
        }
        // Every close, ours included, with its reason (one ended at 01:07 with no trace).
        vlog("voice closed", {
          transport,
          reason: details?.reason,
          message: details?.message,
          closeCode: details?.closeCode ?? details?.context?.code,
          closeReason: details?.closeReason ?? details?.context?.reason,
          context: details?.context?.type,
          afterMs: Date.now() - startedAt,
          ...turnStats.atClose(),
        });
        void ship.flush();
        voiceSessionClosed(details);
      },
      onMessage: ({ message, role }: { message: string; role: string }) => {
        // The agent's audio tags ("[excited]") shaped the audio; the transcript drops them.
        const raw = (message ?? "").trim();
        const text = role === "agent" ? stripAudioTags(raw) : raw;
        if (!text) return;
        // Live append: each completed user/agent turn lands in the
        // chat pane as it arrives, not buffered until session end.
        // ElevenLabs sends whole messages (not token streams), so
        // there's no spam — one append per turn boundary.
        if (role === "user") {
          // Our own reconnect nudge and the box's updates ([vc:result] …) are not Carl's lines.
          if (text === RECONNECT_NUDGE || isControlLine(text)) return;
          const heardAt = Date.now();
          fillerWatch.userLine();
          turnStats.userTurn(text, heardAt, health.userTranscript(heardAt));
          // Heard: a later deaf spell gets its own re-acquire before any line.
          micRecoveries = 0;
          voiceAppend({ role: "user", content: text });
          // User finished a turn — agent is now thinking until TTS
          // audio arrives. Drives the sine-wave visualizer; cleared
          // in onModeChange when mode flips to "speaking" (first
          // audio chunk arrives) or back to "listening" (barge-in).
          // 8s safety guard via setTimeout in case neither fires.
          useStore.getState().setVoiceThinking(true);
          armThinkingSafetyTimeout();
          // Client-side belt-and-suspenders for end_call. If the
          // whole utterance matches one of a few unambiguous end
          // phrases, hang up without waiting for the agent's
          // judgment. Conservative whitelist — won't match
          // ambiguous "I'm done talking about it" style phrases.
          if (looksLikeEnd(text)) {
            void endElevenLabsSession("he said goodbye");
          }
        } else if (role === "agent") {
          const filler = text === SOFT_TIMEOUT_MESSAGE;
          if (fillerWatch.agentLine(filler)) vlog("voice filler in silence", { turn: turnStats.turns });
          turnStats.agentText(text, filler || isFillerLine(text));
          if (filler) turnStats.fillerSpoken();
          else logTurn(turnStats.firstResponse("text", Date.now(), text.length));
          // A holding line ("One sec", "on it") is spoken, never written into the thread.
          if (isFillerLine(text)) return;
          // Queue and drain serially. onMessage fires on text-complete,
          // not audio-complete; appending now would race the transcript
          // ahead of the user's ears. Each queued message waits its
          // own silence window before landing in the chat so rapid-fire
          // turns flush in order, not all at once.
          pendingAgentQueue.push(text);
          // Its math is formatted while the audio plays, so the line lands rendered.
          prefetchVoiceMath(text);
          void drainAgentQueue();
        }
      },
      onModeChange: ({ mode }: { mode: string }) => {
        useStore.getState().setVoiceListening(mode === "listening");
        useStore.getState().setVoiceSpeaking(mode === "speaking");
        // Clear thinking the moment the first TTS chunk arrives — mode
        // flips listening → speaking in `handleAudio` at chunk arrival
        // per the SDK source. The wave hands off to the real output
        // spectrum on this transition.
        // The turn's timing is logged when audio is audibly playing (the health watch), not here.
        if (mode === "speaking") {
          useStore.getState().setVoiceThinking(false);
          stopThinkingWatcher();
        }
        // Barge-in path: when the user starts speaking, ElevenLabs
        // cuts the agent's TTS and flips mode to "listening". Commit
        // whatever was pending so the transcript reflects the partial
        // turn that was actually heard, and clear thinking since the
        // agent's response (if any) is no longer in flight.
        if (mode === "listening") {
          flushAgentQueueImmediate();
          useStore.getState().setVoiceThinking(false);
          stopThinkingWatcher();
          // Linux envelope: mode leaves "speaking" once the buffer drained (or a
          // barge-in cut it), so any unconsumed tail is stale. Drop it.
          if (nativePlayback()) resetAgentEnvelope();
        }
      },
      onError: (message: string) => {
        console.warn("[voice-eleven] session error:", message);
        // The composer's waves turn red until the next start or connect.
        useStore.setState({ voiceError: message });
        // Surface to the chat pane so a silent drop has SOMETHING the
        // user can show us — otherwise "the convo dropped" is impossible
        // to diagnose without a dev console open.
        voiceAppend({
          role: "assistant",
          content: `Voice session error: ${message}`,
          system: true,
        });
      },
    });
    let conv: ActiveConversation;
    try {
      try {
        conv = await start();
      } catch (e) {
        // The pinned device refused (gone between the listing and the open, held exclusively): the system default.
        if (!micId || !isMicProblem(e) || /NotAllowed|Permission/i.test(`${(e as any)?.name ?? ""} ${(e as any)?.message ?? ""}`)) throw e;
        vlog("voice mic pin failed", { at: "start", error: String((e as Error)?.message ?? e).slice(0, 300) });
        micPin.reset();
        outPin.reset();
        micId = undefined;
        outId = undefined;
        conv = await start();
      }
    } catch (e) {
      // WebRTC refused (a network that blocks it): once more over WebSocket, when there's a signed URL.
      if (transport !== "webrtc" || !signedUrl || isMicProblem(e)) throw e;
      vlog("voice transport fallback", { from: "webrtc", error: String((e as Error)?.message ?? e).slice(0, 300) });
      transport = "websocket";
      activeTransport = transport;
      conv = await start();
    }
    activeConversation = conv;
    // The connection's health, from the SDK's own meters (voiceHealth.ts).
    void startHealthWatch(conv, transport);
    // The box's updates for this conversation (the agent's answers, what Carl did elsewhere), into the call.
    updates?.stop();
    updates = new VoiceUpdates({
      cursor: boxSession.cursor ?? null,
      conv: () => (activeConversation === conv ? conv : null),
      gate: quietGate,
      // A result he is waiting for waits until he isn't mid-sentence (and the voice isn't working out a reply to him).
      userSpeaking: () => carlSpeaking(conv),
      fetch: (cursor) => fetchUpdates(box.link, convId, cursor, sessionId),
      log: (ev, data) => vlog(ev, data),
      // Voice moved to another device (one voice at a time): this call ends, and the laptop says where it went.
      onMoved: (m) => {
        if (activeConversation !== conv) return;
        vlog("voice moved away", { to: m.to });
        void endElevenLabsSession("moved to another device").finally(() => {
          useStore.setState({ voiceNotice: m.line });
          // Said for a while, not forever (the other device's call may end too).
          const t = setTimeout(() => useStore.getState().voiceNotice === m.line && useStore.setState({ voiceNotice: null }), 60_000);
          (t as { unref?: () => void }).unref?.(); // (node, in tests: a pending notice never holds the process)
        });
      },
    }).start();
    // The conversation's recent images: this ElevenLabs conversation has never seen them.
    {
      const st = useStore.getState();
      const own = st.activeConversationId === convId ? st.messages : (st.conversations.find((c) => c.id === convId)?.messages ?? []);
      // A reconnect: only the newest (the recap carries the words; LookAtScreen sees the rest).
      void pushThreadImages(own, st.vaultPath, opts?.recap ? 1 : 3).catch((e) => console.warn("[voice-eleven] thread images:", e));
    }
    // Reconnected after a timeout: the agent picks the request back up (the recap is in its prompt).
    if (opts?.recap) {
      try {
        conv.sendUserMessage(RECONNECT_NUDGE);
      } catch (e) {
        console.warn("[voice-eleven] reconnect nudge failed:", e);
      }
    }
  } catch (e) {
    console.error("[voice-eleven] session start failed:", e);
    activeConversation = null;
    activeTransport = null;
    stopHealthWatch();
    const msg = (e as any)?.message ?? String(e);
    useStore.getState().setVoiceConnecting(false);
    if (isMicProblem(e)) {
      reportVoiceError(`Microphone access denied or unavailable: ${msg}. Check Windows Settings → Privacy → Microphone, and the system's default input device.`);
      return;
    }
    reportVoiceError(`Voice session failed to start: ${msg}.`);
  }
}


// Subscribes to the store and pushes a contextual update whenever
// the active pane / current file changes mid-session. Without this,
// switching pane focus in split view doesn't tell the agent — the
// per-viewer scroll listener only fires on actual scroll events.
function startViewportWatch(): void {
  let lastSig = "";
  unsubscribeViewportWatch = useStore.subscribe((state) => {
    const sig = `${state.activePaneId ?? ""}|${state.currentFile ?? ""}|${state.panes.map((p) => p.file).join(",")}`;
    if (sig === lastSig) return;
    lastSig = sig;
    pushViewportContextDebounced();
  });
}

function stopViewportWatch(): void {
  if (unsubscribeViewportWatch) {
    unsubscribeViewportWatch();
    unsubscribeViewportWatch = null;
  }
}

// Whole-utterance whitelist for client-side hang-up. Each entry has
// to match the entire transcribed turn (modulo trailing punctuation)
// so we don't false-positive on phrases that contain "bye" inside a
// longer sentence ("we said goodbye to that idea"). Add new phrases
// only if they're unambiguously a session-end signal.
const END_PHRASES = new Set([
  "goodbye",
  "bye",
  "bye bye",
  "okay bye",
  "ok bye",
  "alright bye",
  "thanks bye",
  "thank you bye",
  "we're done",
  "we are done",
  "i'm done",
  "im done",
  "i am done",
  "all done",
  "that's all",
  "thats all",
  "that is all",
  "that's all for now",
  "talk later",
  "talk to you later",
  "catch you later",
  "hang up",
  "end the call",
  "end this call",
  "end the conversation",
  "end this conversation",
  "end conversation",
]);

function looksLikeEnd(text: string): boolean {
  const cleaned = text
    .toLowerCase()
    .replace(/[.,!?]+$/g, "")
    .trim();
  return END_PHRASES.has(cleaned);
}

/** Why ElevenLabs closed the session, or "" for a normal end (ours, or the agent's 1000). */
/** The session closed (onDisconnect). A close because the model timed out
 *  reconnects once, with a recap, keeping the call on; a second one soon after
 *  ends it with one plain line. Anything else ends it as before. */
export function voiceSessionClosed(details?: { reason?: string; message?: string; closeCode?: number; closeReason?: string }): void {
  const why = disconnectReason(details);
  const timeout = !!why && isLlmTimeoutClose(details);
  // Lines the agent had queued land before any notice (they were said first).
  flushAgentQueueImmediate();
  const retry = timeout && timeoutRetry.take();
  let recap = "";
  if (timeout) {
    vlog("voice timeout", { why, retry, ...turnStats.atClose(), images: imagePusher.uploaded });
    console.error("[voice-eleven] session closed:", why, retry ? "(reconnecting once)" : "(the reconnect timed out too)");
    const st = useStore.getState();
    const local = voiceChats?.local;
    const lines = local && local !== st.activeConversationId ? (st.conversations.find((c) => c.id === local)?.messages ?? []) : st.messages;
    recap = reconnectRecap(lines);
    voiceAppend({ role: "assistant", content: retry ? RECONNECTING_LINE : couldntReconnectLine(plainCloseReason(details)), system: true });
  } else if (why) {
    // A close that wasn't ours says why (a refused voice or override closes
    // the socket with a reason, and it used to end with no trace at all).
    console.error("[voice-eleven] session closed:", why);
    voiceAppend({ role: "assistant", content: `Voice session closed by ElevenLabs: ${why}`, system: true });
  }
  // Stop any native agent audio still playing/queued (Linux).
  if (nativePlayback()) stopAgentAudioNative();
  resetAgentEnvelope();
  stopHealthWatch();
  activeTransport = null;
  if (!retry) {
    voiceAppend({
      role: "assistant",
      content: "Voice session ended.",
      system: true,
    });
  }
  transcriptMirror = null;
  updates?.stop();
  updates = null;
  quietGate.reset();
  voiceChats = null;
  followCall = null;
  activeConversation = null;
  stopViewportWatch();
  // Flip the mic-button source of truth off so it matches
  // reality. Critical for end_call / end-phrase paths where
  // the click handler never ran. Idempotent for manual ends
  // (endElevenLabsSession already set it). A reconnect keeps it on.
  useStore.setState({ voiceMode: retry, voiceMicMuted: false });
  useStore.getState().setVoiceConnecting(retry);
  useStore.getState().setVoiceListening(false);
  useStore.getState().setVoiceSpeaking(false);
  useStore.getState().setVoiceThinking(false);
  useStore.getState().setVoiceCurrentTool(null);
  stopThinkingWatcher();
  pendingScrollTarget = null;
  scrollGen++;
  // If anything got written / a note got saved, snapshot the
  // session as a single git commit and refresh the file tree.
  // Fire-and-forget — UI doesn't need to wait.
  if (retry) void reconnectAfterTimeout(recap);
}

async function reconnectAfterTimeout(recap: string): Promise<void> {
  const r = { error: null as string | null };
  reconnecting = r;
  try {
    await (restartForTests ?? ((x: string) => startElevenLabsSession({ recap: x })))(recap);
  } catch (e) {
    r.error = (e as Error)?.message ?? String(e);
  } finally {
    reconnecting = null;
  }
  if (activeConversation) return;
  // The retry didn't connect: one plain line, and the call is off.
  const msg = couldntReconnectLine(r.error ?? "no answer from ElevenLabs");
  vlog("voice reconnect failed", { error: r.error });
  voiceAppend({ role: "assistant", content: msg, system: true });
  voiceAppend({ role: "assistant", content: "Voice session ended.", system: true });
  useStore.setState({ voiceMode: false, voiceMicMuted: false, voiceError: msg });
  useStore.getState().setVoiceConnecting(false);
}

export function disconnectReason(d?: { reason?: string; message?: string; closeCode?: number; closeReason?: string }): string {
  if (!d || d.reason === "user") return "";
  if (d.reason === "agent" && (d.closeCode === undefined || d.closeCode === 1000) && !d.closeReason) return "";
  return [d.message, d.closeReason, d.closeCode !== undefined ? `code ${d.closeCode}` : ""].filter(Boolean).join(" — ") || String(d.reason ?? "unknown");
}

function reportVoiceError(message: string): void {
  // An error line on every failed start (the app log mirrors console.error).
  console.error("[voice-eleven] voice start failed:", message);
  // A timeout reconnect says its own one line (couldntReconnectLine).
  if (reconnecting) {
    reconnecting.error = message;
    return;
  }
  // The composer's waves turn red (VoiceCockpit's InlineVoiceWaves) until the
  // next start attempt or a successful connect.
  useStore.setState({ voiceError: message });
  voiceAppend({
    role: "assistant",
    content: `⚠️ Voice mode: ${message}`,
    system: true,
  });
}

/** Ends the call. `by` says who ended it, in the log ("voice end"): a close with reason "user" is always one of
 *  these, and Carl's "it hung up when I switched layouts" (2026-10-21) could not say which. Nothing on a layout
 *  change calls this: the call is this module's, not a component's. */
export async function endElevenLabsSession(by = "app"): Promise<void> {
  if (activeConversation) vlog("voice end", { by });
  if (scrollDebounceTimer !== null) {
    clearTimeout(scrollDebounceTimer);
    scrollDebounceTimer = null;
  }
  // Commit any buffered agent text before tearing down — otherwise a
  // turn whose audio was still draining when the user hit "end" gets
  // dropped from the transcript.
  flushAgentQueueImmediate();
  timeoutRetry.reset();
  const conv = activeConversation;
  activeConversation = null;
  updates?.stop();
  updates = null;
  stopHealthWatch();
  // Cut audio synchronously before the async endSession() runs.
  // Without this, the user can keep speaking and the SDK keeps
  // streaming their audio to ElevenLabs until the WebSocket
  // actually closes — agent hears them and replies even though
  // they hit the mic toggle.
  if (conv) {
    try {
      conv.setMicMuted(true);
    } catch {}
  }
  // Clear voice state synchronously BEFORE the async endSession()
  // runs. Anything observing voiceMode flipping false (e.g.
  // waitForSpeechEnd's evaluate) now sees consistent state — no
  // window where voiceMode=false but voiceSpeaking is still true
  // from the prior turn.
  useStore.setState({ voiceMode: false, voiceMicMuted: false });
  useStore.getState().setVoiceListening(false);
  useStore.getState().setVoiceSpeaking(false);
  useStore.getState().setVoiceConnecting(false);
  useStore.getState().setVoiceCurrentTool(null);
  stopViewportWatch();
  if (!conv) return;
  try {
    await conv.endSession();
  } catch (e) {
    console.warn("[voice-eleven] end session failed:", e);
  }
}

/** The mic button and Ctrl+D: start a session, or end the live one. voiceMode
 *  goes on at once so the click shows; startElevenLabsSession's error paths and
 *  onDisconnect turn it off again. */
export function toggleVoice(by: string = "toggle"): void {
  // A press while the call is still connecting does nothing (10-22: two presses in a 17 s connect left a call whose
  // lines reached no record for 70 minutes). It connects, or fails and says so; then the mic toggles as always.
  if (useStore.getState().voiceConnecting && !activeConversation) {
    vlog("voice toggle ignored", { why: "connecting", by: typeof by === "string" ? by : "toggle" });
    return;
  }
  if (!useStore.getState().voiceMode) {
    vlog("voice start", { by: typeof by === "string" ? by : "toggle" });
    // A retry: the red waves go back to normal while it connects.
    useStore.setState({ voiceMode: true, voiceError: null });
    void startElevenLabsSession();
  } else {
    void endElevenLabsSession(typeof by === "string" ? by : "toggle");
  }
}

/** [preview harness] Run the live-session paths against a scripted ElevenLabs
 *  conversation (the preview has no mic or ElevenLabs): levels, image uploads,
 *  mute, end. Null ends it as onDisconnect would. `line` lands a finished
 *  line as onMessage does (the agent's math prefetched while it "speaks"). */
export function adoptVoiceSessionForPreview(conv: unknown): { line: (role: "user" | "agent", text: string) => void } {
  const line = (role: "user" | "agent", text: string) => {
    if (role === "agent") prefetchVoiceMath(text);
    voiceAppend({ role: role === "user" ? "user" : "assistant", content: text });
  };
  if (conv) {
    activeConversation = conv as ActiveConversation;
    // The session runs in the conversation that is open (as a desktop start continues it).
    const id = useStore.getState().activeConversationId;
    voiceChats = { own: () => id, from: id, local: id ?? undefined };
    sentPdfPaths.clear();
    imagePusher.reset();
    useStore.setState({ voiceMode: true, voiceMicMuted: false });
    useStore.getState().setVoiceConnecting(false);
    startViewportWatch();
  } else {
    activeConversation = null;
    voiceChats = null;
    stopViewportWatch();
    useStore.setState({ voiceMode: false, voiceMicMuted: false });
  }
  return { line };
}

// Gate primitive for "the agent has finished speaking this turn."
//
// Earlier versions of this code polled getOutputByteFrequencyData and
// resolved when amplitude dropped below a threshold for a window. That
// was wrong: the SDK's analyser sits post-gain after the audio worklet,
// so amplitude reads silent during the buffer-up phase at the start of
// every turn — the gate would fire BEFORE audio had played at all,
// which is what caused scrolls and chat text to race ahead of voice.
//
// Correct primitive: subscribe to `voiceSpeaking`, which the SDK
// derives from the audio worklet's drain signal (`handleAudio` →
// "speaking" on chunk arrival; worklet posts `finished:true` → mode
// "listening" when the buffer empties). This is the SDK's authoritative
// "audio is playing right now" flag.
//
// Wrinkle: mode can flip listening → speaking → listening multiple
// times within a single agent turn at inter-chunk gaps. So we require
// `voiceSpeaking` to stay false continuously for sustainedMs before
// resolving — distinguishes "real end-of-turn" from "tiny worklet gap
// between chunks." 250ms is enough to absorb chunk handoffs but short
// enough that post-turn actions feel snappy.
function waitForSpeechEnd(
  sustainedMs = 250,
  hardTimeoutMs = 30000,
  // Speech that has not started by then is not coming (the call came before any words): go on.
  startWithinMs = 0,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    // Whether we've observed voiceSpeaking flip true at least once.
    // Critical: this gate is often called *before* audio for the turn
    // starts arriving (tool calls can be dispatched ahead of the first
    // chunk). If we armed the sustained-false timer immediately when
    // speaking was already false, we'd resolve in 250ms — before TTS
    // had a chance to play. So we wait for the first audio chunk
    // (mode → speaking) before arming.
    let sawSpeaking = useStore.getState().voiceSpeaking;

    const finish = () => {
      if (done) return;
      done = true;
      unsub();
      if (armTimer) {
        clearTimeout(armTimer);
        armTimer = null;
      }
      clearTimeout(safetyTimer);
      resolve();
    };

    const evaluate = () => {
      const state = useStore.getState();
      // Session ended (manual end / disconnect / end_call). Don't sit
      // on the 30s hard timeout — there's no audio to wait for, and
      // any caller still parked here is blocking work that belongs to
      // a freshly-started next session. voiceMode is the source-of-
      // truth flag, flipped synchronously in endElevenLabsSession and
      // in onDisconnect.
      if (!state.voiceMode) {
        finish();
        return;
      }
      if (state.voiceSpeaking) {
        sawSpeaking = true;
        if (armTimer) {
          clearTimeout(armTimer);
          armTimer = null;
        }
      } else if (sawSpeaking && !armTimer) {
        armTimer = setTimeout(finish, sustainedMs);
      }
    };

    const safetyTimer = setTimeout(finish, hardTimeoutMs);
    if (startWithinMs > 0) setTimeout(() => !sawSpeaking && finish(), startWithinMs);
    const unsub = useStore.subscribe(evaluate);
    evaluate();
  });
}

// Safety net for voiceThinking: if neither mode → speaking nor
// barge-in fires within 8s of the user turn ending, force-clear the
// flag so the sine wave doesn't stick on screen forever. Normal path
// clears it inside onModeChange.
let thinkingSafetyTimeout: ReturnType<typeof setTimeout> | null = null;
function armThinkingSafetyTimeout(): void {
  stopThinkingWatcher();
  thinkingSafetyTimeout = setTimeout(() => {
    useStore.getState().setVoiceThinking(false);
    thinkingSafetyTimeout = null;
  }, 8000);
}
function stopThinkingWatcher(): void {
  if (thinkingSafetyTimeout !== null) {
    clearTimeout(thinkingSafetyTimeout);
    thinkingSafetyTimeout = null;
  }
}

// Tracks which PDF paths we've already uploaded to ElevenLabs during
// this session. We upload the WHOLE document once per file — Gemini
// (and Anthropic on the ElevenLabs side) accept PDF blobs natively and
// keep the doc in context, so per-page re-uploads burn tokens for
// nothing. The active page is communicated via the text contextual
// update path instead. Cleared on session end.
const sentPdfPaths = new Set<string>();
let pdfUploadInFlight = false;

// 50MB cap matches Gemini's per-PDF limit; ElevenLabs's conversation
// upload endpoint doesn't publish a cap, but going larger risks
// silent server-side rejection. Lectures are typically 5-20MB.
const MAX_PDF_UPLOAD_BYTES = 50 * 1024 * 1024;

// Ambient vision for voice mode: when the user opens a PDF, ship the
// full document to the live conversation so the agent's native LLM
// can see every page (text, equations, diagrams, layout — Gemini
// handles native PDFs without rasterizing). Skips if we've already
// sent this path this session. No-op for non-PDFs.
async function pushPdfIfNeeded(): Promise<void> {
  const conv = activeConversation;
  if (!conv) return;
  if (pdfUploadInFlight) return;
  const state = useStore.getState();
  if (!state.followAlong) return;
  const file = state.currentFile;
  if (!file) return;
  if (!file.toLowerCase().endsWith(".pdf")) return;
  if (sentPdfPaths.has(file)) return;
  // Only to a model that reads documents (else it has PdfExtract).
  if (!readsDocuments(getCurrentLlm())) return;

  pdfUploadInFlight = true;
  try {
    const bytes = await invoke<number[]>("read_binary_file", { path: file });
    if (bytes.length > MAX_PDF_UPLOAD_BYTES) {
      console.warn(`[voice-eleven] PDF too large (${bytes.length} bytes) — skipping upload for ${file}`);
      sentPdfPaths.add(file); // mark so we don't retry every scroll
      return;
    }
    if (!activeConversation || activeConversation !== conv) return;
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    const { fileId } = await conv.uploadFile(blob);
    // A user turn for the agent: never while it speaks.
    await quietGate.quiet(60_000);
    if (!activeConversation || activeConversation !== conv) return;
    const name = file.split(/[\\/]/).pop() ?? "document.pdf";
    sendFilesMessage(conv, `[The user has opened ${name}. The full PDF is attached for your reference — you can see every page including diagrams, equations, and layout. The viewport context will tell you which page they are currently viewing.]`, [fileId]);
    sentPdfPaths.add(file);
  } catch (e) {
    console.warn("[voice-eleven] PDF upload failed:", e);
  } finally {
    pdfUploadInFlight = false;
  }
}

// Images: the same ambient vision for an image the user has open, shows via
// ShowFile, or asks about with LookAtScreen (voiceImages.ts: once per key a
// session, size-capped). In box mode the image is in the vault on both sides,
// so it is read here.
const imagePusher = new VoiceImagePusher();

type FileConv = {
  uploadFile(b: Blob): Promise<{ fileId: string }>;
  sendMultimodalMessage(m: { text?: string; fileId: string }): void;
};

// sendFilesMessage lives in voiceImages.ts (the board's voice sends with it too).
export { sendFilesMessage };

/** The image pusher's sink: uploads through the SDK, sends in the current shape. */
function fileSink(conv: FileConv): import("./voiceImages").VoiceImageSink & { sendFiles(text: string | undefined, ids: string[]): void } {
  return {
    uploadFile: (b) => conv.uploadFile(b),
    sendMultimodalMessage: (m) => sendFilesMessage(conv, m.text, [m.fileId]),
    sendFiles: (text, ids) => sendFilesMessage(conv, text, ids),
  };
}
// Our own pushes (contextual updates, uploads) wait while the agent speaks — an
// upload is a user turn and cut its reply off mid-sentence (voiceQuiet.ts).
const quietGate = new QuietGate(() => useStore.getState().voiceSpeaking);
{
  // voiceSpeaking is the SDK's mode (onModeChange): speaking holds, the end of it flushes.
  let was = useStore.getState().voiceSpeaking;
  useStore.subscribe((st) => {
    if (st.voiceSpeaking === was) return;
    was = st.voiceSpeaking;
    quietGate.modeChanged();
  });
}
/** [tests] Pushes held until the agent stops speaking. */
export function heldVoicePushes(): number {
  return quietGate.pending;
}
/** How long a tool's own image push may wait for the agent to stop talking. */
const TOOL_PUSH_WAIT_MS = 10_000;

/** Send the image file at `path` to the live voice conversation (once a session). */
export async function pushVoiceImageFile(path: string, extra?: string): Promise<PushResult | "no-session"> {
  const conv = activeConversation;
  if (!conv) return "no-session";
  const mime = voiceImageMime(path);
  if (!mime) return "unsupported";
  if (!seesImages(getCurrentLlm())) return "unsupported";
  if (imagePusher.has(path)) return "duplicate";
  await quietGate.quiet(TOOL_PUSH_WAIT_MS);
  if (activeConversation !== conv) return "failed";
  try {
    const bytes = await invoke<number[]>("read_binary_file", { path });
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    const name = path.split(/[\\/]/).pop() ?? path;
    return await imagePusher.push(fileSink(conv), path, blob, lookingAtNote(name, extra), () => activeConversation === conv);
  } catch (e) {
    console.warn("[voice-eleven] image read failed:", e);
    return "failed";
  }
}

/** Send an image already in memory (a capture of the screen) under `key`. */
export async function pushVoiceImageDataUrl(key: string, dataUrl: string, name: string, extra?: string): Promise<PushResult | "no-session"> {
  const conv = activeConversation;
  if (!conv) return "no-session";
  await quietGate.quiet(TOOL_PUSH_WAIT_MS);
  if (activeConversation !== conv) return "failed";
  try {
    const blob = await (await fetch(dataUrl)).blob();
    return await imagePusher.push(fileSink(conv), key, blob, lookingAtNote(name, extra), () => activeConversation === conv);
  } catch (e) {
    console.warn("[voice-eleven] capture push failed:", e);
    return "failed";
  }
}

/** Several captured images (data URLs) to the live session in one message, each
 *  once (by content: a changed picture is new). One result per item. */
export async function pushVoiceImagesNow(items: { key: string; dataUrl: string }[], note: string): Promise<PushResult[] | "no-session"> {
  const conv = activeConversation;
  if (!conv) return "no-session";
  await quietGate.quiet(TOOL_PUSH_WAIT_MS);
  if (activeConversation !== conv) return items.map(() => "failed");
  const blobs = await Promise.all(items.map(async (it) => ({ key: it.key, blob: await (await fetch(it.dataUrl)).blob() })));
  return imagePusher.pushMany(fileSink(conv), blobs, note, () => activeConversation === conv);
}

/** LookAtScreen from the page: the focused pane as it is on screen now (screenLook.ts). */
async function lookAtScreenFromPane(pane: import("./screenLook").LookEl): Promise<string> {
  const { lookInPane, imageKey } = await import("./screenLook");
  const look = await lookInPane(pane);
  const file = look.file || useStore.getState().currentFile || "";
  const name = relPath(file) || "the open file";
  const more = look.above && look.below ? " There is more above and below: this is only the part in view." : look.above ? " There is more above: this is only the part in view." : look.below ? " There is more below: this is only the part in view." : "";
  const lines = [`The user's screen right now (read off their screen on this machine just now — not a synced copy): ${name} is open${look.mode ? ` (${look.mode})` : ""}, showing ${look.region}.${more}`];
  lines.push(look.text ? `Text in view:\n${look.text}` : "No text in view.");
  if (!look.images.length) lines.push("No images in view.");
  else if (!seesImages(getCurrentLlm())) {
    lines.push(`${look.images.length} image(s) in view (${look.images.map((i) => i.label).join(", ")}), but the voice model can't see images — ask the user what they show, or switch to a model that can.`);
  } else {
    const n = look.images.length;
    const res = await pushVoiceImagesNow(
      look.images.map((i) => ({ key: imageKey(i.dataUrl), dataUrl: i.dataUrl })),
      `[The user's screen now: ${name}, ${look.region} — the ${n === 1 ? "image" : `${n} images`} in view, top to bottom, attached. You can see them. Don't describe them unless asked.]`,
    );
    const why = (r: PushResult | "no-session") => (r === "too-large" ? "too large to upload" : r === "unsupported" ? "not an image the model takes" : r === "empty" ? "it is empty: there is nothing to see" : r === "no-session" ? "no live voice session" : "the upload to ElevenLabs failed");
    lines.push(
      `Images in view, top to bottom (${n}):\n` +
        look.images
          .map((im, i) => {
            const r = res === "no-session" ? "no-session" : res[i]!;
            const state = r === "sent" ? "attached now" : r === "duplicate" ? "already in your context, unchanged" : `couldn't attach (${why(r)})`;
            return `${i + 1}. ${im.label}${im.partial ? " (partly in view)" : ""} — ${state}`;
          })
          .join("\n"),
    );
  }
  if (look.failed.length) lines.push(`Couldn't capture: ${look.failed.join("; ")}.`);
  lines.push("This is exactly what is on the screen now; an image you saw earlier may be out of date.");
  if (fileKind(file).kind === "pdf") void pushPdfIfNeeded();
  return lines.join("\n");
}

// An absolute path on this machine for a path the agent gave: the box's vault
// root mapped to this vault, a vault-relative one joined to it.
function localPathFor(p: string | undefined): string | null {
  const state = useStore.getState();
  let path = (p ?? "").trim();
  if (!path) return null;
  if (boxVaultRoot && state.vaultPath && path.startsWith(boxVaultRoot)) {
    path = path.slice(boxVaultRoot.length).replace(/^[\\/]+/, "");
  }
  if (!/^([a-z]:[\\/]|[\\/])/i.test(path) && state.vaultPath) {
    path = `${state.vaultPath.replace(/[\\/]+$/, "")}/${path}`;
  }
  return path;
}

// A small copy of an image for the thread (fullscreen chat shows what the
// agent opened there), or null.
async function readImageThumb(path: string): Promise<string | null> {
  const mime = voiceImageMime(path);
  if (!mime) return null;
  try {
    const bytes = await invoke<number[]>("read_binary_file", { path });
    return await thumbDataUrl(new Blob([new Uint8Array(bytes)], { type: mime }));
  } catch {
    return null;
  }
}

// The PDF page on screen as a PNG, from the viewer's own canvas (null when
// the viewer isn't showing it — fullscreen chat, another file).
function capturePdfPage(page: number): string | null {
  try {
    const c = document.querySelector<HTMLCanvasElement>(`canvas.pdf-page[data-page="${page}"]`);
    if (!c || !c.width) return null;
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}

// The image the user has open (follow-along), pushed like the PDF.
async function pushImageIfNeeded(): Promise<void> {
  const state = useStore.getState();
  if (!activeConversation || !state.followAlong) return;
  const file = state.currentFile;
  if (!file || fileKind(file).kind !== "image") return;
  await pushVoiceImageFile(file);
}

export function pushViewportContextDebounced(): void {
  if (!activeConversation) return;
  if (scrollDebounceTimer !== null) clearTimeout(scrollDebounceTimer);
  scrollDebounceTimer = setTimeout(() => {
    scrollDebounceTimer = null;
    // Held while the agent speaks; only the latest viewport goes when it stops.
    quietGate.run("viewport", () => {
      const conv = activeConversation;
      if (!conv) return;
      const state = useStore.getState();
      if (!state.followAlong) return;
      const text = buildViewportContextText(state);
      if (text && text !== lastViewportSent) {
        lastViewportSent = text;
        try {
          // A stable context id: the newer viewport replaces the older (never a user turn).
          conv.sendContextualUpdate(text, { contextId: "viewport" });
        } catch (e) {
          console.warn("[voice-eleven] contextual update failed:", e);
        }
      }
      // Fire-and-forget the PDF push. Independent of the text update —
      // refocusing on the same PDF doesn't re-trigger an upload because
      // sentPdfPaths is a set.
      void pushPdfIfNeeded();
      void pushImageIfNeeded();
    });
  }, SCROLL_DEBOUNCE_MS);
}

/** At a session's start (a new start, a reconnect, a resumed thread): the most
 *  recent images in the thread — sent by Carl, or shown in it — go to the new
 *  ElevenLabs conversation, which has never seen them (the prompt carries the
 *  words only). One message, ≤ 3 images, newest last. */
export async function pushThreadImages(messages: ChatMessage[], vault: string | null, max = 3): Promise<PushResult[] | "no-session" | "none"> {
  const picked: { att: import("./store").ChatAttachment; who: string }[] = [];
  for (const m of messages.slice(-24).reverse()) {
    for (const a of m.attachments ?? []) {
      if (picked.length >= max) break;
      picked.push({ att: a, who: m.role === "user" ? "the user sent" : "shown in the chat" });
    }
    if (picked.length >= max) break;
  }
  picked.reverse();
  const items: { key: string; dataUrl: string }[] = [];
  const { imageKey } = await import("./screenLook");
  for (const p of picked) {
    let url = p.att.imageDataUrl && p.att.imageDataUrl.startsWith("data:image/") ? p.att.imageDataUrl : "";
    const rel = p.att.capturedFilePath ?? p.att.sourcePath;
    if (!url && rel && vault) {
      const abs = /^([a-z]:[\\/]|[\\/])/i.test(rel) ? rel : `${vault.replace(/[\\/]+$/, "")}/${rel}`;
      const mime = voiceImageMime(abs);
      try {
        if (mime) url = bytesToDataUrl(new Uint8Array(await invoke<number[]>("read_binary_file", { path: abs })), mime);
      } catch {
        /* not on this machine (yet): left out */
      }
    }
    if (url) items.push({ key: imageKey(url), dataUrl: url });
  }
  if (!items.length) return "none";
  return pushVoiceImagesNow(
    items,
    `[Earlier in this conversation (before this call), ${items.length === 1 ? "this image was" : `these ${items.length} images were`} shared in the chat, oldest first — attached so you can see them. Say nothing about them now; wait for the user.]`,
  );
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

// Voice text panel uses these to send a typed reply into the live
// session (instead of speaking aloud) and to silence the mic while
// the panel is open. The agent still responds with TTS — only the
// user side flips from voice to text.

// Heads-up to the agent that we're composing a typed reply. Without
// this, the agent reads the muted-mic silence as a drop-off and
// escalates: a single "..." → "you still there?" → "I'll assume
// you've stepped away" → end_call. The contextual update is a system
// message in the SDK's vocabulary — the agent sees it but doesn't
// treat it as a user turn, so it just sits still and waits.
export function sendVoiceTypingHint(kind: "opened" | "still-typing"): void {
  const conv = activeConversation;
  if (!conv) return;
  const text =
    kind === "opened"
      ? "The user has opened the typed-input panel and is composing a reply. Stay silent. Do not check in, do not fill the silence, do not call end_call. Their typed message will arrive as a normal user turn — wait for it."
      : "The user is still typing in the panel. Keep waiting silently.";
  quietGate.run("typing", () => {
    if (activeConversation !== conv) return;
    try {
      conv.sendContextualUpdate(text, { contextId: "typing" });
    } catch (e) {
      console.warn("[voice-eleven] typing-hint contextual update failed:", e);
    }
  });
}

/** A short line for the voice agent to say at the next natural pause (the board
 *  inbox: "<title> is in your board inbox"). Held while the agent speaks
 *  (quietGate), then handed over as a contextual update asking for one short
 *  sentence; it never interrupts and is never a user turn. No session: dropped. */
export function announceAtNextPause(line: string): void {
  const conv = activeConversation;
  if (!conv || !line.trim()) return;
  quietGate.run(`announce:${line}`, () => {
    if (activeConversation !== conv) return;
    try {
      conv.sendContextualUpdate(`Heads-up for Carl, to mention in one short sentence when you next talk with him (never break his silence for it; do not interrupt him): ${line.trim()}`);
    } catch (e) {
      console.warn("[voice-eleven] announce failed:", e);
    }
  });
}

/** The live call's move to another thread (set while a box call runs). */
let followCall: ((convId: string) => void) | null = null;
/** Carl asked to work in another thread (the agent's OpenProject; the box already sends the call's lines there): this
 *  client's call shows its lines there too. No live call: nothing. */
export function voiceFollow(convId: string): void {
  if (activeConversation && voiceChats?.own() !== convId) followCall?.(convId);
}

export function isVoiceSessionActive(): boolean {
  return activeConversation !== null;
}

/** A live voice session runs in conversation `id` (its own thread; box mode: the box's id or the local one before the rekey). */
export function voiceSessionOn(id: string | null | undefined): boolean {
  if (!activeConversation || !voiceChats || !id) return false;
  return id === voiceChats.own() || id === voiceChats.local;
}

/** The mute toggle (the composer's Mute button, Ctrl+Shift+M): the SDK's own mute, so no audio leaves the
 *  laptop while the voice can still speak a result; unmuting is instant. No live call: nothing. */
export function toggleVoiceMute(): boolean {
  if (!activeConversation) return false;
  const next = !useStore.getState().voiceMicMuted;
  setVoiceMicMuted(next);
  vlog("voice mute", { on: next, by: "carl" });
  return true;
}

export function setVoiceMicMuted(muted: boolean): void {
  const conv = activeConversation;
  if (!conv) return;
  try {
    conv.setMicMuted(muted);
    useStore.setState({ voiceMicMuted: muted });
  } catch (e) {
    console.warn("[voice-eleven] setMicMuted failed:", e);
  }
}

// Cut / restore the agent's TTS volume. Used by the text panel as a
// barge-in: the moment the user has typed enough characters to count
// as "intentionally interrupting" (>=2), we silence the agent so they
// can finish typing in peace. The server is still on its turn — when
// the user hits Enter, sendUserMessage triggers a real server-side
// interruption + new turn, and we restore volume so the next reply
// is audible.
export function setVoiceOutputMuted(muted: boolean): void {
  const conv = activeConversation;
  if (!conv) return;
  try {
    conv.setVolume({ volume: muted ? 0 : 1 });
  } catch (e) {
    console.warn("[voice-eleven] setVolume failed:", e);
  }
}

// Typed user turn. Mirrors what the SDK would emit when the user
// finishes speaking: append to chat, signal the "thinking" gate, and
// fire the user_message frame that triggers the agent's next turn
// (which naturally interrupts any TTS still playing).
export function sendVoiceUserText(text: string): boolean {
  const conv = activeConversation;
  if (!conv) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  try {
    conv.sendUserMessage(trimmed);
  } catch (e) {
    console.warn("[voice-eleven] sendUserMessage failed:", e);
    return false;
  }
  voiceAppend({ role: "user", content: trimmed });
  useStore.getState().setVoiceThinking(true);
  armThinkingSafetyTimeout();
  return true;
}

// Typed user turn with an attached image (marquee capture). Uploads
// the blob, then sends a multimodal_message — same path pushPdfIfNeeded
// uses for ambient PDFs, but here it's a user turn that expects a
// reply rather than silent context.
export async function sendVoiceUserMultimodal(
  text: string,
  imageDataUrl: string,
): Promise<boolean> {
  const conv = activeConversation;
  if (!conv) return false;
  const trimmed = text.trim();
  try {
    const res = await fetch(imageDataUrl);
    const blob = await res.blob();
    if (!activeConversation || activeConversation !== conv) return false;
    if (!blob.size) {
      // An attachment that arrived empty is said, never guessed at (P17).
      conv.sendUserMessage(`${trimmed ? `${trimmed}\n\n` : ""}[He attached an image, but it arrived empty (no data): you have NOT seen it. Say so; don't guess what it shows.]`);
      voiceAppend({ role: "user", content: trimmed || "[image — empty]" });
      return true;
    }
    const { fileId } = await conv.uploadFile(blob);
    if (!activeConversation || activeConversation !== conv) return false;
    sendFilesMessage(conv, trimmed || undefined, [fileId]);
  } catch (e) {
    console.warn("[voice-eleven] sendVoiceUserMultimodal failed:", e);
    return false;
  }
  const display = trimmed || "[image]";
  voiceAppend({ role: "user", content: display });
  useStore.getState().setVoiceThinking(true);
  armThinkingSafetyTimeout();
  return true;
}

/**
 * One frame of the voice waves' raw levels (0..1 per bar). Two sources, picked
 * per frame:
 *   • speaking → TTS output spectrum, or the chunk-derived playback envelope
 *     when the analyser reads dead (suspended AudioContext / buffer-up — the
 *     documented unreliable cases)
 *   • otherwise → live mic input (idle / listening / silent gaps)
 * While voiceSpeaking is on, the mic is NEVER the source: bars tracking the
 * user's ambient noise during the agent's turn is exactly the "wave out of sync
 * with the voice" desync (note 852e435b). No synthesized motion: a fake
 * "thinking" wave reads as ongoing audio after the user barges in. The chat
 * popout gets these from the main window (sync.ts), where voice runs.
 */
export function voiceBarLevels(n: number): number[] {
  const s = useStore.getState();
  // Nothing audible can play (voiceMic.ts audioBlocked), or the inbound audio stalled mid-reply (voiceStats.ts):
  // flat — never waves over silence (the composer says why).
  if (audioWarned || playback?.stalled) return new Array(n).fill(0);
  const out = s.voiceSpeaking ? getOutputLevels(n) : null;
  // Polled every speaking frame regardless of which source wins — polling
  // advances the envelope's playback cursor, so it stays in sync for the
  // frames where the analyser flakes out.
  const env = s.voiceSpeaking && nativePlayback() ? getAgentEnvelopeLevels(n) : null;
  const outActive = out !== null && out.reduce((a, b) => a + b, 0) > 0.05;
  // A muted mic is honestly silent, whatever the analyser still reads.
  return outActive && out ? out : env !== null ? env : s.voiceMicMuted ? new Array(n).fill(0) : getInputLevels(n);
}

export function getInputLevels(n: number): number[] {
  if (!activeConversation) return new Array(n).fill(0);
  try {
    return binFrequencyData(activeConversation.getInputByteFrequencyData(), n);
  } catch {
    return new Array(n).fill(0);
  }
}

export function getOutputLevels(n: number): number[] {
  if (!activeConversation) return new Array(n).fill(0);
  try {
    return binFrequencyData(activeConversation.getOutputByteFrequencyData(), n);
  } catch {
    return new Array(n).fill(0);
  }
}

function binFrequencyData(data: Uint8Array, n: number): number[] {
  const out: number[] = [];
  const binsPerBar = Math.max(1, Math.floor(data.length / n));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < binsPerBar; j++) {
      sum += data[i * binsPerBar + j] ?? 0;
    }
    out.push(sum / binsPerBar / 255);
  }
  return out;
}

// ---- The call's health (voiceHealth.ts), from the SDK's own meters ---------
//
// One sampler per live call reads the SDK's input and output levels; the
// detectors decide, this acts: a deaf or dead mic is re-acquired once through
// the SDK (changeInputDevice), then said in one plain line; audio arriving but
// not audible is logged and playback nudged (LiveKit's startAudio, a suspended
// context resumed); the first audible agent audio closes the turn's timing.
// Every step lands in the app log (vlog): the reports that prompted this had no
// trace of why a call went deaf or silent.
const health = new VoiceHealth((e) => onHealthEvent(e));
let healthTimer: ReturnType<typeof setInterval> | null = null;
let healthConv: ActiveConversation | null = null;
let healthCleanup: (() => void)[] = [];
let micRecoveries = 0;
/** The call's pinned mic (voiceMic.ts): the device listing is read when asked (tests install theirs late). */
const micPin = new MicPin({ list: listAudioDevices, log: (ev, data) => vlog(ev, data) });
/** The agent's output, pinned the same way: a Windows default/communications switch mid-call no longer moves it
 *  ("I stop hearing the voice, but the waves keep going": the waves are the SDK's level, whatever device plays it). */
const outPin = new MicPin({ list: listAudioDevices, log: (ev, data) => vlog(ev, data), kind: "audiooutput" });
/** The pinned output went away with nothing to move to: the waves would lie. */
let outputLost = false;
/** The inbound audio's stats while the agent speaks (voiceStats.ts): dropouts classified network/source/local. */
let playback: PlaybackMonitor | null = null;
function localPlayback(conv: ActiveConversation) {
  const { contexts } = sdkParts(conv);
  return { contexts: contexts.map((c) => c.state as string), outputDevice: outPin.pinned?.label ?? (nativePlayback() ? "native" : "system default"), outputLost };
}
export const MIC_UNHEARD_LINE = "vault-chat isn't receiving your microphone. Check the system's default input device.";

/** [best-effort, diagnostics] The SDK's live pieces it doesn't expose publicly:
 *  the LiveKit room (WebRTC), the mic track, the WebSocket path's audio contexts.
 *  Any of them may be missing; nothing depends on them but logs and nudges. */
function sdkParts(conv: ActiveConversation | null): { room: any; track: MediaStreamTrack | null; contexts: AudioContext[] } {
  const c = conv as any;
  const room = c?.connection?.getRoom?.() ?? null;
  let track: MediaStreamTrack | null = null;
  try {
    track = room?.localParticipant?.getTrackPublication?.("microphone")?.track?.mediaStreamTrack ?? c?.input?.inputStream?.getAudioTracks?.()[0] ?? null;
  } catch {
    track = null;
  }
  const contexts = [c?.input?.context, c?.output?.context].filter((x) => x && typeof x.state === "string");
  return { room, track, contexts };
}

/** The mic the SDK captures: its label and device id (logged at every start and switch). */
async function micInfo(conv: ActiveConversation | null): Promise<Record<string, unknown>> {
  const { track } = sdkParts(conv);
  if (!track) return { mic: null };
  const settings = (track.getSettings?.() ?? {}) as MediaTrackSettings;
  return {
    mic: track.label || null,
    micId: settings.deviceId ? String(settings.deviceId).slice(0, 12) : null,
    micState: track.readyState,
    echoCancellation: settings.echoCancellation,
  };
}

async function startHealthWatch(conv: ActiveConversation, transport: Transport): Promise<void> {
  stopHealthWatch();
  healthConv = conv;
  micRecoveries = 0;
  quietMicReacquired = false;
  health.connected(Date.now());
  vlog("voice mic", { transport, ...(await micInfo(conv)) });
  if (healthConv !== conv) return;
  // Opened on a virtual default (the device ids weren't readable before the mic was allowed): pinned now.
  {
    const { track } = sdkParts(conv);
    await micPin.afterConnect((track?.getSettings?.() ?? {}).deviceId, (id) => conv.changeInputDevice({ inputDeviceId: id }));
    if (healthConv !== conv) return;
    if (canPickOutput() && !nativePlayback()) await outPin.afterConnect(undefined, (id) => conv.changeOutputDevice({ outputDeviceId: id }));
    if (healthConv !== conv) return;
  }
  // Per call: the devices in use and every one listed (a "waves but silence" is matched to a switch by these).
  {
    const devs = (await micPin.devices()) ?? [];
    vlog("voice devices", { ...deviceLists(devs), mic: micPin.pinned?.label ?? null, outputDevice: localPlayback(conv).outputDevice, waves: "SDK output analyser (speaking), mic analyser (listening)" });
    if (healthConv !== conv) return;
  }
  playback = new PlaybackMonitor({
    stats: () => roomAudioStats(sdkParts(conv).room),
    speaking: () => useStore.getState().voiceSpeaking,
    local: () => localPlayback(conv),
    log: (ev, data) => vlog(ev, data),
  }).start();
  watchMicTrack(conv);
  // The output device or mic set changed (a headset plugged, a Bluetooth profile switch).
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (md?.addEventListener) {
    const onDevices = () => void devicesChanged(conv);
    md.addEventListener("devicechange", onDevices);
    healthCleanup.push(() => md.removeEventListener("devicechange", onDevices));
  }
  const { room, contexts } = sdkParts(conv);
  for (const ctx of contexts) {
    const onState = () => vlog("voice audio context", { state: ctx.state, rate: ctx.sampleRate });
    ctx.addEventListener?.("statechange", onState);
    healthCleanup.push(() => ctx.removeEventListener?.("statechange", onState));
  }
  if (room?.on) {
    // LiveKit's own events (string names: livekit-client RoomEvent).
    const events: [string, (...a: any[]) => void][] = [
      ["audioPlaybackChanged", () => vlog("voice playback allowed", { canPlay: room.canPlaybackAudio })],
      ["reconnecting", () => vlog("voice transport reconnecting", {})],
      ["reconnected", () => vlog("voice transport reconnected", {})],
      ["mediaDevicesError", (e: unknown) => vlog("voice media device error", { error: String((e as Error)?.message ?? e) })],
      ["connectionQualityChanged", (q: unknown, p: any) => p?.isLocal && q === "poor" && vlog("voice connection poor", {})],
    ];
    for (const [ev, fn] of events) {
      room.on(ev, fn);
      healthCleanup.push(() => room.off?.(ev, fn));
    }
  }
  healthTimer = setInterval(() => sampleHealth(conv), 100);
}

function stopHealthWatch(): void {
  if (audioWarned && useStore.getState().voiceNotice === AUDIO_WARN_LINE) useStore.setState({ voiceNotice: null });
  audioWarned = null;
  outputLost = false;
  playback?.stop();
  playback = null;
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  for (const f of healthCleanup.splice(0)) {
    try {
      f();
    } catch {
      /* already gone */
    }
  }
  healthConv = null;
}

const watchedTracks = new WeakSet<MediaStreamTrack>();
function watchMicTrack(conv: ActiveConversation): void {
  const { track } = sdkParts(conv);
  if (!track?.addEventListener || watchedTracks.has(track)) return;
  watchedTracks.add(track);
  const onEnded = () => {
    if (healthConv !== conv) return;
    vlog("voice mic ended", { mic: track.label || null });
    void recoverMic(conv, "the microphone track ended");
  };
  track.addEventListener("ended", onEnded);
  healthCleanup.push(() => {
    track.removeEventListener("ended", onEnded);
    watchedTracks.delete(track);
  });
}

async function devicesChanged(conv: ActiveConversation): Promise<void> {
  if (healthConv !== conv) return;
  const { track, contexts } = sdkParts(conv);
  const id = (track?.getSettings?.() ?? {}).deviceId;
  const listed = await micPin.devices();
  const devs: MicDevice[] = listed ?? [];
  // Every change, with both lists, both pins and what the waves are drawing: a "waves but silence" in the log
  // lines up with the switch that caused it.
  let levels: Record<string, unknown> = {};
  try {
    levels = { inputLevel: +conv.getInputVolume().toFixed(3), outputLevel: +conv.getOutputVolume().toFixed(3), waves: useStore.getState().voiceSpeaking ? "output" : "input" };
  } catch {
    /* closed */
  }
  vlog("voice devices changed", {
    ...deviceLists(devs),
    mic: micPin.pinned?.label ?? null,
    micStillThere: micPin.pinned ? micPin.present(devs) : listed ? !id || devs.some((d) => (d.kind ?? "audioinput") === "audioinput" && d.deviceId === id) : null,
    micState: track?.readyState ?? null,
    outputDevice: outPin.pinned?.label ?? null,
    outputStillThere: outPin.pinned ? outPin.present(devs) : null,
    contexts: contexts.map((c) => c.state),
    ...levels,
  });
  if (!listed) return;
  // Pinned: Windows moving its default/communications endpoints changes nothing; the pinned device unplugged
  // moves the call to the best remaining one, the call going on.
  const outOutcome = await outPin.devicesChanged(devs, (to) => conv.changeOutputDevice({ outputDeviceId: to }));
  outputLost = outOutcome === "lost" || outOutcome === "failed";
  if (healthConv !== conv) return;
  const outcome = await micPin.devicesChanged(devs, async (to) => {
    await conv.changeInputDevice({ inputDeviceId: to });
    if (healthConv === conv) {
      health.micReset(Date.now());
      watchMicTrack(conv);
    }
  });
  if (healthConv !== conv) return;
  if (outcome === "kept" || outcome === "switched") return;
  if (outcome === "failed" || outcome === "lost") return void (await recoverMic(conv, "the microphone went away"));
  // Unpinned (no virtual default here: the system routes its inputs itself): the track's device must still be listed.
  const stillThere = !id || devs.some((d) => (d.kind ?? "audioinput") === "audioinput" && d.deviceId === id);
  if (track?.readyState === "ended" || !stillThere) await recoverMic(conv, "the microphone went away");
}

/** The waves would lie (the agent speaking into a suspended context, a blocked page, a vanished output): the
 *  composer says so instead ("No sound? Tap to reconnect audio"); cleared as soon as it can play again. */
let audioWarned: string | null = null;
function checkAudio(conv: ActiveConversation, speaking: boolean): void {
  const { room, contexts } = sdkParts(conv);
  const why = audioBlocked({ speaking, contexts: contexts.map((c) => c.state as string), canPlay: room ? room.canPlaybackAudio : null, outputLost });
  if (why === audioWarned) return;
  if (why) {
    vlog("voice audio blocked", { why, contexts: contexts.map((c) => c.state), canPlay: room ? room.canPlaybackAudio : null, outputDevice: outPin.pinned?.label ?? null });
    useStore.setState({ voiceNotice: AUDIO_WARN_LINE });
  } else {
    vlog("voice audio unblocked", { was: audioWarned });
    if (useStore.getState().voiceNotice === AUDIO_WARN_LINE) useStore.setState({ voiceNotice: null });
  }
  audioWarned = why;
}

/** "No sound? Tap to reconnect audio": playback resumed the SDK's own ways, the output re-set on its pinned device. */
export async function reconnectVoiceAudio(): Promise<void> {
  const conv = activeConversation;
  if (!conv) return;
  const { room, contexts } = sdkParts(conv);
  vlog("voice audio reconnect", { contexts: contexts.map((c) => c.state), canPlay: room ? room.canPlaybackAudio : null });
  await room?.startAudio?.().catch(() => undefined);
  for (const c of contexts) if (c.state !== "running" && c.state !== "closed") await c.resume().catch(() => undefined);
  if (outPin.pinned || outputLost) {
    try {
      const to = await outPin.target();
      await conv.changeOutputDevice({ outputDeviceId: to });
      outputLost = false;
    } catch (e) {
      vlog("voice output switch failed", { error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  if (activeConversation === conv) checkAudio(conv, useStore.getState().voiceSpeaking);
}

/** [tests] The playback monitor of the live call. */
export function voicePlaybackForTests(): PlaybackMonitor | null {
  return playback;
}

/** Carl is talking now (his mic over speech level, not muted), or the voice is working out its reply to his line. */
function carlSpeaking(conv: ActiveConversation): boolean {
  const st = useStore.getState();
  if (st.voiceThinking) return true;
  if (st.voiceMicMuted) return false;
  try {
    return conv.getInputVolume() >= SPEECH_LEVEL;
  } catch {
    return false;
  }
}

/** A mic that only reads zero: re-acquired once a call, quietly. Zero is also what a silent room reads under
 *  noise suppression — Carl writing or thinking — so it is never said to him and never uses up the
 *  re-acquire a real loss (the track ending, speech with no transcript) gets. */
let quietMicReacquired = false;
async function reacquireQuietly(conv: ActiveConversation, why: string): Promise<void> {
  if (healthConv !== conv || activeConversation !== conv || quietMicReacquired) return;
  quietMicReacquired = true;
  try {
    await conv.changeInputDevice({ inputDeviceId: await micPin.target() });
    if (healthConv !== conv) return;
    watchMicTrack(conv);
    vlog("voice mic reacquired", { why, quiet: true, ...(await micInfo(conv)) });
  } catch (e) {
    vlog("voice mic reacquire failed", { why, quiet: true, error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
}

/** Re-acquire the mic once through the SDK (the pinned device); a second failure in the call is said plainly. */
async function recoverMic(conv: ActiveConversation, why: string): Promise<void> {
  if (healthConv !== conv || activeConversation !== conv) return;
  micRecoveries++;
  if (micRecoveries === 1) {
    try {
      // The same pinned device (its replacement if it went away); "default" when nothing is pinned.
      await conv.changeInputDevice({ inputDeviceId: await micPin.target() });
      if (healthConv !== conv) return;
      health.micReset(Date.now());
      watchMicTrack(conv);
      vlog("voice mic reacquired", { why, ...(await micInfo(conv)) });
      return;
    } catch (e) {
      vlog("voice mic reacquire failed", { why, error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  if (micRecoveries <= 2) {
    console.error("[voice-eleven] microphone not reaching ElevenLabs:", why);
    voiceAppend({ role: "assistant", content: MIC_UNHEARD_LINE, system: true });
  }
}

function sampleHealth(conv: ActiveConversation): void {
  if (healthConv !== conv || activeConversation !== conv) return;
  const now = Date.now();
  let input = 0;
  let output = 0;
  try {
    input = conv.getInputVolume();
    output = conv.getOutputVolume();
  } catch {
    return;
  }
  const st = useStore.getState();
  const { room, track } = sdkParts(conv);
  health.sample({
    now,
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
    muted: st.voiceMicMuted,
    speaking: st.voiceSpeaking,
    // A live track reading zero is a quiet room (Carl working), not a dead mic.
    trackLive: track ? track.readyState === "live" && track.muted !== true : undefined,
    playbackBlocked: room ? room.canPlaybackAudio === false : false,
  });
  checkAudio(conv, st.voiceSpeaking);
  logTurn(turnStats.noAudio(now));
}

function onHealthEvent(e: HealthEvent): void {
  const conv = healthConv;
  switch (e.kind) {
    case "first-audio":
      logTurn(turnStats.audioPlaying(e.at));
      return;
    case "mic-dead":
      vlog("voice mic silent", { ms: e.ms, transport: activeTransport });
      if (conv) void micInfo(conv).then((m) => vlog("voice mic", m)).finally(() => reacquireQuietly(conv, "the microphone reads silent"));
      return;
    case "mic-unheard":
      vlog("voice mic unheard", { speechMs: e.speechMs, waitedMs: e.waitedMs, transport: activeTransport });
      if (conv) void recoverMic(conv, "speech the meter saw got no transcript");
      return;
    case "silent-playback": {
      const { room, contexts } = sdkParts(conv);
      vlog("voice silent playback", {
        ms: e.ms,
        transport: activeTransport,
        canPlay: room ? room.canPlaybackAudio : null,
        contexts: contexts.map((c) => c.state),
      });
      // Nudge playback the SDK's own way: LiveKit's startAudio, a suspended context resumed.
      void room?.startAudio?.().catch(() => undefined);
      for (const c of contexts) if (c.state === "suspended") void c.resume().catch(() => undefined);
      return;
    }
    case "playback-resumed":
      vlog("voice playback resumed", { silentMs: e.silentMs });
      return;
  }
}

/** [tests] Feed one health sample now (the sampler's 100 ms tick). */
export function sampleVoiceHealthForTests(): void {
  if (activeConversation) sampleHealth(activeConversation);
}

// ---- Agent-audio playback envelope (visualizer) ---------------------------
//
// getOutputByteFrequencyData is the natural source for the speaking bars, but
// it's unreliable: the SDK's analyser sits post-gain on an AudioContext that
// can stay suspended (webviews) or read silent through the buffer-up phase —
// the same trap waitForSpeechEnd documents above. When it read dead while
// `voiceSpeaking` said audio WAS playing, the cockpit fell back to the MIC
// spectrum — bars tracking the user's ambient noise during the agent's turn is
// exactly the "wave out of sync with the voice" report (note 852e435b).
//
// This envelope is the honest replacement: onAudio hands us the real PCM the
// agent plays (16 kHz mono s16le, per the native-playback path at the top of
// this file), we slice it into per-50ms RMS levels, and replay the queue at
// wall-clock rate while the SDK's playback window (`voiceSpeaking`) is open.
// The crucial subtlety: chunks ARRIVE much faster than real time (the platform
// streams a whole turn into the client buffer in a burst), so the queue runs
// ahead of the ear — the cursor, advanced by elapsed time, is what stays in
// sync with what's audible. When mode flips back to "listening" the worklet
// buffer has drained, i.e. everything that arrived has been heard — the reset
// there drops any stale cursor lag so it can't animate silence.
const ENVELOPE_SLICE_MS = 50;
const ENVELOPE_SLICE_BYTES = (16_000 * 2 * ENVELOPE_SLICE_MS) / 1000;
let agentEnvelope: number[] = [];
let agentEnvelopePos = 0; // playback cursor, in (fractional) slices
let agentEnvelopeClock = 0; // last poll timestamp; 0 = cursor parked

function resetAgentEnvelope(): void {
  agentEnvelope = [];
  agentEnvelopePos = 0;
  agentEnvelopeClock = 0;
}

// Slice a base64 PCM16 chunk into per-ENVELOPE_SLICE_MS RMS levels (0..1) and
// queue them. If the payload ever isn't PCM16 the numbers are still
// energy-correlated, so the bars degrade gracefully rather than freeze.
function pushAgentEnvelope(audioBase64: string): void {
  const s = atob(audioBase64);
  for (let off = 0; off + 1 < s.length; off += ENVELOPE_SLICE_BYTES) {
    const end = Math.min(s.length, off + ENVELOPE_SLICE_BYTES);
    let sum = 0;
    let count = 0;
    // Every 2nd sample — plenty of resolution for a loudness meter.
    for (let i = off; i + 1 < end; i += 4) {
      let v = s.charCodeAt(i) | (s.charCodeAt(i + 1) << 8);
      if (v >= 32768) v -= 65536;
      sum += v * v;
      count++;
    }
    const rms = count ? Math.sqrt(sum / count) / 32768 : 0;
    // ×4 gain matches speech RMS (~0.1-0.2 of full scale) to the 0..1 bars.
    agentEnvelope.push(Math.min(1, rms * 4));
  }
  // Compact the consumed prefix so a long monologue can't grow the queue.
  const consumed = Math.floor(agentEnvelopePos);
  if (consumed > 400) {
    agentEnvelope.splice(0, consumed);
    agentEnvelopePos -= consumed;
  }
}

// Level of the slice that is audibly playing right now. Advances the cursor by
// wall-clock time between polls; holds the last slice if the cursor briefly
// outruns arrival (network stall — mode flips to listening right after anyway).
function agentEnvelopeLevel(): number {
  const now = performance.now();
  // Clamp a big gap (first poll of a turn, tab was throttled) to one slice so
  // the cursor can't leap past audio that hasn't played.
  const dt = agentEnvelopeClock ? Math.min(now - agentEnvelopeClock, 200) : 0;
  agentEnvelopeClock = now;
  agentEnvelopePos += dt / ENVELOPE_SLICE_MS;
  if (agentEnvelope.length === 0) return 0;
  return agentEnvelope[Math.min(agentEnvelope.length - 1, Math.floor(agentEnvelopePos))];
}

// Envelope shaped into a centre hump so the scalar level reads like a spectrum
// next to the analyser-driven bars it substitutes for. Poll once per frame
// while `voiceSpeaking` — polling is what advances the playback cursor.
export function getAgentEnvelopeLevels(n: number): number[] {
  const lvl = agentEnvelopeLevel();
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const shape = 0.55 + 0.45 * Math.sin((i / (n - 1)) * Math.PI);
    out.push(lvl * shape);
  }
  return out;
}


// Built-in default for the personality / speech-rules header.
/**
 * The box's voice agent for `device` (one per vault and device: each device's own tools, src/voicePrompt.ts
 * voiceToolDefs), provisioned with the box's ElevenLabs key; null when voice can't run yet (no key, or the agent
 * couldn't be provisioned: getLastAgentCreateError says why). The key itself never leaves the box.
 */
export async function voiceAgent(o: { device: VoiceDevice; slot: string }): Promise<{ elKey: string; agentId: string; voiceId: string } | null> {
  const elKey = useStore.getState().serviceKeys.elevenlabs;
  if (!elKey) return null;
  const agentId = await ensureAgent(elKey, { slot: o.slot, tools: voiceToolDefs(o.device) });
  if (!agentId) return null;
  return { elKey, agentId, voiceId: localStorage.getItem(VOICE_ID_STORAGE) ?? DEFAULT_VOICE_ID };
}

function buildDynamicVariables(
  state: ReturnType<typeof useStore.getState>,
): Record<string, string> {
  return {
    viewport_context: buildViewportContextText(state) || "(no document open)",
  };
}

export function buildViewportContextText(
  state: ReturnType<typeof useStore.getState>,
): string {
  if (!state.followAlong) return "";
  const activeFile = state.currentFile;
  if (!activeFile) return "";

  const sections: string[] = [activeSectionFor(state, activeFile)];

  // Split view: the layout first, in Show's names (left / right pane;
  // src/paneLayout.ts), then the OTHER pane too so the agent knows both
  // files are visible. Marked OTHER vs ACTIVE so it can pick the right
  // one when the user says "this" or "that one".
  if (state.panes.length > 0) {
    sections.unshift(`${layoutLine(state, state.vaultPath)} (Show's pane: "left" / "right" puts a file in one)`);
    for (const pane of state.panes) {
      if (pane.id === state.activePaneId) continue;
      const content = (pane.content ?? "").trim();
      const otherCap = 2000;
      const side = sideOf(state, pane.id);
      const label = `OTHER pane${side ? ` (${side})` : ""} document`;
      sections.push(
        content
          ? `${label}: ${pane.file}\nContent:\n${truncate(content, otherCap)}`
          : `${label}: ${pane.file} (no text content)`,
      );
    }
  }

  return sections.join("\n\n---\n\n");
}

function activeSectionFor(
  state: ReturnType<typeof useStore.getState>,
  activeFile: string,
): string {
  const v: Viewport | null = state.viewport;
  if (v && v.path === activeFile) {
    if (v.page !== undefined && v.pageText) {
      const total = v.totalPages ?? "?";
      return `>>> USER IS CURRENTLY ON PAGE ${v.page} of ${total} of ${activeFile} <<<\nAny ambiguous reference ("this", "that", "this math", "what does this say") refers to PAGE ${v.page}, not other pages.\nPage ${v.page} text content:\n${truncate(v.pageText, VIEWPORT_TEXT_CAP)}`;
    }
    if (v.visibleText) {
      const pct =
        v.scrollRatio !== undefined ? Math.round(v.scrollRatio * 100) : null;
      const loc = pct !== null ? ` (scrolled ~${pct}%)` : "";
      return `>>> USER IS CURRENTLY VIEWING ${activeFile}${loc} <<<\nAny ambiguous reference refers to the visible portion below, not other parts of the document.\nVisible content:\n${truncate(v.visibleText, VIEWPORT_TEXT_CAP)}`;
    }
  }
  const fallback = (state.currentContent ?? "").trim();
  if (!fallback) {
    return `>>> USER IS CURRENTLY VIEWING ${activeFile} <<< (no text content available; call Read for contents)`;
  }
  return `>>> USER IS CURRENTLY VIEWING ${activeFile} <<<\nContent:\n${truncate(fallback, VIEWPORT_TEXT_CAP)}`;
}

function truncate(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

// ---- Agent provisioning ---------------------------------------------------

let lastAgentCreateError: { status: number; body: string } | null = null;

export function getLastAgentCreateError(): { status: number; body: string } | null {
  return lastAgentCreateError;
}

// Circuit breaker for non-transient agent-create failures. A 422 (bad payload —
// e.g. a voice/LLM/tool-schema the platform rejects) will fail identically
// forever; the phone host's 20s heartbeat would otherwise re-POST it ~3/min
// indefinitely (the observed 965 calls / 5h with no user signal). After
// AGENT_CREATE_MAX_4XX consecutive non-transient 4xx failures we trip the
// breaker: ensureAgent returns null without hitting the network until a
// user-initiated path calls resetAgentCreateBreaker(). 408/429 are transient
// (timeout / rate-limit) and DON'T count — they may clear on their own.
const AGENT_CREATE_MAX_4XX = 3;
let agentCreate4xxStreak = 0;
let agentCreateBreakerTripped = false;
export function resetAgentCreateBreaker(): void {
  agentCreate4xxStreak = 0;
  agentCreateBreakerTripped = false;
}
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429;
}

// One provisioned agent per slot: the box keeps one per vault and device (each
// device's own tools), so switching never re-creates an agent.
const slotKey = (name: string, slot?: string) => (slot ? `${name}:${slot}` : name);

/** Filler the agent says while a slow model is still thinking (soft timeout): short and neutral. */
export const SOFT_TIMEOUT_MESSAGE = "One sec.";
/** Seconds of silence before ElevenLabs re-engages the agent (turn.turn_timeout). Its docs allow 1–30 and
 *  document no "off" (-1 is documented only for the soft timeout and the end-after-silence timer), so the
 *  longest: and the one re-engage that can still come is answered with skip_turn (the prompt's silence rule),
 *  after which the agent stays silent until Carl speaks (SKIP_TURN_WAIT_SECS). */
export const TURN_TIMEOUT_SECONDS = 30;
/** skip_turn's wait_timeout_secs: -1 = after skip_turn the agent stays silent until the caller speaks (no
 *  "contextual check-in" later). ElevenLabs' SkipTurnToolConfig; the default, set so it never drifts. */
export const SKIP_TURN_WAIT_SECS = -1;
/** Back-channel words that never interrupt the agent ("yeah" while it talks is listening, not a new turn). */
export const INTERRUPTION_IGNORE_TERMS = ["yeah", "yep", "mm", "mhm", "mm-hm", "uh-huh", "ok", "okay", "right", "sure"];
/** When the chosen model is down: Claude Haiku, then a small GPT (ElevenLabs' default chain starts with Gemini). */
export const BACKUP_LLMS = ["claude-haiku-4-5", "gpt-4.1-mini"];
/** Seconds each model in the cascade gets before the next one is tried (ElevenLabs: 2–15, default 4).
 *  At the default 4 s a turn whose answer was a tool call with a long argument (rewrite
 *  a note) missed it on every model, and ElevenLabs closed the call ("LLM Cascade
 *  Error: TimeoutError", 1002). Voice's one acting tool now takes a sentence (Ask),
 *  and returns at once; the soft-timeout filler covers a slow model from 3 s. */
export const CASCADE_TIMEOUT_SECONDS = 15;
/** Files (images, PDFs) kept whole in the model's context; older ones are summarised and freed. */
export const FILES_IN_MEMORY = 4;

/** The agent ElevenLabs creates for vault-chat (POST /v1/convai/agents/create).
 *  `info` is the model's row in ElevenLabs' list (what it can take, its reasoning). */
export function buildAgentCreateBody(o: {
  llm: string;
  info: VoiceLlmInfo | null;
  /** The device's tools (src/voicePrompt.ts voiceToolDefs). */
  tools: VoiceToolDef[];
  voiceId: string;
}): Record<string, unknown> {
  const effort = reasoningEffortFor(o.info);
  return {
    name: AGENT_NAME,
    conversation_config: {
      agent: {
        first_message: "",
        language: "en",
        prompt: {
          prompt: "(per-session override)",
          llm: o.llm,
          // Even and factual, not performative (Carl: the voice was sycophantic).
          temperature: 0.4,
          // A spoken reply wants no thinking: "none" when the model offers it, else its lowest.
          ...(effort ? { reasoning_effort: effort } : {}),
          backup_llm_config: { preference: "override", order: BACKUP_LLMS },
          cascade_timeout_seconds: CASCADE_TIMEOUT_SECONDS,
          tools: [
            ...o.tools.map((t) => ({
              type: "client" as const,
              name: t.name,
              description: t.description,
              parameters: t.parameters,
              // CRITICAL: defaults to false — without it the agent never sees the tool's result.
              expects_response: true,
              response_timeout_secs: 30,
            })),
            // NB: end_call is intentionally omitted (it hung up on long study
            // silences). skip_turn is the answer to the 30 s re-engage: the agent
            // has a concrete "nothing to add" action instead of filler, and with
            // wait_timeout_secs -1 it then stays silent until Carl speaks.
            { type: "system" as const, name: "skip_turn", description: "", params: { system_tool_type: "skip_turn", wait_timeout_secs: SKIP_TURN_WAIT_SECS } },
          ],
        },
      },
      // A natural, low-latency voice, NOT the expressive mode: expressive_mode
      // (on by default) makes the model write "[excited]"-style audio tags and
      // perform emotions. src/voiceTags.ts still strips any from the transcript.
      tts: {
        // English agents must use flash or turbo v2 (ElevenLabs refuses v2_5 with a 400).
        model_id: "eleven_flash_v2",
        expressive_mode: false,
        voice_id: o.voiceId,
        // The guard behind the prompt's "math in words" rule (Carl: "horrible at reading LaTeX and math"):
        // ElevenLabs normalises what the model still writes in symbols (x², ≤, 3.5 mV) after the model and
        // before speech; the transcript keeps the model's text. ("system_prompt", the default, only asks the
        // model to spell things out.) The box sends the agent's results already in words (server/speakMath.ts).
        text_normalisation_type: "elevenlabs",
      },
      // Two hours (the 10-minute default hung up mid-explanation). Silence never hangs up: turn.silence_end_call_timeout.
      conversation: {
        max_duration_seconds: 7200,
        // Uploads (PDFs, images) reach the model only with file input on.
        // Only the newest few stay whole in context (a look's images are one stacked picture).
        file_input: { enabled: true, max_files_in_memory: FILES_IN_MEMORY, max_files_per_conversation: 40 },
      },
      turn: {
        // Silence before ElevenLabs re-engages the agent (the documented max; skip_turn answers it, silently).
        turn_timeout: TURN_TIMEOUT_SECONDS,
        // Never end the call on silence (-1). This lives in `turn` (ElevenLabs' TurnConfig); under
        // `conversation`, where v29 had it, it is not a field.
        silence_end_call_timeout: -1,
        turn_model: "turn_v3",
        // Wait for the user to finish (study talk has pauses); back-channel words don't interrupt.
        turn_eagerness: "patient",
        interruption_ignore_terms: INTERRUPTION_IGNORE_TERMS,
        merge_with_default_ignore_terms: true,
        // Start the reply while the end of the turn is being confirmed (lower latency).
        speculative_turn: true,
        // No platform filler (Carl, 2026-10-21: "a lot of 'one sec', 'one sec' and 'on it'"): a slow reply is
        // silence until there is something to say. -1 is the API's "disabled" (SoftTimeoutConfig.timeout_seconds),
        // set explicitly so a re-provisioned agent loses the old 3 s filler too.
        soft_timeout_config: { timeout_seconds: -1 },
      },
      // Another voice in the room (a video, someone nearby) is not the user barging in.
      vad: { background_voice_detection: true },
      asr: { provider: "scribe_realtime" },
    },
    // Per-session overrides must be enabled here or they are silently ignored.
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: { prompt: { prompt: true }, first_message: true, language: true },
          tts: { voice_id: true },
        },
      },
    },
  };
}

async function ensureAgent(apiKey: string, opts: { slot: string; tools: VoiceToolDef[] }): Promise<string | null> {
  const AGENT_ID_STORAGE = slotKey(AGENT_ID_KEY, opts.slot);
  const AGENT_LLM_AT_PROVISION = slotKey(AGENT_LLM_KEY, opts.slot);
  const AGENT_VERSION_STORAGE = slotKey(AGENT_VERSION_KEY, opts.slot);
  const AGENT_VOICE_STORAGE = slotKey(AGENT_VOICE_KEY, opts.slot);
  const wantedVoice = localStorage.getItem(VOICE_ID_STORAGE) ?? DEFAULT_VOICE_ID;
  const cached = localStorage.getItem(AGENT_ID_STORAGE);
  const provisionedWith = localStorage.getItem(AGENT_LLM_AT_PROVISION);
  const provisionedVersion = localStorage.getItem(AGENT_VERSION_STORAGE);
  const wantedLlm = getCurrentLlm();
  // Re-provision if the LLM choice or the agent-config schema (its tools among it: AGENT_CONFIG_VERSION) changed
  // since this agent was created. (ElevenLabs caches these at agent level, so a change needs a fresh agent.)
  const stale = cached && (provisionedWith !== wantedLlm || provisionedVersion !== AGENT_CONFIG_VERSION);
  if (cached && !stale) {
    if (localStorage.getItem(AGENT_VOICE_STORAGE) === wantedVoice) return cached;
    // Another voice was picked: make it the agent's own.
    const r = await setAgentVoice(apiKey, cached, wantedVoice);
    if (r.ok) {
      localStorage.setItem(AGENT_VOICE_STORAGE, wantedVoice);
      return cached;
    }
    if (r.status === 404) localStorage.removeItem(AGENT_ID_STORAGE); // gone: a fresh agent below
    else if (r.status >= 400 && r.status < 500 && !isTransientStatus(r.status)) {
      // ElevenLabs refuses this voice for this agent: say so; never start with another voice silently.
      lastAgentCreateError = { status: r.status, body: `voice ${wantedVoice}: ${r.body}` };
      console.error("[voice-eleven] the agent's voice was refused:", wantedVoice, r.status, r.body);
      return null;
    } else {
      // Unreachable or a server error: the session's override still carries the voice.
      console.warn("[voice-eleven] couldn't set the agent's voice (the session override carries it):", r.status, r.body);
      return cached;
    }
  }
  // Breaker is open: a recent payload kept failing non-transiently. Don't
  // re-POST the same body. lastAgentCreateError is preserved so a user-facing
  // path can describe it.
  if (agentCreateBreakerTripped) return null;
  if (stale) {
    localStorage.removeItem(AGENT_ID_STORAGE);
  }
  // What ElevenLabs says this model takes (images, documents) and how it reasons.
  const llmList = await voiceLlmList(apiKey);
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/convai/agents/create", {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildAgentCreateBody({ llm: wantedLlm, info: llmInfo(llmList, wantedLlm), tools: opts.tools, voiceId: wantedVoice })),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[voice-eleven] agent create failed:", res.status, body);
      lastAgentCreateError = { status: res.status, body };
      // Count only non-transient 4xx (bad payload). 408/429 are transient and
      // left alone so a flaky window self-heals; 5xx is a server problem we let
      // the heartbeat keep probing — it's not a permanently-bad request.
      if (res.status >= 400 && res.status < 500 && !isTransientStatus(res.status)) {
        agentCreate4xxStreak += 1;
        if (agentCreate4xxStreak >= AGENT_CREATE_MAX_4XX) {
          agentCreateBreakerTripped = true;
          console.warn(
            "[voice-eleven] agent-create breaker tripped after",
            agentCreate4xxStreak,
            "non-transient 4xx",
          );
        }
      }
      return null;
    }
    const json = (await res.json()) as { agent_id?: string };
    if (!json.agent_id) {
      console.error("[voice-eleven] agent create returned no agent_id:", json);
      lastAgentCreateError = { status: 0, body: JSON.stringify(json) };
      return null;
    }
    lastAgentCreateError = null;
    agentCreate4xxStreak = 0;
    agentCreateBreakerTripped = false;
    localStorage.setItem(AGENT_ID_STORAGE, json.agent_id);
    localStorage.setItem(AGENT_LLM_AT_PROVISION, wantedLlm);
    localStorage.setItem(AGENT_VERSION_STORAGE, AGENT_CONFIG_VERSION);
    localStorage.setItem(AGENT_VOICE_STORAGE, wantedVoice);
    return json.agent_id;
  } catch (e) {
    console.error("[voice-eleven] agent create exception:", e);
    lastAgentCreateError = { status: 0, body: (e as any)?.message ?? String(e) };
    return null;
  }
}

/** PATCH the provisioned agent's voice (conversation_config.tts.voice_id). */
async function setAgentVoice(apiKey: string, agentId: string, voiceId: string): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_config: { tts: { voice_id: voiceId } } }),
    });
    return { ok: res.ok, status: res.status, body: res.ok ? "" : await res.text().catch(() => "") };
  } catch (e) {
    return { ok: false, status: 0, body: (e as Error)?.message ?? String(e) };
  }
}

export async function getSignedUrl(apiKey: string, agentId: string, slot?: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`,
      {
        headers: { "xi-api-key": apiKey },
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[voice-eleven] signed url failed:", res.status, body);
      // Stale cached agent ID → clear it so the next start re-creates.
      if (res.status === 404 || res.status === 403) {
        localStorage.removeItem(slotKey(AGENT_ID_KEY, slot));
      }
      return null;
    }
    const json = (await res.json()) as { signed_url?: string };
    return json.signed_url ?? null;
  } catch (e) {
    console.error("[voice-eleven] signed url exception:", e);
    return null;
  }
}

/** A WebRTC conversation token for the agent (ElevenLabs' recommended transport:
 *  built-in echo cancellation, jitter buffer, noise suppression). Minted with the
 *  key exactly as the signed URL is; null when ElevenLabs refuses. */
export async function getConversationToken(apiKey: string, agentId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`, {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) {
      console.error("[voice-eleven] conversation token failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const json = (await res.json()) as { token?: string };
    return typeof json.token === "string" && json.token ? json.token : null;
  } catch (e) {
    console.error("[voice-eleven] conversation token exception:", e);
    return null;
  }
}


// ---- Client tool implementations ----------------------------------------

// Format a path relative to the active vault, or fall back to the
// basename when the path lives outside the vault root. Keeps tool
// markers readable instead of dumping absolute Windows paths.
function relPath(path: string): string {
  if (!path) return "";
  const norm = (p: string) => p.replace(/\\/g, "/");
  const p = norm(path).replace(/\/+$/, "");
  const vault = useStore.getState().vaultPath;
  if (vault) {
    const v = norm(vault).replace(/\/+$/, "");
    if (p === v) return ".";
    if (p.startsWith(v + "/")) return p.slice(v.length + 1);
  }
  const tail = p.split("/").pop();
  return tail || path;
}

// Render a one-line marker per tool — verb + target only, no JSON
// args, no result. Reads like a journal entry in the chat pane. No
// asterisks: ChatPane already wraps system messages in an italic
// span, so literal `*` would just render as text. Full result still
// goes to console.log for debugging.
function formatToolMarker(name: string, args: any): string {
  switch (name) {
    case "ScrollTo": {
      const where = typeof args.page === "number" ? `page ${args.page}` : (args.anchor ?? "?");
      return `Scrolled to ${where}`;
    }
    case "ShowFile":
      return `Showed ${relPath(args.path ?? "")}`;
    case "LookAtScreen":
      return "Looked at the screen";
    case "Ask": {
      const req = String(args.request ?? "").trim().replace(/\s+/g, " ");
      return `Working on: "${req.length > 70 ? req.slice(0, 67) + "…" : req}"`;
    }
    default:
      return name;
  }
}

function logToolCall(name: string, args: any, result: string, where = ""): void {
  // Names and sizes only (the app log captures this line): never the arguments' or the result's text.
  const path = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : null;
  console.log(`[voice-eleven] tool ${name}(${Object.keys(args ?? {}).join(",")}${path ? ` path=${path}` : ""}) → ${result.length} chars${/^error/i.test(result) ? " (error)" : ""}${where}`);
  // Ask is the agent's turn in this conversation (its own item there): only a screen tool's call is a row of the call's.
  if (name === "Ask") return;
  // Shown as a tool row, like the text agent's calls (name, input, result).
  voiceAppend({
    role: "assistant",
    content: formatToolMarker(name, args) + where,
    system: true,
    toolCalls: [{ name, input: args ?? {}, result: result.length > 4000 ? result.slice(0, 4000) + "…" : result }],
  });
}

// Wraps a tool handler so the cockpit knows what's running. Sets
// voiceCurrentTool before the impl fires and clears it after, so
// the titlebar pill can show "Running ToolName…" while the work
// happens. Always logs to chat regardless of success/failure.
function safeLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

function withTracking<A>(
  name: string,
  impl: (args: A) => Promise<string>,
  // Shown after the marker: where the tool ran when it was not here (" · on the box").
  where = "",
): (args: A) => Promise<string> {
  return async (args: A) => {
    useStore.getState().setVoiceCurrentTool(name);
    logTurn(turnStats.firstResponse(`tool:${name}`, Date.now(), safeLen(args)));
    let result: string;
    try {
      result = await impl(args);
    } finally {
      useStore.getState().setVoiceCurrentTool(null);
    }
    turnStats.toolResult(name, result.length);
    turnStats.images = imagePusher.uploaded;
    logToolCall(name, args, result, where);
    return result;
  };
}

export function buildClientToolHandlers(
  remote: RemoteVoiceTool,
  remoteNames: string[] = ["Ask"],
  // Resolves once the call's lines so far are saved on the box: a request then reaches the agent after Carl's words.
  linesSaved: () => Promise<unknown> | undefined = () => undefined,
): Record<
  string,
  (parameters: any) => Promise<string>
> {
  // The tools that read or move this screen run here; Ask (a request to the conversation's agent) runs on the box.
  const handlers: Record<string, (parameters: any) => Promise<string>> = {
    ScrollTo: withTracking(
      "ScrollTo",
      async (args: { page?: number; anchor?: string; path?: string }) => {
        const state = useStore.getState();
        // A vault-relative path (the box's tools answer with those) is joined to this vault.
        if (args.path && boxVaultRoot && state.vaultPath && args.path.startsWith(boxVaultRoot)) {
          args = { ...args, path: args.path.slice(boxVaultRoot.length).replace(/^[\\/]+/, "") };
        }
        const rel = args.path && !/^([a-z]:[\\/]|[\\/])/i.test(args.path) && state.vaultPath;
        const targetPath = rel ? `${state.vaultPath!.replace(/[\\/]+$/, "")}/${args.path}` : (args.path ?? state.currentFile);
        if (!targetPath) return "Error: no file is currently open.";
        let anchor: string;
        if (typeof args.page === "number" && Number.isFinite(args.page)) {
          anchor = `page=${Math.max(1, Math.floor(args.page))}`;
        } else if (args.anchor && args.anchor.trim().length > 0) {
          anchor = args.anchor.trim();
        } else {
          return "Error: must provide either `page` (for PDFs) or `anchor` (for other file types).";
        }
        // Coalesce: if the agent emits multiple ScrollTo calls before
        // audio drains (common pattern — it "previews" the tour by
        // firing ScrollTo for every page it plans to mention), they'd
        // each wait for end-of-speech and then fire serially, marching
        // the viewport past the narration. Instead, only the LATEST
        // target wins. Earlier calls return immediately with a
        // superseded marker; the most-recent call is the one that
        // awaits speech end and applies. Result: no matter how many
        // scrolls queue up, exactly one viewport movement lands when
        // the agent actually stops talking.
        const myGen = ++scrollGen;
        pendingScrollTarget = { path: targetPath, anchor };
        // The move lands with the words already playing — but never long: ElevenLabs gives a
        // client tool 30 s, and a turn that opens with ScrollTo has nothing playing at all
        // (waiting the old full 30 s for speech that never came timed every such call out).
        await waitForSpeechEnd(250, SCROLL_SPEECH_WAIT_MS, SCROLL_SPEECH_START_MS);
        if (myGen !== scrollGen) {
          return `Superseded by later ScrollTo`;
        }
        const target = pendingScrollTarget;
        pendingScrollTarget = null;
        if (!target) {
          return `Superseded by later ScrollTo`;
        }
        return scrollViewer(target.path, target.anchor);
      },
    ),
    ShowFile: withTracking("ShowFile", async (args: { path?: string }) => {
      const path = localPathFor(args.path);
      if (!path) return "Error: path is required.";
      const name = path.split(/[\\/]/).pop() ?? path;
      const kind = fileKind(path).kind;
      try {
        const content = isUnreadableAsText(path) ? "" : await invoke<string>("read_text_file", { path });
        useStore.getState().setCurrentFile(path, content);
      } catch (e) {
        return `Error: ${(e as any)?.message ?? String(e)}`;
      }
      if (kind !== "image") return `Opened ${name} for the user.`;
      // Fullscreen chat has no viewer: the image shows in the thread instead.
      const s = useStore.getState();
      if (s.chatFullscreen && !s.popoutOpen) {
        const thumb = await readImageThumb(path);
        if (thumb) voiceAppend({ role: "assistant", content: `Showing ${name}`, attachments: [{ imageDataUrl: thumb, sourcePath: path }] });
      }
      const r = await pushVoiceImageFile(path);
      return r === "sent" || r === "duplicate"
        ? `Showing ${name}. The image is attached — you can see it.`
        : `Showing ${name}, but the image couldn't be attached (${r}).`;
    }),
    LookAtScreen: withTracking("LookAtScreen", async () => {
      const state = useStore.getState();
      const file = state.currentFile;
      // The focused pane as it is on screen, read here at call time.
      const { focusedPane } = await import("./screenLook");
      const pane = focusedPane(file);
      if (pane) {
        try {
          return await lookAtScreenFromPane(pane);
        } catch (e) {
          console.error("[voice-eleven] LookAtScreen capture failed:", e);
          return `Error: the screen capture failed on the user's machine (${(e as Error)?.message ?? String(e)}). Tell the user it failed; it isn't a sync problem.`;
        }
      }
      if (!file) return "Nothing is open on the user's screen.";
      const name = file.split(/[\\/]/).pop() ?? file;
      const kind = fileKind(file).kind;
      if (kind === "image") {
        const r = await pushVoiceImageFile(file);
        if (r === "sent") return `Attached ${name} — you can see it now.`;
        if (r === "duplicate") return `${name} is already in your context — look at it.`;
        return `Couldn't attach ${name} (${r}).`;
      }
      if (kind === "pdf") {
        const page = state.viewport?.path === file ? state.viewport.page : undefined;
        const shot = page ? capturePdfPage(page) : null;
        if (shot && page) {
          const r = await pushVoiceImageDataUrl(`${file}#page=${page}`, shot, name, `page ${page}`);
          if (r === "sent" || r === "duplicate") return `Attached page ${page} of ${name} as the user sees it.`;
        }
        void pushPdfIfNeeded();
        return `The whole PDF ${name} is in your context${page ? `; the user is on page ${page}` : ""}.`;
      }
      const text = buildViewportContextText(state);
      return text || `${name} is open, but nothing in view can be read.`;
    }),
  };
  for (const name of new Set(remoteNames)) {
    if (LOCAL_VOICE_TOOLS.has(name)) continue;
    handlers[name] = withTracking(
      name,
      async (args: unknown) => {
        await Promise.resolve(linesSaved()).catch(() => undefined);
        return remote(name, args);
      },
      " · on the box",
    );
  }
  return handlers;
}
