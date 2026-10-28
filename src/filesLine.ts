// The "[files: a | b]" line a message with attached files carries at its end: the names its bubble
// shows as chips (laptop ChatPane, phone boot.ts). The box keeps the text as sent; the files
// themselves go by their path on the box (POST /api/v2/attachment, server/attachments.ts).

/** The line for these names (empty when none). */
export function filesLine(names: string[]): string {
  return names.length > 0 ? `\n\n[files: ${names.map((n) => n.replace(/[\]|\n]/g, " ")).join(" | ")}]` : "";
}

/** A message's text and the names on its files line. */
export function splitFilesLine(src: string): { text: string; files: string[] } {
  const m = /\n*\[files: ([^\]]*)\]\s*$/.exec(src);
  if (!m) return { text: src, files: [] };
  return { text: src.slice(0, m.index), files: m[1]!.split(" | ").map((x) => x.trim()).filter(Boolean) };
}
