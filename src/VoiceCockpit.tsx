import { useEffect, useRef, useState } from "react";
import { Keyboard, Mic } from "lucide-react";
import { useStore } from "./store";
import {
  toggleVoice,
  getAgentEnvelopeLevels,
  getInputLevels,
  getOutputLevels,
} from "./voice-elevenlabs";

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

// The titlebar's voice control — the mic, and the keyboard that slides out of
// it while voice is on. Shared by the titlebar and the fullscreen strip so the
// two are one control.
export function VoiceMicGroup() {
  const voiceMode = useStore((s) => s.voiceMode);
  const vaultPath = useStore((s) => s.vaultPath);
  const voiceTextPanelOpen = useStore((s) => s.voiceTextPanelOpen);
  const setVoiceTextPanelOpen = useStore((s) => s.setVoiceTextPanelOpen);
  // Right after the click that turns voice on the cursor sits on the mic, so
  // the keyboard would slide out unprompted: arm hover only once it has left.
  const ref = useRef<HTMLDivElement | null>(null);
  const [kbArmed, setKbArmed] = useState(false);
  useEffect(() => {
    if (!voiceMode) {
      setKbArmed(false);
      return;
    }
    const el = ref.current;
    if (!(el && el.matches(":hover"))) setKbArmed(true);
  }, [voiceMode]);
  return (
    <div
      ref={ref}
      className="relative flex items-center group"
      onMouseLeave={() => {
        if (voiceMode) setKbArmed(true);
      }}
    >
      <button
        onClick={toggleVoice}
        disabled={!vaultPath}
        data-el="voice-mic"
        className={`h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 relative z-10 bg-card disabled:opacity-40 ${
          voiceMode ? "text-foreground" : "text-muted-foreground"
        }`}
        title={voiceMode ? "Voice mode (on) — Ctrl+D to turn off" : "Voice mode (off) — Ctrl+D to turn on"}
      >
        <Mic className="h-3.5 w-3.5" strokeWidth={voiceMode ? 2.5 : 2} />
      </button>
      {voiceMode && (
        <div
          className={`overflow-hidden transition-[max-width] duration-200 ease-out ${
            voiceTextPanelOpen ? "max-w-7" : kbArmed ? "max-w-0 group-hover:max-w-7" : "max-w-0"
          }`}
        >
          <button
            onClick={() => setVoiceTextPanelOpen(!voiceTextPanelOpen)}
            className={`h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 ${
              voiceTextPanelOpen ? "text-foreground" : "text-muted-foreground"
            }`}
            title={voiceTextPanelOpen ? "Close text input" : "Type to the voice agent instead of speaking"}
          >
            <Keyboard className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

// Fullscreen chat has no titlebar: the same voice control sits in a strip at
// the bottom — the mic (+ keyboard) on the left, the bars centred while voice
// is on, exactly as at the top.
export function VoiceStrip() {
  return (
    <div data-el="voice-strip" className="h-9 shrink-0 flex items-center bg-card border-t border-border relative">
      <VoiceCockpit />
      <div className="px-2">
        <VoiceMicGroup />
      </div>
    </div>
  );
}

function VoiceBars({
  count = NUM_BARS,
  height = 14,
  barClass = "w-[2px] rounded-sm",
  gapClass = "gap-[2px]",
}: { count?: number; height?: number; barClass?: string; gapClass?: string } = {}) {
  const n = count;
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const smoothed = useRef<number[]>(new Array(n).fill(0));

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const s = useStore.getState();
      // Two sources, picked per-frame:
      //   • speaking → TTS output spectrum, or the chunk-derived playback
      //     envelope when the analyser reads dead (suspended AudioContext /
      //     buffer-up — the documented unreliable cases)
      //   • otherwise → live mic input (idle / listening / silent gaps)
      // While voiceSpeaking is on, the mic is NEVER the source: bars tracking
      // the user's ambient noise during the agent's turn is exactly the "wave
      // out of sync with the voice" desync (note 852e435b).
      // No synthesized motion: a fake "thinking" wave reads as ongoing
      // audio after the user barges in, which is misleading. Bars
      // sitting flat-low during latency is fine — connecting state has
      // its own label, and the rest is honestly silence.
      const out = s.voiceSpeaking ? getOutputLevels(n) : null;
      // Polled every speaking frame regardless of which source wins — polling
      // advances the envelope's playback cursor, so it stays in sync for the
      // frames where the analyser flakes out.
      const env = s.voiceSpeaking ? getAgentEnvelopeLevels(n) : null;
      const outActive =
        out !== null && out.reduce((a, b) => a + b, 0) > 0.05;
      // A muted mic is honestly silent, whatever the analyser still reads.
      const raw: number[] =
        outActive && out ? out : env !== null ? env : s.voiceMicMuted ? new Array(n).fill(0) : getInputLevels(n);

      const sm = smoothed.current;
      for (let i = 0; i < n; i++) {
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
  }, [n]);

  // Centre-anchored bars + transform-origin: center → bars grow
  // symmetrically up and down from a central baseline, like an
  // oscilloscope.
  return (
    <div className={`flex items-center ${gapClass}`} style={{ height: height + 2 }} data-el="voice-waves">
      {Array.from({ length: n }).map((_, i) => (
        <div
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className={`${barClass} bg-primary`}
          style={{
            height: `${height}px`,
            transformOrigin: "center",
            transform: "scaleY(0.3)",
          }}
        />
      ))}
    </div>
  );
}
