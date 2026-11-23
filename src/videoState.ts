// The videos on screen (the viewer's, a chat message's): each mounted player (src/VideoPlayer.tsx) registers what it
// shows (where it is, playing, muted, full screen) and its own controls, so app/viewer's offers read and run the same
// play / pause / seek / mute / full screen as its bar. A change (play, pause, a seek, the volume, full screen, the end)
// tells the offers' watch; the position while it plays is read when asked (no event per frame).

export type VideoNow = { time: number; duration: number; playing: boolean; muted: boolean; fullscreen: boolean };
export type VideoHandle = {
  /** The vault path (the viewer) or the media address (a chat message). */
  id: string;
  where: "viewer" | "chat";
  now(): VideoNow;
  toggle(): void;
  seekTo(seconds: number): void;
  toggleMute(): void;
  toggleFull(): void;
};

const players = new Set<VideoHandle>();
const fns = new Set<() => void>();

export function registerVideo(h: VideoHandle): () => void {
  players.add(h);
  videoChanged();
  return () => {
    players.delete(h);
    videoChanged();
  };
}

/** Something a player shows changed. */
export function videoChanged(): void {
  for (const f of [...fns]) f();
}
export function onVideoChanged(fn: () => void): () => void {
  fns.add(fn);
  return () => void fns.delete(fn);
}

const r1 = (n: number) => Math.round(n * 10) / 10;
export function videosNow() {
  return [...players].map((p) => {
    const n = p.now();
    return { id: p.id, where: p.where, time: r1(n.time), duration: r1(n.duration), playing: n.playing, muted: n.muted, fullscreen: n.fullscreen };
  });
}

/** The player an action names (its id, or the only / viewer one). */
export function videoNamed(id?: unknown): VideoHandle {
  const all = [...players];
  if (!all.length) throw new Error("no video is on screen");
  if (typeof id === "string" && id) {
    const want = id.replace(/\\/g, "/");
    const hit = all.find((p) => p.id === want || p.id.endsWith(`/${want}`));
    if (!hit) throw new Error(`no video "${id}" on screen (videos: ${all.map((p) => p.id).join(", ")})`);
    return hit;
  }
  return all.find((p) => p.where === "viewer") ?? all[all.length - 1]!;
}
