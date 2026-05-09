import { useStore } from "./store";

// Streaming TTS for voice mode. Buffers incoming token deltas, emits
// requests to OpenAI's speech endpoint at sentence boundaries, decodes
// the returned PCM into AudioBuffers, and plays them back-to-back via
// the Web Audio API. Cancellation aborts in-flight fetches and stops
// the current source mid-playback so an interrupt feels instant.

const TTS_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const TTS_MODEL = "gpt-4o-mini-tts";
const TTS_VOICE = "alloy";
const TTS_SAMPLE_RATE = 24000;
// Below this we wait for more text rather than firing a tiny request.
// Tiny chunks both waste API calls and produce choppy speech.
const MIN_CHUNK_CHARS = 60;
// First chunk only — much lower so the agent starts speaking ASAP. The
// trade-off is a slightly choppier first sentence in exchange for
// dramatically lower time-to-first-audio. Reset on each agent turn.
const FIRST_CHUNK_MIN_CHARS = 20;
// Hard ceiling so a giant code block / no-punctuation paragraph doesn't
// sit forever. If the buffer reaches this without a sentence boundary,
// we cut at the nearest space.
const MAX_CHUNK_CHARS = 400;

let audioContext: AudioContext | null = null;
let pendingSources: AudioBufferSourceNode[] = [];
let audioQueue: AudioBuffer[] = [];
let isPlaying = false;
let activeFetch: AbortController | null = null;
let textBuffer = "";
// True until the first chunk of an agent turn is dispatched — used to
// gate FIRST_CHUNK_MIN_CHARS so the first audio fires fast even if the
// model leads with a short opener. Reset on flush / cancel / pause.
let firstChunkPending = true;
// Bumped on every cancelVoice(). Lets in-flight fetches notice they've
// been cancelled after the network resolves but before we touch audio.
let generation = 0;

export async function initVoiceTts(): Promise<void> {
  if (!audioContext) {
    try {
      audioContext = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
    } catch (e) {
      console.warn("[voice-tts] audio context init failed:", e);
      return;
    }
  }
  if (audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch (e) {
      console.warn("[voice-tts] resume failed:", e);
    }
  }
}

export function feedText(delta: string): void {
  textBuffer += delta;
  while (textBuffer.length > 0) {
    const minChars = firstChunkPending ? FIRST_CHUNK_MIN_CHARS : MIN_CHUNK_CHARS;
    const m = /[.!?]+(?:\s|$)/.exec(textBuffer);
    if (m) {
      const cut = m.index + m[0].length;
      if (cut < minChars && textBuffer.length < MAX_CHUNK_CHARS) {
        // Sentence ended too early — wait for more.
        break;
      }
      const chunk = textBuffer.slice(0, cut).trim();
      textBuffer = textBuffer.slice(cut);
      if (chunk) {
        firstChunkPending = false;
        void enqueueSpeak(chunk);
      }
      continue;
    }
    if (textBuffer.length >= MAX_CHUNK_CHARS) {
      // No punctuation in sight — cut at the last space within the cap.
      let cut = textBuffer.lastIndexOf(" ", MAX_CHUNK_CHARS);
      if (cut <= 0) cut = MAX_CHUNK_CHARS;
      const chunk = textBuffer.slice(0, cut).trim();
      textBuffer = textBuffer.slice(cut);
      if (chunk) {
        firstChunkPending = false;
        void enqueueSpeak(chunk);
      }
      continue;
    }
    break;
  }
}

export function flushVoice(): void {
  const remaining = textBuffer.trim();
  textBuffer = "";
  firstChunkPending = true;
  if (remaining.length > 0) {
    void enqueueSpeak(remaining);
  }
}

export function isVoicePlaying(): boolean {
  return isPlaying || audioQueue.length > 0 || pendingSources.length > 0;
}

// Stop the agent's voice immediately but keep the text buffer intact.
// The agent's text stream may still be in flight; if it continues to
// emit deltas we want TTS to pick back up at the next sentence rather
// than dropping a paragraph. Used when the user starts speaking — if
// the speech turns out to be a real interrupt, cancelVoice() (called
// via interruptAndSend) will do the full reset; if it was just a
// backchannel, the agent's voice resumes naturally.
export function pauseVoice(): void {
  generation++;
  // Don't reset firstChunkPending — when text resumes after a pause we
  // still want the next chunk to come out fast.
  audioQueue = [];
  for (const src of pendingSources) {
    try {
      src.stop();
    } catch {}
    try {
      src.disconnect();
    } catch {}
  }
  pendingSources = [];
  if (activeFetch) {
    activeFetch.abort();
    activeFetch = null;
  }
  isPlaying = false;
  useStore.getState().setVoiceSpeaking(false);
}

export function cancelVoice(): void {
  generation++;
  textBuffer = "";
  firstChunkPending = true;
  audioQueue = [];
  for (const src of pendingSources) {
    try {
      src.stop();
    } catch {}
    try {
      src.disconnect();
    } catch {}
  }
  pendingSources = [];
  if (activeFetch) {
    activeFetch.abort();
    activeFetch = null;
  }
  isPlaying = false;
  useStore.getState().setVoiceSpeaking(false);
}

// Defensive cleanup before TTS — even though the voice-mode system
// prompt tells the agent not to emit markdown / emoji, slips happen
// (model still drops a stray asterisk, or older history is being
// reread). Strip the obvious offenders so the audio sounds natural.
function sanitizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(
      /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F100}-\u{1F1FF}\u{2700}-\u{27BF}]/gu,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

async function enqueueSpeak(text: string): Promise<void> {
  const cleaned = sanitizeForSpeech(text);
  if (!cleaned) return;
  const myGen = generation;
  const apiKey = useStore.getState().apiKeys.openai;
  if (!apiKey) {
    console.warn("[voice-tts] no OpenAI API key — voice mode requires one");
    return;
  }
  const ctx = audioContext;
  if (!ctx) {
    console.warn("[voice-tts] audio context missing");
    return;
  }
  const ac = new AbortController();
  activeFetch = ac;
  let bytes: ArrayBuffer;
  try {
    const res = await fetch(TTS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: TTS_VOICE,
        input: cleaned,
        response_format: "pcm",
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn("[voice-tts] api error:", res.status, errText);
      return;
    }
    bytes = await res.arrayBuffer();
  } catch (e) {
    if ((e as any)?.name === "AbortError") return;
    console.warn("[voice-tts] fetch failed:", e);
    return;
  } finally {
    if (activeFetch === ac) activeFetch = null;
  }
  if (myGen !== generation) return;
  // PCM response is signed 16-bit little-endian mono at 24 kHz.
  const pcm = new Int16Array(bytes);
  const buffer = ctx.createBuffer(1, pcm.length, TTS_SAMPLE_RATE);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) {
    channel[i] = pcm[i] / 0x8000;
  }
  audioQueue.push(buffer);
  if (!isPlaying) playNext();
}

function playNext(): void {
  if (!audioContext) return;
  const buffer = audioQueue.shift();
  if (!buffer) {
    isPlaying = false;
    useStore.getState().setVoiceSpeaking(false);
    return;
  }
  isPlaying = true;
  useStore.getState().setVoiceSpeaking(true);
  const src = audioContext.createBufferSource();
  src.buffer = buffer;
  src.connect(audioContext.destination);
  src.onended = () => {
    pendingSources = pendingSources.filter((s) => s !== src);
    playNext();
  };
  pendingSources.push(src);
  src.start();
}
