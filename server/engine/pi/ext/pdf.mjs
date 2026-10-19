// PDF pages to the model natively, the way Claude and Claude Code read a PDF:
// the file itself, each page given to the model as its text and its image.
// pi's message types carry text and images only, so PdfPages (the host tool,
// server/engine/extraTools.ts) cuts the asked pages into a small PDF under the
// vault's .vault-chat/local/pdf-pages/ and names it in its result; this hook
// (pi's before_provider_request) attaches that PDF to the request as the
// provider's own document part, on every call that carries the result (as pi
// does with a tool's images):
//  - OpenRouter chat completions: a user message after the tool results with a
//    `file` part (application/pdf). OpenRouter hands it to a model that reads
//    files natively, and parses it itself for one that does not.
//  - Anthropic messages: a `document` block inside the tool_result.
// Only a slice PdfPages wrote is ever read (the path's shape is checked).
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const MARK = /\[PDF pages attached: ([^\]\r\n]+)\]/g;
const SLICE = /[\\/]\.vault-chat[\\/]local[\\/]pdf-pages[\\/][0-9a-f]{16}-p[0-9,-]+\.pdf$/;
const loaded = new Map(); // path → base64 (a slice never changes: its name is its source's hash and pages)

function slicesIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(MARK)) {
    const p = m[1].trim();
    if (!SLICE.test(p) || out.includes(p)) continue;
    let b = loaded.get(p);
    if (b === undefined) {
      try {
        b = readFileSync(p).toString("base64");
      } catch {
        b = null;
      }
      if (b) {
        if (loaded.size > 64) loaded.delete(loaded.keys().next().value);
        loaded.set(p, b);
      }
    }
    if (b) out.push({ path: p, data: b });
  }
  return out;
}

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x?.type === "text" ? x.text : "")).join("\n") : "");

/** The provider payload with each PdfPages slice attached as a native PDF part; undefined when there is none. */
export function withPdfParts(payload) {
  const msgs = payload?.messages;
  if (!Array.isArray(msgs)) return undefined;
  let changed = false;
  const out = [];
  let pending = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m?.role === "tool") {
      // OpenAI chat shape: tool results are their own messages; files go in a user message after the run.
      pending.push(...slicesIn(textOf(m.content)));
      out.push(m);
      if (msgs[i + 1]?.role !== "tool" && pending.length) {
        out.push({ role: "user", content: [{ type: "text", text: "The PDF pages attached by PdfPages:" }, ...pending.map((s) => ({ type: "file", file: { filename: basename(s.path), file_data: `data:application/pdf;base64,${s.data}` } }))] });
        pending = [];
        changed = true;
      }
      continue;
    }
    if (m?.role === "user" && Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result")) {
      // Anthropic shape: a tool_result may hold document blocks itself.
      const content = m.content.map((b) => {
        if (b?.type !== "tool_result") return b;
        const found = slicesIn(textOf(b.content));
        if (!found.length) return b;
        changed = true;
        const prev = typeof b.content === "string" ? [{ type: "text", text: b.content }] : Array.isArray(b.content) ? b.content : [];
        return { ...b, content: [...prev, ...found.map((s) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: s.data } }))] };
      });
      out.push({ ...m, content });
      continue;
    }
    out.push(m);
  }
  return changed ? { ...payload, messages: out } : undefined;
}

export function registerPdfParts(pi) {
  pi.on("before_provider_request", (event) => withPdfParts(event.payload));
}
