import { useEffect, useRef } from "react";
import { Keyboard, Mic, MicOff, X } from "lucide-react";
import { useStore } from "./store";
import {
  endElevenLabsSession,
  getAgentEnvelopeLevels,
  getInputLevels,
  getOutputLevels,
  setVoiceMicMuted,
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

// Fullscreen chat has no titlebar: voice lives at the bottom, in place of the
// composer — the waves (Carl's voice while he talks, the agent's while it
// speaks), and type / mute / end. The thread above shows the lines as today.
export function FullscreenVoiceBar() {
  const connecting = useStore((s) => s.voiceConnecting);
  const muted = useStore((s) => s.voiceMicMuted);
  const tool = useStore((s) => s.voiceCurrentTool);
  const typing = useStore((s) => s.voiceTextPanelOpen);
  const btn =
    "h-8 w-8 shrink-0 flex items-center justify-center rounded-full text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors";
  return (
    <div
      data-el="voice-bar"
      className="relative flex items-center gap-2 h-[52px] px-2 rounded-2xl border border-border bg-background"
    >
      <button
        onClick={() => useStore.getState().setVoiceTextPanelOpen(!typing)}
        className={btn + (typing ? " text-foreground bg-accent/60" : "")}
        title={typing ? "Close the typed reply" : "Type to the voice agent instead of speaking"}
      >
        <Keyboard className="h-4 w-4" />
      </button>
      <div className="flex-1 min-w-0 flex items-center justify-center">
        {connecting ? (
          <span className="text-[12px] text-muted-foreground animate-pulse">Connecting…</span>
        ) : (
          <VoiceBars count={36} height={24} barClass="w-[3px] rounded-full" gapClass="gap-[3px]" />
        )}
      </div>
      {tool && !connecting && (
        <span className="absolute left-12 text-[11px] text-muted-foreground truncate max-w-[30%]" data-el="voice-tool">
          {tool}…
        </span>
      )}
      <button
        onClick={() => setVoiceMicMuted(!muted)}
        disabled={connecting}
        className={btn + (muted ? " text-destructive" : "") + " disabled:opacity-40"}
        title={muted ? "Unmute the mic" : "Mute the mic"}
        data-el="voice-mute"
      >
        {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </button>
      <button
        onClick={() => void endElevenLabsSession()}
        className="h-8 px-3 shrink-0 flex items-center gap-1.5 rounded-full bg-foreground text-background text-[12px] font-medium hover:opacity-90"
        title="End voice (Ctrl+D)"
        data-el="voice-end"
      >
        <X className="h-3.5 w-3.5" />
        End
      </button>
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
