export type FileKind =
  | "markdown"
  | "notebook"
  | "pdf"
  | "html"
  | "unsupported"
  | "code";

// Extensions we refuse to load as text — they're binary formats where the
// app has no built-in viewer, so the fallback is to hand the file off to
// the user's OS via "reveal in file explorer" / "open with default app".
const UNSUPPORTED_EXTS = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tif", "tiff", "heic",
  "svg", // svg is technically text but we don't render it inline today
  // video
  "mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv",
  // audio
  "mp3", "wav", "flac", "ogg", "m4a", "aac", "wma",
  // archives
  "zip", "rar", "7z", "tar", "gz", "xz", "bz2", "tgz",
  // office / design
  "docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "odp",
  "psd", "ai", "sketch", "fig",
  // executables / binaries
  "exe", "dll", "dylib", "so", "app", "dmg", "msi", "deb", "rpm",
  "bin", "iso", "class", "jar",
  // db
  "db", "sqlite", "sqlite3",
]);

export function fileKind(path: string): { kind: FileKind; ext: string } {
  const dot = path.lastIndexOf(".");
  const ext = dot > 0 ? path.slice(dot + 1).toLowerCase() : "";
  if (ext === "md" || ext === "markdown") return { kind: "markdown", ext };
  if (ext === "ipynb") return { kind: "notebook", ext };
  if (ext === "pdf") return { kind: "pdf", ext };
  if (ext === "html" || ext === "htm") return { kind: "html", ext };
  if (UNSUPPORTED_EXTS.has(ext)) return { kind: "unsupported", ext };
  return { kind: "code", ext };
}

// True for any file we should not try to load as UTF-8 text. Used by the
// file opener to short-circuit the read and let the viewer show a stub.
export function isUnreadableAsText(path: string): boolean {
  const { kind } = fileKind(path);
  return kind === "pdf" || kind === "unsupported";
}
