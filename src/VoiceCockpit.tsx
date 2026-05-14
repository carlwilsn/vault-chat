import { useEffect, useRef } from "react";
import { useStore } from "./store";
import { getInputLevels, getOutputLevels } from "./voice-elevenlabs";

const NUM_BARS = 12;
const LEVEL_DECAY = 0.85;

// Floats absolutely-positioned in the center of the titlebar when
// voice mode is on. Two mutually-exclusive presentations:
//   • label only — when there's no real audio to visualise
//     (connecting / thinking)
//   • bars only — once the session has audio (listening / speaking)
// No pill chrome, no separator. Reads as another titlebar element.

export function VoiceCockpit() {
  const voiceMode = useStore((s) => s.voiceMode);
  const voiceConnecting = useStore((s) => s.voiceConnecting);

  if (!voiceMode) return null;

  // Only Connecting gets a label — the listening↔speaking gap is
  // brief enough that a "Thinking" label flashes faster than it
  // reads. Bars stay up the whole conversation; speaking spectrum
  // takes over when the agent's audio starts.
  return (
    <div
      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center z-10 pointer-events-auto"
    >
      {voiceConnecting ? (
        <div className="text-[10.5px] font-medium tabular-nums whitespace-nowrap text-muted-foreground animate-pulse">
          Connecting…
        </div>
      ) : (
        <VoiceBars />
      )}
    </div>
  );
}

function VoiceBars() {
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const smoothed = useRef<number[]>(new Array(NUM_BARS).fill(0));

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const s = useStore.getState();
      // Three sources, picked per-frame:
      //   • speaking + real audio → TTS output spectrum (the agent is talking)
      //   • speaking-mode but silent output OR a tool is running →
      //     synthesized sine wave so the user sees the system "thinking"
      //     instead of staring at flat bars during LLM/tool latency
      //   • otherwise → live mic input (idle / listening)
      const out = s.voiceSpeaking ? getOutputLevels(NUM_BARS) : null;
      const outActive =
        out !== null && out.reduce((a, b) => a + b, 0) > 0.05;

      let raw: number[];
      if (outActive && out) {
        raw = out;
      } else if (s.voiceSpeaking || s.voiceCurrentTool) {
        // Synthetic "thinking" wave: travelling sine pulses across the
        // bars so motion is visible. Amplitude is gentle (~0.4 max) so
        // it doesn't compete with real audio's energy when it kicks in.
        const t = performance.now() / 220;
        raw = new Array(NUM_BARS);
        for (let i = 0; i < NUM_BARS; i++) {
          const wave = Math.sin(t + i * 0.55) * 0.5 + 0.5;
          raw[i] = wave * 0.4;
        }
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
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Centre-anchored bars + transform-origin: center → bars grow
  // symmetrically up and down from a central baseline, like an
  // oscilloscope.
  return (
    <div className="flex items-center gap-[2px] h-4">
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
