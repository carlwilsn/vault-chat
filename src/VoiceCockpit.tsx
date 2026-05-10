import { useEffect, useRef } from "react";
import { useStore } from "./store";
import { getInputLevels, getOutputLevels } from "./voice-elevenlabs";

const NUM_BARS = 8;
// Smoothing factor for level decay — current = max(new, prev * decay).
// Keeps bars from flickering between frames during quiet patches.
const LEVEL_DECAY = 0.85;

// Floats absolutely-positioned in the center of the titlebar when
// voice mode is on. Bare bars + separator + status label, no rounded
// pill chrome — meant to read as another titlebar element rather
// than a separate widget. Hidden when voiceMode is off.

export function VoiceCockpit() {
  const voiceMode = useStore((s) => s.voiceMode);
  const busy = useStore((s) => s.busy);
  const voiceSpeaking = useStore((s) => s.voiceSpeaking);
  const voiceConnecting = useStore((s) => s.voiceConnecting);

  if (!voiceMode) return null;

  // Priority: connecting (initial handshake) > speaking (audio out)
  // > thinking (generating, no audio yet) > listening (default).
  // No tool label — tool calls flash too fast to read; they show up
  // as italic markers in the chat history instead.
  let label: string;
  let labelKind: "connecting" | "speak" | "think" | "user";
  if (voiceConnecting) {
    label = "Connecting…";
    labelKind = "connecting";
  } else if (voiceSpeaking) {
    label = "Speaking";
    labelKind = "speak";
  } else if (busy) {
    label = "Thinking…";
    labelKind = "think";
  } else {
    label = "Listening…";
    labelKind = "user";
  }

  return (
    <div
      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-2 z-10 pointer-events-auto"
    >
      <VoiceBars />
      <div className="h-3 w-px bg-border" />
      <div
        className={`text-[10.5px] font-medium tabular-nums whitespace-nowrap ${
          labelKind === "connecting"
            ? "text-muted-foreground animate-pulse"
            : labelKind === "user"
              ? "text-foreground/85"
              : labelKind === "speak"
                ? "text-foreground/80"
                : "text-muted-foreground"
        }`}
      >
        {label}
      </div>
    </div>
  );
}

function VoiceBars() {
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const smoothed = useRef<number[]>(new Array(NUM_BARS).fill(0));

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const s = useStore.getState();
      let raw: number[];
      // Bar source priority:
      // - speaking: agent's TTS output spectrum
      // - connecting: a slow synthesised pulse so the user sees a
      //   heartbeat during the handshake, before mic stream starts
      // - everything else: live mic input
      if (s.voiceSpeaking) {
        raw = getOutputLevels(NUM_BARS);
      } else if (s.voiceConnecting) {
        const now = performance.now() * 0.003;
        raw = Array.from({ length: NUM_BARS }, (_, i) =>
          0.3 + 0.15 * Math.sin(now + i * 0.4),
        );
      } else {
        raw = getInputLevels(NUM_BARS);
      }
      const sm = smoothed.current;
      for (let i = 0; i < NUM_BARS; i++) {
        const decayed = sm[i] * LEVEL_DECAY;
        sm[i] = raw[i] > decayed ? raw[i] : decayed;
        const ref = barRefs.current[i];
        if (ref) {
          // Floor at ~20% so bars never fully collapse.
          const h = 0.2 + Math.min(1, sm[i]) * 0.8;
          ref.style.transform = `scaleY(${h.toFixed(3)})`;
        }
      }
      // Dim bars only while connecting; once the session is live the
      // bars track real audio at full opacity.
      const c = containerRef.current;
      if (c) c.style.opacity = s.voiceConnecting ? "0.5" : "1";
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // align-items: center → bars are anchored to the vertical centre
  // of the container, and transform-origin: center on each bar makes
  // them grow symmetrically up and down. Reads like a real audio
  // waveform/oscilloscope.
  return (
    <div
      ref={containerRef}
      className="flex items-center gap-[2px] h-4"
      style={{ transition: "opacity 200ms ease" }}
    >
      {Array.from({ length: NUM_BARS }).map((_, i) => (
        <div
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className="w-[2px] rounded-sm bg-primary"
          style={{
            height: "14px",
            transformOrigin: "center",
            transform: "scaleY(0.3)",
          }}
        />
      ))}
    </div>
  );
}
