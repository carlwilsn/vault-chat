import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize2, Minimize2 } from "lucide-react";
import { cn } from "./lib/utils";
import { hit } from "./shortcuts";

// The app's own video player: the browser's default controls (a different
// look in every webview) are replaced by a quiet bar in vault-chat's style,
// the same in the chat and in the viewer. No autoplay: Carl's own Play starts
// video and audio together. Every element is phrasing content (spans), because
// a video in a chat sits inside a markdown paragraph.

/** 75 → "1:15", 3725 → "1:02:05"; a duration not known yet → "0:00". */
export function videoTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Where in the video a pointer on the track is: 0 at its left edge, 1 at its right. */
export function trackFraction(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width));
}

const barButton =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function VideoPlayer({
  src,
  title,
  fill = false,
  className,
  dataEl,
  onError,
  extra,
}: {
  src: string;
  title?: string;
  /** The viewer: the video takes the whole pane. Without it (a chat), it is as wide as its message allows. */
  fill?: boolean;
  className?: string;
  /** `data-el` of the <video> itself (tests and RecordUI find it by this). */
  dataEl?: string;
  onError?: () => void;
  /** More controls at the right of the bar (the viewer's "system player"). */
  extra?: ReactNode;
}) {
  const wrap = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  const [full, setFull] = useState(false);
  const dragging = useRef(false);

  useEffect(() => {
    const onFull = () => setFull(document.fullscreenElement === wrap.current);
    document.addEventListener("fullscreenchange", onFull);
    return () => document.removeEventListener("fullscreenchange", onFull);
  }, []);

  const toggle = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused || v.ended) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const seekTo = useCallback((seconds: number) => {
    const v = video.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.min(v.duration, Math.max(0, seconds));
    setTime(v.currentTime);
  }, []);

  const seekAt = (clientX: number) => {
    const t = track.current;
    const v = video.current;
    if (!t || !v || !Number.isFinite(v.duration)) return;
    const r = t.getBoundingClientRect();
    seekTo(trackFraction(clientX, r.left, r.width) * v.duration);
  };

  const onTrackDown = (e: PointerEvent<HTMLSpanElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekAt(e.clientX);
  };
  const onTrackMove = (e: PointerEvent<HTMLSpanElement>) => {
    if (dragging.current) seekAt(e.clientX);
  };
  const onTrackUp = (e: PointerEvent<HTMLSpanElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const toggleMute = () => {
    const v = video.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  const toggleFull = () => {
    const w = wrap.current;
    if (!w) return;
    if (document.fullscreenElement === w) void document.exitFullscreen().catch(() => {});
    else void w.requestFullscreen?.().catch(() => {});
  };

  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    const onButton = (e.target as HTMLElement).closest("button");
    if (hit(e, "video.play")) {
      if (onButton) return; // a focused button takes Space itself
      e.preventDefault();
      toggle();
    } else if (hit(e, "video.back")) {
      e.preventDefault();
      seekTo(time - 5);
    } else if (hit(e, "video.forward")) {
      e.preventDefault();
      seekTo(time + 5);
    } else if (hit(e, "video.mute")) toggleMute();
    else if (hit(e, "video.full")) toggleFull();
  };

  const at = duration > 0 ? Math.min(1, time / duration) : 0;
  const loaded = duration > 0 ? Math.min(1, buffered / duration) : 0;

  return (
    <span
      ref={wrap}
      data-el="video-player"
      tabIndex={0}
      onKeyDown={onKey}
      className={cn(
        "flex flex-col overflow-hidden bg-black focus-visible:outline-none",
        fill || full ? "h-full w-full min-h-0 flex-1" : "inline-flex max-w-full rounded-md border border-border/60 align-top",
        className,
      )}
    >
      <video
        ref={video}
        src={src}
        title={title}
        data-el={dataEl}
        playsInline
        preload="metadata"
        onClick={toggle}
        onDoubleClick={toggleFull}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          if (!dragging.current) setTime(e.currentTarget.currentTime);
        }}
        onDurationChange={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
        onProgress={(e) => {
          const b = e.currentTarget.buffered;
          setBuffered(b.length ? b.end(b.length - 1) : 0);
        }}
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
        onError={onError}
        className={cn("block cursor-pointer bg-black", fill || full ? "min-h-0 w-full flex-1 object-contain" : "max-h-[70vh] max-w-full")}
      />
      <span data-el="video-bar" className="flex h-9 shrink-0 items-center gap-1.5 border-t border-border/60 bg-card px-1.5 text-foreground">
        <button type="button" className={barButton} onClick={toggle} title={playing ? "Pause" : "Play"} aria-label={playing ? "Pause" : "Play"} data-el="video-play">
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground" data-el="video-time">
          {videoTime(time)} / {videoTime(duration)}
        </span>
        <span
          ref={track}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${videoTime(time)} of ${videoTime(duration)}`}
          data-el="video-seek"
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
          onPointerUp={onTrackUp}
          onPointerCancel={onTrackUp}
          className="group/seek relative mx-1 flex h-7 min-w-[48px] flex-1 cursor-pointer touch-none items-center"
        >
          <span className="relative block h-1 w-full overflow-hidden rounded-full bg-muted">
            <span className="absolute inset-y-0 left-0 block bg-foreground/20" style={{ width: `${loaded * 100}%` }} />
            <span className="absolute inset-y-0 left-0 block bg-foreground/80" style={{ width: `${at * 100}%` }} />
          </span>
          <span
            className="pointer-events-none absolute block top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground opacity-0 transition-opacity group-hover/seek:opacity-100"
            style={{ left: `${at * 100}%` }}
          />
        </span>
        <button type="button" className={barButton} onClick={toggleMute} title={muted ? "Unmute" : "Mute"} aria-label={muted ? "Unmute" : "Mute"} data-el="video-mute">
          {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
        </button>
        {extra}
        <button type="button" className={barButton} onClick={toggleFull} title={full ? "Exit full screen" : "Full screen"} aria-label={full ? "Exit full screen" : "Full screen"} data-el="video-full">
          {full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
      </span>
    </span>
  );
}
