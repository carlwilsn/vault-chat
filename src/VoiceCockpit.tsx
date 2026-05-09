import { useEffect, useRef } from "react";
import { Eye } from "lucide-react";
import { useStore } from "./store";
import { getInputLevels, getOutputLevels } from "./voice-elevenlabs";

const NUM_BARS = 8;
const IDLE_HEIGHTS = [0.3, 0.5, 0.35, 0.55, 0.4, 0.5, 0.3, 0.45];
// Smoothing factor for level decay — current = max(new, prev * decay).
// Keeps bars from flickering between frames during quiet patches.
const LEVEL_DECAY = 0.85;

// Floats absolutely-positioned in the center of the titlebar when
// voice mode is on. Shows live state: follow-along eye toggle, an
// animated voice bar, and a single status label that rolls through
// listening / thinking / running-tool / speaking. Hidden when
// voiceMode is off.

export function VoiceCockpit() {
  const voiceMode = useStore((s) => s.voiceMode);
  const followAlong = useStore((s) => s.followAlong);
  const toggleFollowAlong = useStore((s) => s.toggleFollowAlong);
  const liveTools = useStore((s) => s.liveTools);
  const busy = useStore((s) => s.busy);
  const voiceListening = useStore((s) => s.voiceListening);
  const voiceSpeaking = useStore((s) => s.voiceSpeaking);

  if (!voiceMode) return null;

  const runningTool = liveTools.find((t) => t.result === undefined);

  // Priority order: user-facing states win over agent states.
  // Listening (you're talking) > running tool (visible work) >
  // speaking (audio is out) > thinking (generating, no audio yet).
  let label: string;
  let labelKind: "user" | "tool" | "speak" | "think" | "idle";
  if (voiceListening) {
    label = "Listening…";
    labelKind = "user";
  } else if (runningTool) {
    label = `Running ${runningTool.name}…`;
    labelKind = "tool";
  } else if (voiceSpeaking) {
    label = "Speaking";
    labelKind = "speak";
  } else if (busy) {
    label = "Thinking…";
    labelKind = "think";
  } else {
    label = "Voice mode on";
    labelKind = "idle";
  }

  // Bars animate when something audio-ish is happening — listening,
  // speaking, or thinking (the agent is on its way to making sound).
  const barsActive = voiceListening || voiceSpeaking || busy;

  return (
    <>
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-2 px-3 h-7 rounded-full bg-primary/5 border border-primary/30 z-10 pointer-events-auto"
      >
        <button
          onClick={toggleFollowAlong}
          title={
            followAlong
              ? "Follow-along on — agent receives the active file as context"
              : "Follow-along off — click to let the agent see what you see"
          }
          className={`h-5 w-5 flex items-center justify-center rounded ${
            followAlong
              ? "text-primary"
              : "text-muted-foreground/60 hover:text-muted-foreground"
          }`}
        >
          <Eye className="h-3 w-3" />
        </button>
        <div className="h-3 w-px bg-border/60" />
        <VoiceBars active={barsActive} />
        <div className="h-3 w-px bg-border/60" />
        <div
          className={`text-[10.5px] font-medium tabular-nums whitespace-nowrap ${
            labelKind === "user"
              ? "text-primary"
              : labelKind === "tool"
                ? "text-primary/85"
                : labelKind === "speak"
                  ? "text-foreground/80"
                  : labelKind === "think"
                    ? "text-muted-foreground"
                    : "text-muted-foreground/70"
          }`}
        >
          {label}
        </div>
      </div>
    </>
  );
}

function VoiceBars({ active }: { active: boolean }) {
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const smoothed = useRef<number[]>(new Array(NUM_BARS).fill(0));

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const s = useStore.getState();
      let raw: number[];
      if (s.voiceListening) {
        raw = getInputLevels(NUM_BARS);
      } else if (s.voiceSpeaking) {
        raw = getOutputLevels(NUM_BARS);
      } else {
        raw = IDLE_HEIGHTS;
      }
      const sm = smoothed.current;
      for (let i = 0; i < NUM_BARS; i++) {
        const decayed = sm[i] * LEVEL_DECAY;
        sm[i] = raw[i] > decayed ? raw[i] : decayed;
        const ref = barRefs.current[i];
        if (ref) {
          // Floor at ~20% so the bars never collapse fully — feels
          // alive rather than dead-flat between phonemes.
          const h = 0.2 + Math.min(1, sm[i]) * 0.8;
          ref.style.transform = `scaleY(${h.toFixed(3)})`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="flex items-end gap-[2px] h-3.5">
      {Array.from({ length: NUM_BARS }).map((_, i) => (
        <div
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className={`w-[2px] rounded-sm bg-primary ${active ? "" : "opacity-40"}`}
          style={{
            height: `12px`,
            transformOrigin: "bottom",
            transform: `scaleY(${IDLE_HEIGHTS[i]})`,
          }}
        />
      ))}
    </div>
  );
}
