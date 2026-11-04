// An image file's MIME type by its extension (null: not an image a model can see).
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function imageMime(path: string): string | null {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  return MIME[ext] ?? null;
}
