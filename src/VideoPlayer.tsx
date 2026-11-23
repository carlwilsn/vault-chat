import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize2, Minimize2 } from "lucide-react";
import { cn } from "./lib/utils";
import { hit } from "./shortcuts";
import { registerVideo, videoChanged } from "./videoState";

// The app's own video player: the browser's default controls (a different
// look in every webview) are replaced by a quiet bar in vault-chat's style,
// the same in the chat and in the viewer. No autoplay: Carl's own Play starts
// video and audio together. Every element is phrasing content (spans), because
// a video in a chat sits inside a markdown paragraph.
// In the viewer and in full screen the bar lies over the picture and, while
// the video plays, fades out with the cursor after VIDEO_IDLE_MS without a
// mouse move, tap or key (back on the next one), as on YouTube.
// The moves are heard on the document itself (capture phase) and placed by
// where they land, not by handlers on the player's own elements: an element
// that stops a move on its way up, a layer laid over the pane, the bar turning
// pointer-events:none under the cursor, or the full-screen element changing
// can then never keep the bar from coming back.

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

/** How long the pointer may rest on a playing video before its bar and cursor fade away. */
export const VIDEO_IDLE_MS = 2500;

/**
 * Like YouTube: the bar hides only while the video plays, the pointer has
 * rested for VIDEO_IDLE_MS, and it is neither over the bar nor dragging the
 * seek track. Paused, the bar always shows.
 */
export function videoBarHidden(s: { playing: boolean; idle: boolean; overBar: boolean; dragging: boolean }): boolean {
  return s.playing && s.idle && !s.overBar && !s.dragging;
}

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/** A point inside a box laid out on screen (an unlaid box, 0 × 0, holds nothing). */
export function inBox(x: number, y: number, r: Box | null | undefined): boolean {
  return !!r && r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
}

/**
 * Where a pointer event lands for the auto-hiding bar: "in" the player (wake
 * the bar), "out" of it (a mouse that left a playing video hides the bar), or
 * "none" (no place to judge by). Its target inside the player counts first;
 * otherwise its point against the player's box (a layer laid over the player
 * still has the pointer "in" it).
 */
export function pointerPlace(
  e: { target: unknown; clientX?: number; clientY?: number },
  player: { contains(n: unknown): boolean; getBoundingClientRect?(): Box },
): "in" | "out" | "none" {
  if (e.target && player.contains(e.target)) return "in";
  if (typeof e.clientX !== "number" || typeof e.clientY !== "number") return "none";
  const r = player.getBoundingClientRect?.();
  if (!r || !(r.width > 0)) return "none";
  return inBox(e.clientX, e.clientY, r) ? "in" : "out";
}

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };

/**
 * The idle clock: poke() on every mouse move, tap or key says "awake" and
 * restarts the count; after `ms` without a poke it says "idle"; sleep() says
 * idle at once (the pointer left). onChange hears each change once.
 */
export function idleWatch(
  ms: number,
  onChange: (idle: boolean) => void,
  timers: Timers = { set: (fn, t) => setTimeout(fn, t), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
) {
  let timer: unknown = null;
  let idle = false;
  const to = (v: boolean) => {
    if (idle !== v) {
      idle = v;
      onChange(v);
    }
  };
  const cancel = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  return {
    poke() {
      to(false);
      cancel();
      timer = timers.set(() => {
        timer = null;
        to(true);
      }, ms);
    },
    sleep() {
      cancel();
      to(true);
    },
    stop: cancel,
  };
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
  idleMs = VIDEO_IDLE_MS,
  stateId,
}: {
  src: string;
  /** Who it is in the videos state (src/videoState.ts): the viewer's vault path; a chat's video: its address. */
  stateId?: string;
  title?: string;
  /** The viewer: the video takes the whole pane. Without it (a chat), it is as wide as its message allows. */
  fill?: boolean;
  className?: string;
  /** `data-el` of the <video> itself (tests and RecordUI find it by this). */
  dataEl?: string;
  onError?: () => void;
  /** More controls at the right of the bar (the viewer's "system player"). */
  extra?: ReactNode;
  /** How long a resting pointer keeps the bar (tests shorten it). */
  idleMs?: number;
}) {
  const wrap = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  const [full, setFull] = useState(false);
  const dragging = useRef(false);
  // Auto-hiding bar (the viewer and full screen only: a chat's video keeps its bar).
  const autoHide = fill || full;
  const [idle, setIdle] = useState(false);
  const [overBar, setOverBar] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const watch = useRef<ReturnType<typeof idleWatch> | null>(null);
  if (!watch.current) watch.current = idleWatch(idleMs, setIdle);
  const wake = useCallback(() => watch.current?.poke(), []);
  useEffect(() => () => watch.current?.stop(), []);
  const hidden = autoHide && videoBarHidden({ playing, idle, overBar, dragging: seeking });

  // Every move, tap, wheel or touch anywhere in the document, heard first (capture) and placed by where it lands.
  useEffect(() => {
    if (!autoHide) return;
    const w = wrap.current;
    const doc = w?.ownerDocument;
    if (!w || !doc) return;
    // Over the bar by where the pointer is when the bar is laid out: a scrub keeps its events on the seek track
    // (pointer capture) while the pointer is over the picture, and judging by the target left the bar shown for good
    // once the scrub was let go there. By the target only when there is no point or no layout to judge by.
    const onBar = (e: Event) => {
      const b = bar.current;
      if (!b) return false;
      const m = e as MouseEvent;
      const r = b.getBoundingClientRect?.();
      if (typeof m.clientX === "number" && typeof m.clientY === "number" && r && r.width > 0 && r.height > 0) return inBox(m.clientX, m.clientY, r);
      return b.contains(e.target as Node);
    };
    const onMove = (e: Event) => {
      const where = pointerPlace(e as MouseEvent, w);
      if (where === "in") {
        wake();
        setOverBar(onBar(e));
      } else if (where === "out" && (e as Event & { pointerType?: string }).pointerType !== "touch") {
        // A mouse that left a playing video takes the bar with it at once.
        setOverBar(false);
        watch.current?.sleep();
      }
    };
    const onTouch = (e: Event) => {
      if (pointerPlace(e as MouseEvent, w) === "in") wake();
    };
    const onOut = (e: Event) => {
      // The mouse left the window itself.
      const p = e as Event & { pointerType?: string; relatedTarget?: unknown };
      if (!p.relatedTarget && p.pointerType === "mouse" && w.contains(p.target as Node)) {
        setOverBar(false);
        watch.current?.sleep();
      }
    };
    const opts = { capture: true, passive: true } as const;
    const moves = ["pointermove", "mousemove"] as const;
    const taps = ["pointerdown", "mousedown", "touchstart", "wheel"] as const;
    for (const t of moves) doc.addEventListener(t, onMove, opts);
    for (const t of taps) doc.addEventListener(t, onTouch, opts);
    doc.addEventListener("pointerout", onOut, opts);
    return () => {
      for (const t of moves) doc.removeEventListener(t, onMove, opts);
      for (const t of taps) doc.removeEventListener(t, onTouch, opts);
      doc.removeEventListener("pointerout", onOut, opts);
    };
  }, [autoHide, wake]);

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
    setSeeking(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    seekAt(e.clientX);
  };
  const onTrackMove = (e: PointerEvent<HTMLSpanElement>) => {
    if (dragging.current) seekAt(e.clientX);
  };
  const onTrackUp = (e: PointerEvent<HTMLSpanElement>) => {
    dragging.current = false;
    setSeeking(false);
    wake();
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

  // What it shows and its controls, for app/viewer's videos state and its video action (the same toggle, seek, mute
  // and full screen as the bar).
  const live = useRef({ toggle, seekTo, toggleMute, toggleFull });
  live.current = { toggle, seekTo, toggleMute, toggleFull };
  useEffect(
    () =>
      registerVideo({
        id: stateId ?? src,
        where: fill ? "viewer" : "chat",
        now: () => {
          const v = video.current;
          return { time: v?.currentTime ?? 0, duration: v && Number.isFinite(v.duration) ? v.duration : 0, playing: !!v && !v.paused && !v.ended, muted: !!v?.muted, fullscreen: document.fullscreenElement === wrap.current };
        },
        toggle: () => live.current.toggle(),
        seekTo: (s) => live.current.seekTo(s),
        toggleMute: () => live.current.toggleMute(),
        toggleFull: () => live.current.toggleFull(),
      }),
    [stateId, src, fill],
  );
  useEffect(() => videoChanged(), [playing, muted, full, duration]);

  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    wake();
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
      // Keyboard focus on the player or any of its buttons brings the bar back.
      onFocus={wake}
      data-chrome={autoHide ? (hidden ? "hidden" : "shown") : undefined}
      className={cn(
        "flex flex-col overflow-hidden bg-black focus-visible:outline-none",
        hidden && "cursor-none",
        fill || full ? "relative h-full w-full min-h-0 flex-1" : "inline-flex max-w-full rounded-md border border-border/60 align-top",
        className,
      )}
    >
      <video data-offer="app/viewer.video"
        ref={video}
        src={src}
        title={title}
        data-el={dataEl}
        playsInline
        preload="metadata"
        onClick={toggle}
        onDoubleClick={toggleFull}
        onPlay={() => {
          setPlaying(true);
          wake();
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onSeeked={() => videoChanged()}
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
        className={cn("block bg-black", hidden ? "cursor-none" : "cursor-pointer", fill || full ? "min-h-0 w-full flex-1 object-contain" : "max-h-[70vh] max-w-full")}
      />
      <span
        ref={bar}
        data-el="video-bar"
        className={cn(
          "flex h-9 shrink-0 items-center gap-1.5 border-t border-border/60 bg-card px-1.5 text-foreground",
          // Over the picture (so hiding it never resizes the video), fading like YouTube's.
          // Its own compositor layer ([will-change:opacity]): coming back is an opacity change over the playing video only.
          autoHide && "absolute inset-x-0 bottom-0 z-10 transition-opacity duration-300 [will-change:opacity]",
          hidden && "pointer-events-none opacity-0",
        )}
      >
        <button data-offer="app/viewer.video" type="button" className={barButton} onClick={toggle} title={playing ? "Pause" : "Play"} aria-label={playing ? "Pause" : "Play"} data-el="video-play">
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
          onLostPointerCapture={() => {
            if (!dragging.current) return;
            dragging.current = false;
            setSeeking(false);
            wake();
          }}
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
        <button data-offer="app/viewer.video" type="button" className={barButton} onClick={toggleMute} title={muted ? "Unmute" : "Mute"} aria-label={muted ? "Unmute" : "Mute"} data-el="video-mute">
          {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
        </button>
        {extra}
        <button data-offer="app/viewer.video" type="button" className={barButton} onClick={toggleFull} title={full ? "Exit full screen" : "Full screen"} aria-label={full ? "Exit full screen" : "Full screen"} data-el="video-full">
          {full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
      </span>
    </span>
  );
}
