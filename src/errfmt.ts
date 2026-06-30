// Robust error → human string.
//
// The Vercel AI SDK (and raw provider error bodies) frequently surface a PLAIN
// OBJECT with no string `.message` — e.g. `{ type: "overloaded_error" }` or a
// nested `{ error: { message, type } }` body. The old `err?.message ?? String(err)`
// pattern collapsed those to the useless "[object Object]" the user saw as
// `⚠️ [object Object]` on every crashed worker: a content-free error that says
// nothing about what failed AND looks identical whether the worker died before
// or after doing real work.
//
// This digs the real text out of the shapes we actually get — Error instances,
// API bodies that nest the real error under `.error`, and `.message` fields that
// are themselves objects — falling back to JSON (which at least exposes the
// fields like `type`/`status`) before ever returning "[object Object]".
export function errToString(e: unknown, depth = 0): string {
  if (e == null) return "unknown error";
  if (typeof e === "string") return e.trim() || "unknown error";
  if (typeof e !== "object") return String(e);
  if (depth > 4) return "unknown error";
  const a = e as Record<string, any>;

  // API error bodies commonly nest the real error under `.error`.
  if (a.error != null && a.error !== e) {
    const inner = errToString(a.error, depth + 1);
    if (usable(inner)) return inner;
  }
  // Standard Error / error-like with a string message.
  if (typeof a.message === "string" && a.message.trim()) return a.message.trim();
  // `.message` present but itself an object — the original "[object Object]" source.
  if (a.message != null) {
    const inner = errToString(a.message, depth + 1);
    if (usable(inner)) return inner;
  }
  // Fall back to JSON so at least the fields (type/status/etc.) are visible.
  try {
    const json = JSON.stringify(a, Object.getOwnPropertyNames(a));
    if (json && json !== "{}" && json !== "[]") return json;
  } catch {
    /* circular or non-serializable — fall through */
  }
  try {
    const json = JSON.stringify(a);
    if (json && json !== "{}") return json;
  } catch {
    /* fall through */
  }
  const tag = a.constructor?.name;
  return tag && tag !== "Object" ? `unknown error (${tag})` : "unknown error";
}

function usable(s: string): boolean {
  return !!s && s !== "[object Object]" && s !== "unknown error";
}
