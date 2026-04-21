import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// MIME type for a given image extension so the <img src="data:..."> tag
// actually renders rather than downloading.
function mimeFor(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "png") return "image/png";
  if (e === "gif") return "image/gif";
  if (e === "webp") return "image/webp";
  if (e === "bmp") return "image/bmp";
  if (e === "ico") return "image/x-icon";
  if (e === "tif" || e === "tiff") return "image/tiff";
  if (e === "heic") return "image/heic";
  if (e === "svg") return "image/svg+xml";
  return "application/octet-stream";
}

export function ImageView({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    (async () => {
      try {
        const bytes = await invoke<number[]>("read_binary_file", { path });
        if (cancelled) return;
        const dot = path.lastIndexOf(".");
        const ext = dot > 0 ? path.slice(dot + 1) : "";
        const blob = new Blob([new Uint8Array(bytes)], { type: mimeFor(ext) });
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-destructive text-sm p-8">
        Failed to load image: {error}
      </div>
    );
  }
  if (!url) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-8">
        Loading image…
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto bg-muted/20 flex items-center justify-center p-4">
      <img
        src={url}
        alt={path.split("/").pop() ?? "image"}
        className="max-w-full max-h-full object-contain"
      />
    </div>
  );
}
