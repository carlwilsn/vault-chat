export type FileKind =
  | "markdown"
  | "notebook"
  | "pdf"
  | "html"
  | "image"
  | "unsupported"
  | "code";

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tif", "tiff", "heic", "svg",
]);

// Binary formats we don't display inline (video, audio, archives, office,
// etc.). Falls through to UnsupportedView + "open with default app".
const UNSUPPORTED_EXTS = new Set([
  "mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv",
  "mp3", "wav", "flac", "ogg", "m4a", "aac", "wma",
  "zip", "rar", "7z", "tar", "gz", "xz", "bz2", "tgz",
  "docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "odp",
  "psd", "ai", "sketch", "fig",
  "dmg", "msi", "deb", "rpm", "iso", "jar", "app",
  "db", "sqlite", "sqlite3",
]);

export function fileKind(path: string): { kind: FileKind; ext: string } {
  const dot = path.lastIndexOf(".");
  const ext = dot > 0 ? path.slice(dot + 1).toLowerCase() : "";
  if (ext === "md" || ext === "markdown") return { kind: "markdown", ext };
  if (ext === "ipynb") return { kind: "notebook", ext };
  if (ext === "pdf") return { kind: "pdf", ext };
  if (ext === "html" || ext === "htm") return { kind: "html", ext };
  if (IMAGE_EXTS.has(ext)) return { kind: "image", ext };
  if (UNSUPPORTED_EXTS.has(ext)) return { kind: "unsupported", ext };
  return { kind: "code", ext };
}

// True for any file we should not try to load as UTF-8 text. Used by the
// file opener to short-circuit the read and let the viewer show a stub.
export function isUnreadableAsText(path: string): boolean {
  const { kind } = fileKind(path);
  return kind === "pdf" || kind === "image" || kind === "unsupported";
}
