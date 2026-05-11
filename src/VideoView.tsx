import { convertFileSrc } from "@tauri-apps/api/core";

// Streams the file via Tauri's asset:// protocol so the browser does
// range-request seeking and buffered playback — no read-whole-file
// into memory like ImageView does. WebView2 decodes H.264/AAC natively;
// other codecs may fail to decode and the player will show its built-in
// error state.
export function VideoView({ path }: { path: string }) {
  const src = convertFileSrc(path);
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-black">
      <video
        key={path}
        src={src}
        controls
        preload="metadata"
        className="flex-1 min-h-0 w-full object-contain"
      />
    </div>
  );
}
