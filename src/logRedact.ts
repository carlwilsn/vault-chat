// What may go into a log line (the laptop's app-log and client events, the box's
// turn and board logs, the diag bundle). Logs carry names, ids, counts, timings
// and outcomes — never a key, a token, or what a file or a message says. Every
// writer passes its line through here; the diag bundle passes everything
// through again on the way out.
//
// Two layers:
//   redactText: a secret-looking run inside any string (an OpenRouter or
//     ElevenLabs key, a bearer token, `token=…` in a URL, a JWT, a long base64
//     or hex blob, a data: URL) becomes a marker;
//   safeData:   a value deep-copied for a log — a field named like a secret is
//     dropped to "[redacted]", a field named like content (text, content,
//     prompt, args, result …) becomes its length, other strings are capped.
// Pure: no I/O; shared by the laptop, the board's server route and the box.

const SECRET_KEY = /^(?:authorization|cookie|set-cookie|password|passwd|passphrase|secret|token|apikey|api_key|accesstoken|access_token|refreshtoken|refresh_token|privatekey|private_key|signedurl|signed_url|conversationtoken|conversation_token|.*(?:secret|token|password|apikey|api_key)|.*key)$/i;
const CONTENT_KEY = /^(?:text|content|contents|prompt|preamble|args|arguments|input|output|result|partialresult|delta|body|database64|dataurl|imagedataurl|html|markdown|messages|transcript|summary|recap|thinking|reasoning|context|instructions|code|command|patch|diff|old_string|new_string|oldtext|newtext|value)$/i;

const PATTERNS: [RegExp, string][] = [
  // data: URLs (images pasted, captures): the payload never.
  [/data:([a-z0-9.+/-]*)(;[a-z0-9=;-]*)?,[A-Za-z0-9+/=%_-]{16,}/gi, "data:$1,[redacted]"],
  // Provider keys.
  [/\bsk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/\b(?:xi|el)_[A-Za-z0-9]{24,}/g, "[redacted-key]"],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, "[redacted-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[redacted-key]"],
  [/\bAGE-SECRET-KEY-[A-Z0-9]+/g, "[redacted-key]"],
  // Bearer / Basic credentials.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[redacted-jwt]"],
  // key=value / "key": "value" for secret-named keys (URLs, headers, JSON-ish text).
  [/((?:[?&;\s,{"']|^)(?:[a-z_-]*token|[a-z_-]*secret|password|passwd|api[_-]?key|access[_-]?key|vc_token|signature|sig|auth)["']?\s*[:=]\s*["']?)[^"'\s&,;}]{4,}/gim, "$1[redacted]"],
  // Long opaque runs (base64 / hex blobs of 48+ chars; ids and paths are shorter or have separators).
  [/[A-Za-z0-9+/]{64,}={0,2}/g, "[redacted-blob]"],
  [/\b[a-f0-9]{48,}\b/gi, "[redacted-hex]"],
];

/** A string with every secret-looking run replaced by a marker. */
export function redactText(s: string): string {
  let out = String(s);
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}

/** Cap a string for a log line (after redaction). */
export function capText(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s;
}

/**
 * A copy of `v` safe for a log line: secret-named fields dropped, content-named
 * fields reduced to their size, every string redacted and capped, depth and
 * breadth bounded. Numbers, booleans and null pass as they are.
 */
export function safeData(v: unknown, o: { cap?: number; depth?: number } = {}): unknown {
  const cap = o.cap ?? 300;
  const walk = (x: unknown, depth: number, key: string | null): unknown => {
    if (x === null || x === undefined || typeof x === "number" || typeof x === "boolean") return x;
    if (key !== null && SECRET_KEY.test(key)) return typeof x === "string" && !x ? "" : "[redacted]";
    if (key !== null && CONTENT_KEY.test(key)) {
      if (typeof x === "string") return `[${x.length} chars]`;
      if (Array.isArray(x)) return `[${x.length} items]`;
      if (typeof x === "object") return `[${Object.keys(x as object).length} fields]`;
    }
    if (typeof x === "string") return capText(redactText(x), cap);
    if (typeof x === "bigint") return String(x);
    if (typeof x !== "object") return String(x);
    if (depth >= (o.depth ?? 4)) return Array.isArray(x) ? `[${x.length} items]` : "[object]";
    if (Array.isArray(x)) {
      const out = x.slice(0, 40).map((y) => walk(y, depth + 1, null));
      if (x.length > 40) out.push(`…+${x.length - 40}`);
      return out;
    }
    if (x instanceof Error) return capText(redactText(x.message), cap);
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, y] of Object.entries(x as Record<string, unknown>)) {
      if (++n > 40) {
        out["…"] = `+${Object.keys(x as object).length - 40} fields`;
        break;
      }
      out[k] = walk(y, depth + 1, k);
    }
    return out;
  };
  return walk(v, 0, null);
}

/** One JSONL line, safe: `safeData` of the record (its own top-level fields keep their names; nested values are walked). */
export function safeLine(rec: Record<string, unknown>, o: { cap?: number } = {}): string {
  return JSON.stringify(safeData(rec, { cap: o.cap ?? 300, depth: 5 }));
}
