import { Eye } from "lucide-react";
import { useStore } from "./store";

// Floats absolutely-positioned in the center of the titlebar when
// voice mode is on. Shows live state: follow-along eye toggle, an
// animated voice bar, the tail of whatever the agent is saying, and
// a chip when a tool call is in flight. Hidden when voiceMode is off.

const STREAMING_TEXT_TAIL = 48;

export function VoiceCockpit() {
  const voiceMode = useStore((s) => s.voiceMode);
  const followAlong = useStore((s) => s.followAlong);
  const toggleFollowAlong = useStore((s) => s.toggleFollowAlong);
  const streamingText = useStore((s) => s.streamingText);
  const liveTools = useStore((s) => s.liveTools);
  const busy = useStore((s) => s.busy);

  if (!voiceMode) return null;

  const tail =
    streamingText.length > STREAMING_TEXT_TAIL
      ? "…" + streamingText.slice(-STREAMING_TEXT_TAIL).trimStart()
      : streamingText.trimStart();

  const runningTool = liveTools.find((t) => t.result === undefined);

  return (
    <>
      <style>{`
        @keyframes vc-voice-bar { 0%,100% { transform: scaleY(0.35); } 50% { transform: scaleY(1); } }
        .vc-voice-bar { transform-origin: bottom; animation: vc-voice-bar 1s ease-in-out infinite; }
      `}</style>
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
        <VoiceBars active={busy} />
        <div className="h-3 w-px bg-border/60" />
        <div className="text-[10.5px] text-muted-foreground italic max-w-[260px] truncate min-w-[60px]">
          {tail || (busy ? "…" : "voice mode on")}
        </div>
        {runningTool && (
          <>
            <div className="h-3 w-px bg-border/60" />
            <div className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-primary/15 text-primary">
              {runningTool.name}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function VoiceBars({ active }: { active: boolean }) {
  const heights = [3, 8, 4, 10, 5, 9, 4, 7];
  return (
    <div className="flex items-end gap-[2px] h-3.5">
      {heights.map((h, i) => (
        <div
          key={i}
          className={`w-[2px] rounded-sm bg-primary ${active ? "vc-voice-bar" : "opacity-40"}`}
          style={{
            height: `${h}px`,
            animationDelay: active ? `${i * 80}ms` : undefined,
          }}
        />
      ))}
    </div>
  );
}
