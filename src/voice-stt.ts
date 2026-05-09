import { useStore } from "./store";
import { isVoicePlaying } from "./voice-tts";

// Streaming STT for voice mode. Holds the mic stream open, runs a
// simple energy-threshold VAD against the live audio, and segments
// utterances by sustained-above-threshold start + sustained-below-
// threshold end. Each segment goes to OpenAI's transcribe endpoint
// and the resulting text is handed to the supplied callback (which
// the Titlebar wires to sendMessage).

const STT_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const STT_MODEL = "gpt-4o-transcribe";

const ANALYSER_FFT_SIZE = 1024;
// Tuned to be forgiving — this is RMS amplitude on a [-1, 1] signal.
// Background room hiss usually sits around 0.005; quiet speech is ~0.02+.
const SPEECH_ENERGY_THRESHOLD = 0.012;
// How long energy must stay above threshold to count as speech start.
// Short enough that "yes" lands; long enough that a chair-creak doesn't.
const SPEECH_START_MS = 80;
// Silence after speech that signals end-of-utterance.
const SILENCE_END_MS = 800;
// Total recording duration below this is treated as noise and dropped.
// Captures the speech-start lead-in + utterance + silence tail, so 1s
// is roughly "any actual word".
const MIN_UTTERANCE_MS = 1000;
// VAD tick interval — setInterval keeps running when the window is
// unfocused (rAF would not), which matters for "I'm reading something
// in another window and want to ask Claude" workflows.
const VAD_TICK_MS = 20;

let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let tickHandle: ReturnType<typeof setInterval> | null = null;
let recorderMimeType = "";

let speechStartTime: number | null = null;
let aboveThresholdSince: number | null = null;
let belowThresholdSince: number | null = null;
let isCapturing = false;
let onTranscriptCallback: ((text: string) => void) | null = null;

export async function startListening(
  onTranscript: (text: string) => void,
): Promise<void> {
  if (mediaStream) return;
  onTranscriptCallback = onTranscript;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    console.warn("[voice-stt] mic unavailable:", e);
    onTranscriptCallback = null;
    return;
  }
  recorderMimeType = pickRecorderMime();
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = ANALYSER_FFT_SIZE;
  const source = audioContext.createMediaStreamSource(mediaStream);
  source.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  tickHandle = setInterval(() => {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(buf);
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
    const rms = Math.sqrt(sumSq / buf.length);
    const now = performance.now();
    if (rms >= SPEECH_ENERGY_THRESHOLD) {
      belowThresholdSince = null;
      if (aboveThresholdSince === null) aboveThresholdSince = now;
      if (!isCapturing && now - aboveThresholdSince >= SPEECH_START_MS) {
        beginCapture();
      }
    } else {
      aboveThresholdSince = null;
      if (isCapturing) {
        if (belowThresholdSince === null) belowThresholdSince = now;
        if (now - belowThresholdSince >= SILENCE_END_MS) {
          endCapture();
        }
      }
    }
  }, VAD_TICK_MS);
}

export function stopListening(): void {
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.stop();
    } catch {}
  }
  mediaRecorder = null;
  recordedChunks = [];
  if (mediaStream) {
    for (const t of mediaStream.getTracks()) t.stop();
    mediaStream = null;
  }
  if (audioContext) {
    void audioContext.close().catch(() => {});
    audioContext = null;
  }
  analyser = null;
  speechStartTime = null;
  aboveThresholdSince = null;
  belowThresholdSince = null;
  isCapturing = false;
  onTranscriptCallback = null;
}

function pickRecorderMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  if (typeof MediaRecorder === "undefined") return "";
  if (typeof MediaRecorder.isTypeSupported !== "function") return "";
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function beginCapture(): void {
  if (!mediaStream) return;
  // Voice input is dropped while the agent is busy or its TTS is
  // still playing — the input loop is purely "user starts a fresh
  // turn" until commit 4 lands the proper interrupt path. Gating on
  // isVoicePlaying() also avoids speaker→mic crosstalk feeding the
  // agent's own voice back into transcription.
  if (useStore.getState().busy || isVoicePlaying()) return;
  isCapturing = true;
  speechStartTime = performance.now();
  recordedChunks = [];
  try {
    mediaRecorder = recorderMimeType
      ? new MediaRecorder(mediaStream, { mimeType: recorderMimeType })
      : new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.start(100);
  } catch (e) {
    console.warn("[voice-stt] recorder start failed:", e);
    isCapturing = false;
    speechStartTime = null;
  }
}

function endCapture(): void {
  isCapturing = false;
  const startedAt = speechStartTime;
  speechStartTime = null;
  belowThresholdSince = null;
  if (!mediaRecorder) return;
  const recorder = mediaRecorder;
  mediaRecorder = null;
  recorder.onstop = () => {
    const duration = startedAt ? performance.now() - startedAt : 0;
    const chunks = recordedChunks;
    recordedChunks = [];
    if (duration < MIN_UTTERANCE_MS || chunks.length === 0) return;
    const mime = recorderMimeType || "audio/webm";
    const blob = new Blob(chunks, { type: mime });
    void transcribeAndSubmit(blob);
  };
  try {
    recorder.stop();
  } catch (e) {
    console.warn("[voice-stt] recorder stop failed:", e);
  }
}

async function transcribeAndSubmit(blob: Blob): Promise<void> {
  const apiKey = useStore.getState().apiKeys.openai;
  if (!apiKey) {
    console.warn("[voice-stt] no OpenAI API key — voice input requires one");
    return;
  }
  const form = new FormData();
  const ext = blob.type.includes("ogg") ? "ogg" : "webm";
  form.append("file", blob, `speech.${ext}`);
  form.append("model", STT_MODEL);
  let text: string;
  try {
    const res = await fetch(STT_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn("[voice-stt] api error:", res.status, errText);
      return;
    }
    const json = (await res.json()) as { text?: string };
    text = (json.text ?? "").trim();
  } catch (e) {
    console.warn("[voice-stt] fetch failed:", e);
    return;
  }
  if (!text) return;
  onTranscriptCallback?.(text);
}
