import { useEffect, useRef, useState } from "react";
import { Keyboard, Mic, MicOff, VolumeX } from "lucide-react";
import { useStore } from "./store";
import { reconnectVoiceAudio, toggleVoice, toggleVoiceMute, voiceBarLevels } from "./voice-elevenlabs";
import { AUDIO_WARN_LINE } from "./voiceMic";
import { isPopout } from "./windowKind";
import { relayedVoiceLevels } from "./sync";
import { WaitTracker, calibFrom, renderWaitLine, waitInputs, type WaitCalib } from "./voiceWaitLine";

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
  const muted = useStore((s) => s.voiceMicMuted);
  // Chat open (docked, fullscreen or popped out): its rows say what is running and the composer has Mute; closed,
  // the waves are the voice's one control (a click mutes) with a tiny line beside them for work still running.
  const chatOpen = useStore((s) => !s.rightCollapsed || s.chatFullscreen || s.popoutOpen);

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
      ) : chatOpen ? (
        <VoiceWaves />
      ) : (
        <button
          type="button"
          data-el="voice-waves-mute"
          aria-pressed={muted}
          onClick={() => toggleVoiceMute()}
          title={muted ? "Muted: nothing is sent. Click (or Ctrl+Shift+M) to talk" : "Listening. Click to mute (Ctrl+Shift+M)"}
          className={`relative flex items-center rounded px-0.5 ${muted ? "opacity-40" : ""}`}
        >
          <VoiceWaves />
          {muted && <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-[1.5px] w-[22px] -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded bg-foreground/80" />}
        </button>
      )}
    </div>
  );
}

/** The bars, and under them the waiting line (src/voiceWaitLine.ts): one element, the same on every surface. */
function VoiceWaves() {
  return (
    <div className="flex flex-col items-stretch text-primary">
      <VoiceBars />
      <WaitLine />
    </div>
  );
}

let boxCalib: { at: number; calib: WaitCalib } | null = null;

/** What the voice is waiting on, as one line: the running turn's tools (with the agent's plan, if it made one), the
 *  work it handed off (Delegate workers) and, on Classic, what was asked on the call (its Ask row). Gone when the voice
 *  speaks. Read from the store every 250 ms; drawn by renderWaitLine. */
function WaitLine() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const tracker = new WaitTracker();
    if (!boxCalib || Date.now() - boxCalib.at > 10 * 60_000) {
      void (async () => {
        try {
          const { boxGet, boxLinkFor } = await import("./boxChat");
          const link = await boxLinkFor(useStore.getState().vaultPath);
          const r = link ? await boxGet(link, "/api/v1/brain/expect", 5000) : null;
          if (r?.calib) boxCalib = { at: Date.now(), calib: r.calib };
        } catch {
          /* the line's defaults */
        }
      })();
    }
    const tick = () => {
      const s = useStore.getState();
      const now = Date.now();
      const conv = s.conversations.find((x) => x.id === s.activeConversationId);
      const { works, plan, samples } = waitInputs({ running: s.busy, tools: s.liveTools, subagents: conv?.subagents, todos: conv?.todos, messages: s.messages, now });
      const calib = calibFrom(samples, boxCalib?.calib ?? {});
      if (ref.current) renderWaitLine(ref.current, tracker.update({ works, plan, calib, now, speaking: s.voiceSpeaking }));
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, []);
  return <div ref={ref} />;
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
        onClick={() => toggleVoice("titlebar mic")}
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
  // The agent's audio can't be heard (a suspended context, a blocked page, its output gone): said, and one tap
  // reconnects it — instead of waves over silence.
  if (notice === AUDIO_WARN_LINE)
    return (
      <button
        onClick={() => void reconnectVoiceAudio()}
        data-el="voice-audio-warn"
        title="The voice's audio isn't reaching your speakers. Click to reconnect it."
        className="h-7 px-2.5 gap-1.5 flex items-center rounded-full text-[11px] font-semibold whitespace-nowrap bg-amber-500 text-black hover:bg-amber-600"
      >
        <VolumeX className="h-3.5 w-3.5" />
        <span>{AUDIO_WARN_LINE}</span>
      </button>
    );
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
