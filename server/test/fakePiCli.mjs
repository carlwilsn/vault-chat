// TEST ONLY: a scripted stand-in for pi 1.1.0's RPC mode, for the server tests
// that boot the real bundle where pi cannot run (Windows). It speaks pi's
// protocol as pi's docs define it (rpc.md, rpc-commands.md, json.md): strict
// JSONL on stdio, get_state / prompt / steer / follow_up / abort / clear_queue /
// set_model, extension commands (`/vc-note` → a custom entry), the session file
// in pi's format (entries with id/parentId/timestamp; an assistant message's
// timestamp is the same in its live events and its entry), and the session
// events (agent_start … message_start/update/end with text deltas,
// tool_execution_*, queue delivery, agent_settled). Its model
// is the test's fake OpenRouter (non-streamed chat completions); a reply with
// tool_calls is shown as the tool call and a canned result, then asked again.
// The real pi is exercised on the box (server/test/piEngine.test.ts, and the
// real-pi run against a throwaway instance).
//
// Sessions and tools as pi's CLI takes them (cli.md): --session, --fork (a new
// session holding the other's history, its header naming it as parentSession),
// --no-session (nothing written), --tools (an allowlist: any other tool call is
// refused, as pi would not have declared it) and --no-tools; --system-prompt
// (a file) goes to the model as the system message. Of pi's built-ins only
// `read` runs (a file under the working folder); the others answer a canned line.
// The model is sent the active tools as pi declares them: the built-ins (pi's
// defaults read/bash/edit/write, or the allowlist's) and the extension's
// vault-chat tools ($VC_PI_TOOLS), each only if the allowlist names it.
//
// The extension's "you" layer (ext/vc.mjs, VC_PI_YOU=1) as pi runs it: before
// each prompt, the host call `__you` with `since` from the session's last
// `vc-you` custom message (policy.mjs youSince, the extension's own code); a
// layer comes back as a custom_message entry after the user message, and goes
// to the model as a user message (pi's convertToLlm), now and on every resume.
//
// The extension's before_provider_request (ext/pdf.mjs withPdfParts, its own code)
// rewrites each request as pi would: a PdfPages slice goes as a native PDF part.
//
// Knobs (in the user's message): "[slow]" streams the reply in 30 deltas, 250 ms apart.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
// The extension's own helpers, from where pi is told to load it (`-e <dir>/vc.mjs`, policy.mjs beside it).
const { YOU_TYPE, youSince } = arg("-e")
  ? await import(pathToFileURL(join(dirname(arg("-e")), "policy.mjs")).href)
  : { YOU_TYPE: "vc-you", youSince: () => null };
// pi's before_provider_request as the extension hooks it (pdf.mjs: PdfPages' slices as native PDF parts).
const { withPdfParts } = arg("-e") && existsSync(join(dirname(arg("-e")), "pdf.mjs"))
  ? await import(pathToFileURL(join(dirname(arg("-e")), "pdf.mjs")).href)
  : { withPdfParts: () => undefined };
if (argv.includes("--list-models")) process.exit(0);

const sessionDir = arg("--session-dir") ?? ".";
let model = (arg("--model") ?? "openrouter/test/fake").replace(/^openrouter\//, "");
let file = arg("--session");
const forkOf = arg("--fork");
const ephemeral = argv.includes("--no-session");
const allowed = argv.includes("--no-tools") ? new Set() : arg("--tools") ? new Set(arg("--tools").split(",")) : null;
let system = null;
try {
  if (arg("--system-prompt")) system = readFileSync(arg("--system-prompt"), "utf8");
} catch {}
let sessionId;
const history = [];
/** The session's custom_message entries (the "you" layers), in order. */
const customs = [];
let leaf = null;
const customToHistory = (v) => history.push({ role: "user", content: typeof v.content === "string" ? [{ type: "text", text: v.content }] : v.content ?? [], custom: v.customType });
if (forkOf) {
  // pi's --fork: a new session with the other's entries (the history), its header naming the parent.
  sessionId = randomUUID();
  mkdirSync(sessionDir, { recursive: true });
  file = join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  const lines = [JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd(), parentSession: forkOf })];
  for (const l of readFileSync(forkOf, "utf8").split("\n")) {
    try {
      const v = JSON.parse(l);
      if (v.type === "session") continue;
      if (v.type === "message") history.push(v.message);
      if (v.type === "custom_message") {
        customs.push(v);
        customToHistory(v);
      }
      if (v.id) leaf = v.id;
      lines.push(l);
    } catch {}
  }
  writeFileSync(file, lines.join("\n") + "\n");
} else if (ephemeral) {
  sessionId = randomUUID();
  file = undefined;
} else if (file && existsSync(file)) {
  sessionId = /_([^_]+)\.jsonl$/.exec(file)?.[1] ?? randomUUID();
  for (const l of readFileSync(file, "utf8").split("\n")) {
    try {
      const v = JSON.parse(l);
      if (v.type === "message") history.push(v.message);
      if (v.type === "custom_message") {
        customs.push(v);
        customToHistory(v);
      }
      if (v.id) leaf = v.id;
    } catch {}
  }
} else {
  sessionId = randomUUID();
  mkdirSync(sessionDir, { recursive: true });
  file = join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\n");
}
const append = (e) => {
  const entry = { ...e, id: randomUUID().slice(0, 8), parentId: leaf, timestamp: new Date().toISOString() };
  leaf = entry.id;
  if (file) appendFileSync(file, JSON.stringify(entry) + "\n");
};
const record = (message) => {
  history.push(message);
  append({ type: "message", message });
};

let key = "";
try {
  key = readFileSync(3, "utf8").trim();
} catch {}

let baseUrl = "https://openrouter.ai/api/v1";
try {
  const m = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR ?? ".", "models.json"), "utf8"));
  baseUrl = m?.providers?.openrouter?.baseUrl ?? baseUrl;
} catch {}

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUILTINS = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);
/** The tools pi declares to the model: its built-ins and the extension's, filtered by --tools. */
const declared = (() => {
  let specs = [];
  try {
    specs = process.env.VC_PI_TOOLS ? JSON.parse(readFileSync(process.env.VC_PI_TOOLS, "utf8")) : [];
  } catch {}
  const builtins = [...BUILTINS].filter((n) => (allowed ? allowed.has(n) : ["read", "bash", "edit", "write"].includes(n)));
  const host = specs.filter((t) => t && typeof t.name === "string" && (!allowed || allowed.has(t.name)));
  return [
    ...builtins.map((name) => ({ type: "function", function: { name, description: `pi's ${name}`, parameters: { type: "object", properties: {} } } })),
    ...host.map((t) => ({ type: "function", function: { name: t.name, description: String(t.description ?? t.name), parameters: t.inputSchema ?? { type: "object", properties: {} } } })),
  ];
})();
const uiWaiters = new Map();
let uiSeq = 0;
/** A vault-chat tool, as its extension calls the host: an editor dialog titled vc:host-call. */
function hostCall(tool, args) {
  const id = `ui-${++uiSeq}`;
  out({ type: "extension_ui_request", id, method: "editor", title: "vc:host-call", prefill: JSON.stringify({ tool, args }) });
  return new Promise((resolve) => {
    uiWaiters.set(id, (v) => {
      try {
        const j = JSON.parse(v ?? "{}");
        resolve({ text: String(j.text ?? ""), isError: !!j.isError });
      } catch {
        resolve({ text: String(v ?? ""), isError: false });
      }
    });
  });
}

/** The extension's before_agent_start: the host's "you" layer since this session last saw it, or null. */
async function youLayer() {
  if (process.env.VC_PI_YOU !== "1") return null;
  const id = `ui-${++uiSeq}`;
  const since = youSince(customs);
  out({ type: "extension_ui_request", id, method: "editor", title: "vc:host-call", prefill: JSON.stringify({ tool: "__you", args: { since } }) });
  const v = await new Promise((resolve) => uiWaiters.set(id, resolve));
  try {
    const r = JSON.parse(v ?? "null");
    return r && typeof r.text === "string" && r.text.trim() && Number.isFinite(Number(r.until)) ? { text: r.text, until: Number(r.until), since } : null;
  } catch {
    return null;
  }
}

function readTool(a) {
  try {
    return { text: readFileSync(join(process.cwd(), String(a?.path ?? "")), "utf8"), isError: false };
  } catch (e) {
    return { text: String(e?.message ?? e), isError: true };
  }
}

let running = false;
let aborted = false;
let steering = [];
let followUp = [];

async function callModel() {
  const messages = (system ? [{ role: "system", content: system }] : []).concat(history).map((m) => ({ role: m.role === "toolResult" ? "tool" : m.role, content: typeof m.content === "string" ? m.content : (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n"), ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}) }));
  const payload = { model, messages, stream: true, ...(declared.length ? { tools: declared } : {}) };
  const r = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(withPdfParts(payload) ?? payload) });
  const body = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${body.slice(0, 200)}`);
  if (!body.startsWith("data:")) {
    try {
      return JSON.parse(body)?.choices?.[0]?.message ?? { content: "" };
    } catch {
      return { content: "" };
    }
  }
  // Server-sent chunks: the content and the tool calls, put together.
  let content = "";
  const calls = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
    let ch;
    try {
      ch = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    const d = ch?.choices?.[0]?.delta ?? {};
    if (typeof d.content === "string") content += d.content;
    for (const t of d.tool_calls ?? []) {
      const c = (calls[t.index ?? 0] ??= { id: t.id, type: "function", function: { name: "", arguments: "" } });
      if (t.id) c.id = t.id;
      if (t.function?.name) c.function.name += t.function.name;
      if (t.function?.arguments) c.function.arguments += t.function.arguments;
    }
  }
  return { content, ...(calls.length ? { tool_calls: calls.filter(Boolean) } : {}) };
}

let lastTs = 0;
/** pi's message timestamps (ms; unique here, as an assistant message's blocks are named by it). */
const stamp = () => (lastTs = Math.max(Date.now(), lastTs + 1));

async function streamText(text, ci, slow) {
  out({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: ci } });
  const n = slow ? 30 : 3;
  const size = Math.max(1, Math.ceil(text.length / n));
  for (let i = 0; i < text.length; i += size) {
    if (aborted) return false;
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: ci, delta: text.slice(i, i + size) } });
    if (slow) await sleep(250);
  }
  out({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: ci, content: text } });
  return true;
}

function deliver(list) {
  for (const m of list.splice(0)) {
    const msg = { role: "user", content: [{ type: "text", text: m.message }], timestamp: stamp() };
    out({ type: "message_start", message: msg });
    out({ type: "message_end", message: msg });
    record(msg);
  }
  out({ type: "queue_update", steering: steering.map((x) => x.message), followUp: followUp.map((x) => x.message) });
}

async function run(first) {
  running = true;
  aborted = false;
  out({ type: "agent_start" });
  const slow = /\[slow\]/.test(first);
  const you = await youLayer();
  const u = { role: "user", content: [{ type: "text", text: first }], timestamp: stamp() };
  out({ type: "turn_start" });
  out({ type: "message_start", message: u });
  out({ type: "message_end", message: u });
  record(u);
  if (you) {
    // pi: the user message, then before_agent_start's custom message (stored, sent to the model, not shown).
    const c = { type: "custom_message", customType: YOU_TYPE, content: you.text, display: false, details: { until: you.until, since: you.since } };
    append(c);
    customs.push(c);
    customToHistory(c);
    const m = { role: "custom", customType: YOU_TYPE, content: you.text, display: false, timestamp: stamp() };
    out({ type: "message_start", message: m });
    out({ type: "message_end", message: m });
  }
  try {
    for (let step = 0; step < 12 && !aborted; step++) {
      const reply = await callModel();
      if (aborted) break;
      const text = String(reply.content ?? "");
      const calls = Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
      const ts = stamp();
      out({ type: "message_start", message: { role: "assistant", content: [], timestamp: ts } });
      const content = [];
      if (text) {
        if (!(await streamText(text, 0, slow))) {
          // Stopped mid-stream: pi ends the message as aborted and writes it.
          const am = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "aborted", timestamp: ts };
          out({ type: "message_end", message: am });
          record(am);
          break;
        }
        content.push({ type: "text", text });
      }
      calls.forEach((c, i) => {
        const args = (() => {
          try {
            return JSON.parse(c.function?.arguments ?? "{}");
          } catch {
            return {};
          }
        })();
        const ci = content.length;
        out({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: ci, id: c.id, toolName: c.function?.name } });
        out({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: ci, delta: c.function?.arguments ?? "{}" } });
        const tc = { type: "toolCall", id: c.id, name: c.function?.name, arguments: args };
        out({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: ci, toolCall: tc } });
        content.push(tc);
        void i;
      });
      const am = { role: "assistant", content, stopReason: calls.length ? "toolUse" : "stop", usage: { input: 1200, output: 40, cacheRead: 0, cacheWrite: 0 }, timestamp: ts };
      out({ type: "message_end", message: am });
      record(am);
      for (const tc of content.filter((c) => c.type === "toolCall")) {
        out({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });
        // vault-chat's own tools are host calls (its extension's editor dialog, ext/vc.mjs); of pi's built-ins only read runs.
        const host = !BUILTINS.has(tc.name);
        const r =
          allowed && !allowed.has(tc.name)
            ? { text: `Tool ${tc.name} not found`, isError: true }
            : host
              ? await hostCall(tc.name, tc.arguments)
              : tc.name === "read"
                ? readTool(tc.arguments)
                : { text: `(fake pi: ${tc.name} not run)`, isError: false };
        const result = { content: [{ type: "text", text: r.text }], details: {} };
        out({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError: !!r.isError });
        record({ role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: result.content, isError: !!r.isError, timestamp: stamp() });
      }
      out({ type: "turn_end", message: am, toolResults: [] });
      if (steering.length) {
        deliver(steering);
        continue;
      }
      if (calls.length) continue;
      if (followUp.length) {
        // One follow-up at a time (pi's default followUpMode), when the agent would stop.
        deliver(followUp.splice(0, 1));
        continue;
      }
      break;
    }
  } catch (e) {
    const am = { role: "assistant", content: [], stopReason: "error", errorMessage: String(e?.message ?? e), timestamp: stamp() };
    out({ type: "message_start", message: am });
    out({ type: "message_end", message: am });
    record(am);
  }
  out({ type: "agent_end", messages: [], willRetry: false });
  running = false;
  const wasAborted = aborted;
  out({ type: "agent_settled", aborted: wasAborted });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, "");
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));

function respond(c, ok, data, error) {
  out({ ...(c.id ? { id: c.id } : {}), type: "response", command: c.type, success: ok, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });
}

function handle(line) {
  let c;
  try {
    c = JSON.parse(line);
  } catch {
    return out({ type: "response", command: "parse", success: false, error: "Failed to parse command" });
  }
  switch (c.type) {
    case "extension_ui_response": {
      const w = uiWaiters.get(c.id);
      uiWaiters.delete(c.id);
      w?.(c.value);
      return;
    }
    case "get_state":
      return respond(c, true, { sessionId, sessionFile: file, isStreaming: running, steeringMode: "all", followUpMode: "one-at-a-time", messageCount: history.length, pendingMessageCount: steering.length + followUp.length });
    case "set_model":
      model = c.modelId;
      return respond(c, true, { id: model });
    case "prompt":
      // An extension command runs at once, streaming or not (ext/vc.mjs's /vc-note: a custom entry).
      if (String(c.message ?? "").startsWith("/vc-note ")) {
        try {
          const d = JSON.parse(String(c.message).slice("/vc-note ".length));
          if (d && typeof d.kind === "string") append({ type: "custom", customType: "vc-note", data: d });
        } catch {}
        return respond(c, true);
      }
      if (running) {
        if (c.streamingBehavior === "steer") steering.push({ message: c.message });
        else if (c.streamingBehavior === "followUp") followUp.push({ message: c.message });
        else return respond(c, false, undefined, "Agent is streaming; specify streamingBehavior");
        return respond(c, true, { disposition: "queued" });
      }
      respond(c, true, { disposition: "started" });
      void run(String(c.message ?? ""));
      return;
    case "steer":
      steering.push({ message: c.message });
      out({ type: "queue_update", steering: steering.map((x) => x.message), followUp: followUp.map((x) => x.message) });
      return respond(c, true, { disposition: "queued" });
    case "follow_up":
      followUp.push({ message: c.message });
      out({ type: "queue_update", steering: steering.map((x) => x.message), followUp: followUp.map((x) => x.message) });
      return respond(c, true, { disposition: "queued" });
    case "clear_queue": {
      const data = { steering: steering.map((x) => x.message), followUp: followUp.map((x) => x.message) };
      steering = [];
      followUp = [];
      return respond(c, true, data);
    }
    case "abort":
      aborted = true;
      return respond(c, true);
    case "get_last_assistant_text": {
      const last = [...history].reverse().find((m) => m.role === "assistant");
      const text = last ? (last.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("") : null;
      return respond(c, true, { text: text || null });
    }
    default:
      return respond(c, true);
  }
}
