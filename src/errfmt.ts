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
// This digs the real text out of the shapes we actually get:
//   - Error instances (and AggregateError's `.errors`);
//   - the AI SDK's APICallError: `.message` + `.statusCode` + `.responseBody`
//     (a JSON string whose `error.message` is the provider's real reason);
//   - API bodies that nest the real error under `.error`;
//   - `.message` fields that are themselves objects;
//   - `.cause` chains (a "fetch failed" whose cause is ECONNREFUSED);
// and falls back to JSON (which at least exposes fields like `type`/`status`)
// before ever returning "[object Object]". The result is capped so a huge body
// can't flood a thread or a notification.

const MAX_LEN = 2000;
const MAX_DEPTH = 5;

export function errToString(e: unknown): string {
  const s = describe(e, 0, new Set());
  const out = s && usable(s) ? s : "unknown error";
  return out.length > MAX_LEN ? out.slice(0, MAX_LEN - 1) + "…" : out;
}

function describe(e: unknown, depth: number, seen: Set<unknown>): string {
  if (e == null) return "";
  if (typeof e === "string") {
    const t = e.trim();
    // A string that is ALREADY the broken stringification of an object: the
    // information was lost upstream, so say so rather than echo it.
    if (t === "[object Object]") return "unknown error (an error object was stringified before it was reported)";
    return t;
  }
  if (typeof e === "number" || typeof e === "boolean" || typeof e === "bigint") return String(e);
  if (typeof e === "symbol") return e.toString();
  if (typeof e === "function") return `function ${e.name || "(anonymous)"}`;
  if (typeof e !== "object") return "";
  if (depth > MAX_DEPTH || seen.has(e)) return "";
  seen.add(e);
  const a = e as Record<string, any>;

  // 1) The primary message.
  let primary = "";
  if (typeof a.message === "string" && a.message.trim() && a.message.trim() !== "[object Object]") {
    primary = a.message.trim();
  }
  // API error bodies commonly nest the real error under `.error`. It usually
  // says more than a generic wrapper message ("Bad Request"), so it joins it.
  if (a.error != null && a.error !== e) {
    const inner = describe(a.error, depth + 1, seen);
    if (usable(inner)) primary = primary && !inner.includes(primary) ? `${primary}: ${inner}` : inner;
  }
  // `.message` present but itself an object — the original "[object Object]" source.
  if (!primary && a.message != null && typeof a.message !== "string") {
    const inner = describe(a.message, depth + 1, seen);
    if (usable(inner)) primary = inner;
  }
  if (!primary) {
    for (const k of ["reason", "detail", "statusText", "type", "code"]) {
      const v = a[k];
      if (typeof v === "string" && v.trim()) {
        primary = v.trim();
        break;
      }
    }
  }

  // 2) HTTP status (AI SDK APICallError: statusCode; fetch Response: status).
  const status =
    typeof a.statusCode === "number" ? a.statusCode : typeof a.status === "number" ? a.status : undefined;

  // 3) The response body — where the provider's actual reason lives.
  let body = "";
  for (const b of [a.responseBody, a.body, a.data, a.response?.data]) {
    if (b == null) continue;
    body = bodyText(b, depth, seen);
    if (body) break;
  }

  // 4) AggregateError-style lists.
  let list = "";
  if (Array.isArray(a.errors) && a.errors.length) {
    list = a.errors
      .slice(0, 5)
      .map((x: unknown) => describe(x, depth + 1, seen))
      .filter(usable)
      .join("; ");
  }

  // 5) The cause chain.
  let cause = "";
  if (a.cause != null && a.cause !== e) {
    const c = describe(a.cause, depth + 1, seen);
    if (usable(c)) cause = c;
  }

  let out = primary;
  if (status != null && !out.includes(String(status))) out = out ? `${out} (HTTP ${status})` : `HTTP ${status}`;
  if (body && !out.includes(body)) out = out ? `${out}: ${body}` : body;
  if (list && !out.includes(list)) out = out ? `${out} [${list}]` : list;
  if (cause && !out.includes(cause)) out = out ? `${out} (cause: ${cause})` : cause;
  if (usable(out)) return out;

  // 6) Fall back to JSON so at least the fields (type/status/etc.) are visible.
  const json = safeJson(a);
  if (json && json !== "{}" && json !== "[]") return json;
  const tag = a.constructor?.name;
  return tag && tag !== "Object" ? `unknown error (${tag})` : "";
}

function bodyText(b: unknown, depth: number, seen: Set<unknown>): string {
  if (typeof b === "string") {
    const t = b.trim();
    if (!t) return "";
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === "object") {
        const inner = describe(parsed, depth + 1, seen);
        if (usable(inner)) return inner;
      }
    } catch {
      /* not JSON — use the text */
    }
    return t.length > 500 ? t.slice(0, 500) + "…" : t;
  }
  if (typeof b === "object") {
    const inner = describe(b, depth + 1, seen);
    return usable(inner) ? inner : "";
  }
  return "";
}

function safeJson(a: object): string {
  const seen = new WeakSet<object>();
  try {
    const plain: Record<string, unknown> = {};
    for (const k of Object.getOwnPropertyNames(a)) plain[k] = (a as Record<string, unknown>)[k];
    return JSON.stringify(plain, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "function" || typeof v === "symbol") return undefined;
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    return "";
  }
}

function usable(s: string): boolean {
  return !!s && s !== "[object Object]" && s !== "unknown error";
}

// A crash BUBBLE is the assistant content left behind when a turn errored: the
// raw "[object Object]" of a stringified error object, or any text prefixed with
// the ⚠️ warning glyph (the crash lines written in offVaultRun's onEvent error
// handler + catch). Such content is NOT a verified deliverable, so the
// worker-done gate must treat it as a failure even when the persisted `failed`
// flag is missing (historical rows, or an error that arrived as a text event
// rather than an `error` event). Mirrors the inline predicate in context.ts so
// both read the same definition of "crashed".
export function isCrashBubble(content: string | undefined | null): boolean {
  const c = (content ?? "").trim();
  // A ⚠️ error marker at the start OR appended on its own line after some prose
  // (the "…worked a bit, then the turn errored" case). The error appends in
  // offVaultRun always put the marker after a blank line, so a mid-sentence ⚠️
  // in legitimate output won't false-trigger — only a marker that begins a line.
  return c === "[object Object]" || c.startsWith("⚠️") || /\n\s*⚠️/.test(c);
}
