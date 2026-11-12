import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ExternalLink, FolderOpen, Film } from "lucide-react";
import { openPathWithDefaultApp, revealInFileExplorer } from "./opener";
import { VideoPlayer } from "./VideoPlayer";

// Streams the file via Tauri's asset:// protocol so the browser does
// range-request seeking and buffered playback.
//
// Codec notes (cross-platform reality):
//   Windows  — WebView2 decodes H.264/AAC natively. mp4/mov/m4v/mkv all work.
//   Linux    — WebKit/GTK ships without proprietary codecs by default (patent
//              licensing). H.264 mp4s silently fail unless the user has
//              installed `gstreamer1.0-libav` or similar codec packs. VP8/VP9
//              webm files play fine everywhere (free codecs).
//   macOS    — WebKit has H.264 natively.
//
// When the browser can't decode the file we show a clear "can't play" notice
// with an "open with default app" button — xdg-open (Linux) / Finder (macOS)
// / Explorer (Windows) will hand it off to VLC/mpv/QuickTime/etc.
export function VideoView({ path }: { path: string }) {
  const src = convertFileSrc(path);
  const name = path.split("/").pop() ?? path;
  const ext = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";

  const [codecError, setCodecError] = useState(false);

  const openWith = () =>
    openPathWithDefaultApp(path).catch((e) =>
      console.error("[opener] open failed:", e),
    );
  const reveal = () =>
    revealInFileExplorer(path).catch((e) =>
      console.error("[opener] reveal failed:", e),
    );

  // H.264-family codecs that commonly fail on Linux without proprietary packs.
  const likelyH264 = ["mp4", "mov", "m4v", "mkv", "m4v"].includes(ext);

  if (codecError) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 bg-muted/10">
        <div className="max-w-md w-full flex flex-col items-center gap-4 text-center">
          <div className="h-16 w-16 rounded-lg bg-muted/60 border border-border flex items-center justify-center">
            <Film className="h-8 w-8 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <div className="text-[14px] font-medium text-foreground break-all">{name}</div>
            {ext && (
              <div className="text-[11px] text-muted-foreground font-mono uppercase">
                {ext} video
              </div>
            )}
            <div className="text-[12px] text-muted-foreground pt-1 leading-relaxed">
              {likelyH264
                ? "This machine's browser can't decode H.264 video. Install GStreamer codec packs or open with your system player."
                : "This browser can't play this video format. Open it with your system player instead."}
            </div>
          </div>
          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={openWith}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border bg-card hover:bg-accent/60 text-[12px] text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open with system player
            </button>
            <button
              onClick={reveal}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border bg-card hover:bg-accent/60 text-[12px] text-foreground"
            >
              <FolderOpen className="h-3.5 w-3.5" /> Show in explorer
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-black">
      <VideoPlayer
        key={path}
        src={src}
        fill
        dataEl="viewer-video"
        onError={() => setCodecError(true)}
        extra={
          // Escape hatch even when the video loads: open it in VLC and the like
          // without navigating away from the vault.
          <button
            type="button"
            onClick={openWith}
            title="Open with system player"
            aria-label="Open with system player"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        }
      />
    </div>
  );
}
