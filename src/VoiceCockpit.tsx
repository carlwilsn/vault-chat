import { useEffect, useRef, useState } from "react";
import { Keyboard, Mic, MicOff } from "lucide-react";
import { useStore } from "./store";
import { toggleVoice, toggleVoiceMute, voiceBarLevels } from "./voice-elevenlabs";
import { isPopout } from "./windowKind";
import { relayedVoiceLevels } from "./sync";

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

// Mute: the big, plain toggle by the composer (Carl lets voice sit muted while he works and unmutes to ask).
// Muted is unmistakable: solid red, a slashed mic, the word. Ctrl+Shift+M (App.tsx) does the same. The
// mute is the SDK's own: no audio leaves the laptop, and the voice can still speak a result. Voice runs in
// the main window, so a popout shows nothing here. When voice moved to another device, this spot says so.
export function VoiceMuteButton() {
  const live = useStore((s) => s.voiceMode && !s.voiceConnecting);
  const muted = useStore((s) => s.voiceMicMuted);
  const notice = useStore((s) => s.voiceNotice);
  const voiceMode = useStore((s) => s.voiceMode);
  if (isPopout) return null;
  if (!voiceMode && notice)
    return (
      <span data-el="voice-notice" className="h-7 px-2.5 flex items-center rounded-full text-[11px] font-medium whitespace-nowrap text-muted-foreground bg-muted/60" title="Start voice here to bring it back">
        {notice}
      </span>
    );
  if (!live) return null;
  return (
    <button
      onClick={() => toggleVoiceMute()}
      data-el="voice-mute"
      aria-pressed={muted}
      aria-label={muted ? "Unmute" : "Mute"}
      title={muted ? "Muted: nothing is sent. Click or Ctrl+Shift+M to talk" : "Mute the mic (Ctrl+Shift+M)"}
      className={`h-7 px-2.5 gap-1.5 flex items-center rounded-full text-[11px] font-semibold whitespace-nowrap transition-colors ${
        muted ? "bg-red-600 text-white hover:bg-red-700" : "bg-accent/70 text-foreground hover:bg-accent"
      }`}
    >
      {muted ? <MicOff className="h-3.5 w-3.5" strokeWidth={2.5} /> : <Mic className="h-3.5 w-3.5" />}
      <span>{muted ? "Muted" : "Mute"}</span>
    </button>
  );
}

// Fullscreen chat has no titlebar: while voice is on, the titlebar's waves sit
// inside the composer, beside its mic — no extra row, nothing moves.
export function InlineVoiceWaves() {
  const voiceMode = useStore((s) => s.voiceMode);
  const connecting = useStore((s) => s.voiceConnecting);
  const error = useStore((s) => s.voiceError);
  // Voice failed (to start, or mid-session): flat bars in the destructive
  // colour, until the next start attempt or a successful connect.
  if (error && !connecting) {
    return (
      <span data-el="voice-waves" data-error="1" className="flex items-center h-7 px-1" title={`Voice failed: ${error}`}>
        <FlatBars colorClass="bg-destructive" />
      </span>
    );
  }
  if (!voiceMode) return null;
  return (
    <span data-el="voice-waves" className="flex items-center h-7 px-1">
      {connecting ? <span className="text-[10.5px] text-muted-foreground animate-pulse">Connecting…</span> : <VoiceBars />}
    </span>
  );
}

/** The waves at rest (no audio): the bars' floor height, in `colorClass`. */
function FlatBars({ count = NUM_BARS, height = 14, colorClass }: { count?: number; height?: number; colorClass: string }) {
  return (
    <div className="flex items-center gap-[2px]" style={{ height: height + 2 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={`w-[2px] rounded-sm ${colorClass}`} style={{ height: `${height}px`, transformOrigin: "center", transform: "scaleY(0.3)" }} />
      ))}
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
      // The levels' sources are voiceBarLevels'; the popout's come from main.
      const raw: number[] = isPopout ? relayedVoiceLevels(n) : voiceBarLevels(n);

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
