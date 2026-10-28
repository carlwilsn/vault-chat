// vault-chat's extension for pi (loaded with `-e`, through jiti). It is the
// pi side of server/engine/pi: it never sees a conversation file; everything
// that touches vault-chat state uses native MCP or a private context service.
//
//  - the OpenRouter key arrives on fd 3 (never env/argv) and is set as a
//    runtime key in-process (a TypeScript-private API: pi is pinned);
//  - all host and filesystem tools use pi's builtin:mcp (no duplicate native
//    read/write/edit/bash tools). The shared server applies the existing path
//    guards, write authorization, env scrubbing and bubblewrap sandbox;
//  - vault-chat's tools use pi's builtin:mcp, registered as a server in memory
//    from a process-scoped capability delivered on fd 4 (no UI bridge);
//  - the ledger: OpenRouter's generation id (x-generation-id) and the cost it
//    reports in the stream go into the session as `vc-cost` entries (the host
//    sees them live as `entry_appended`);
//  - the "you" layer (VC_PI_YOU=1: conversations and Ctrl+K / Ctrl+L): before
//    each prompt the host is asked what Carl did since this session last saw
//    it, and pi stores and sends it as a `vc-you` custom message;
//  - Gemini requests get cache_control markers;
//  - the host advertises its single subagent orchestration tool for parents.
import { closeSync, readFileSync } from "node:fs";
import { registerPdfParts } from "./pdf.mjs";
import { CLEAR_TYPE, VOICE_TYPE, YOU_TYPE, addCacheMarkers, memoryCapNote, costFromStreamEvent, voiceLineContent, youSince } from "./policy.mjs";

const E = process.env;

function readKeyOnce() {
  const g = globalThis;
  if (g.__vcKeyRead) return g.__vcKey ?? null;
  g.__vcKeyRead = true;
  const fd = Number(E.VC_KEY_FD);
  if (!Number.isInteger(fd) || fd < 3) return null;
  let key = null;
  try {
    key = readFileSync(fd, "utf8").trim() || null;
  } catch {
    key = null;
  }
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
  g.__vcKey = key;
  return key;
}

const json = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

export default function vaultChat(pi) {
  // A private one-shot bootstrap pipe: never model context, environment, argv,
  // persisted config or shell descendants. Native pi owns all MCP tool calls.
  if (!globalThis.__vcBootstrap) {
    try { globalThis.__vcBootstrap = JSON.parse(readFileSync(4, "utf8")); }
    finally { try { closeSync(4); } catch { /* closed */ } }
  }
  const bootstrap = globalThis.__vcBootstrap;
  if (bootstrap.tools) pi.registerMcpServer("vault_chat", {
    url: bootstrap.url, headers: { Authorization: bootstrap.authorization }, exposure: "direct", timeout: 4 * 3600,
  });
  const service = async (name, args = {}) => {
    const response = await fetch(new URL(`/context/${name}`, bootstrap.url), {
      method: "POST", headers: { Authorization: bootstrap.authorization, "Content-Type": "application/json" },
      body: JSON.stringify(args), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Private ${name} service unavailable`);
    return response.json();
  };
  const key = readKeyOnce();
  if (key) {
    pi.on("session_start", async (_e, ctx) => {
      await ctx.modelRegistry.runtime.setRuntimeApiKey("openrouter", key);
    });
  }

  // Filesystem tools, guarded writes and sandboxed bash are supplied only by
  // the shared MCP server. No process-native duplicate authorization path.

  // ---- memory near its cap: the write's own result says so (Claude Code's near-cap reminder) ----
  pi.on("tool_result", async (event, ctx) => {
    const note = memoryCapNote(event.toolName.replace(/^mcp__vault_chat__/, ""), event.input, ctx?.cwd || process.cwd(), (p) => readFileSync(p, "utf8"));
    if (!note || event.isError) return undefined;
    return { content: [...(event.content ?? []), { type: "text", text: note }] };
  });

  // ---- PdfPages: the asked pages go to the model as a native PDF part (pdf.mjs) ------
  registerPdfParts(pi);

  // ---- the ledger: OpenRouter's own numbers, per model call ---------------------------
  let pending = null;
  const flush = () => {
    const p = pending;
    pending = null;
    if (!p || (!p.genId && p.cost === null)) return;
    try {
      pi.appendEntry("vc-cost", { genId: p.genId, cost: p.cost, model: p.model, at: Date.now() });
    } catch {
      /* the host falls back to pi's own usage */
    }
  };
  const cacheMode = E.VC_PI_GEMINI_CACHE === "0" ? null : E.VC_PI_GEMINI_CACHE === "last" ? "last" : "system";
  pi.on("before_provider_request", (event) => {
    flush();
    pending = { genId: null, cost: null, model: String(event?.payload?.model ?? "") };
    return cacheMode ? addCacheMarkers(event?.payload, cacheMode) : undefined;
  });
  pi.on("after_provider_response", (event) => {
    const h = event?.headers ?? {};
    const id = h["x-generation-id"] ?? h["X-Generation-Id"];
    if (pending && typeof id === "string" && id) pending.genId = id;
  });
  pi.on("provider_stream_event", (event) => {
    if (!pending) return;
    const c = costFromStreamEvent(event?.data);
    if (!c) return;
    pending.cost = c.cost;
    if (!pending.genId && c.id && c.id.startsWith("gen-")) pending.genId = c.id;
  });
  pi.on("message_end", (event) => {
    if (event?.message?.role === "assistant") flush();
  });
  pi.on("agent_settled", flush);

  // ---- the "you" layer: what Carl just did on his other surfaces ----------------------
  // Each prompt (a conversation's turn, a Ctrl+K / Ctrl+L request): ask the box for the
  // layer since this session last saw it (the `until` of its last vc-you message; a
  // fork carries its parent's), and hand it to pi as before_agent_start's custom
  // message: pi stores it in the session (after the user message, as a custom_message
  // entry the transcript does not show) and sends it to the model with this turn, and
  // its compaction summarises it like any other message. Nothing new: no message.
  if (E.VC_PI_YOU === "1") {
    pi.on("before_agent_start", async (_event, ctx) => {
      let since = null;
      try {
        since = youSince(ctx.sessionManager.getBranch());
      } catch {
        since = null;
      }
      let v;
      try {
        v = await Promise.race([
          service("you", { since }),
          new Promise((r) => setTimeout(() => r(undefined), 10_000)),
        ]);
      } catch {
        return undefined;
      }
      const r = v;
      if (!r || typeof r.text !== "string" || !r.text.trim() || !Number.isFinite(Number(r.until))) return undefined;
      return { message: { customType: YOU_TYPE, content: r.text, display: false, details: { until: Number(r.until), since } } };
    });
  }

  // ---- vault-chat's own lines in the transcript (a notice, a line, a divider) ---------
  // pi's custom entries (not in the model's context), appended by pi itself so the
  // session's tree stays pi's: the host sends `/vc-note {json}` while pi has the session.
  // A line said on a voice call (`voice: true`) is a custom MESSAGE instead: in the model's
  // context, so this conversation's agent hears what was said by voice (pi's sendMessage;
  // never a turn of its own, and held to the end of a running turn by pi itself).
  pi.registerCommand("vc-note", {
    description: "vault-chat: append a vc-note entry (or a voice line) to this session",
    handler: async (args) => {
      const d = json(String(args ?? "").trim(), null);
      if (!d || typeof d !== "object" || typeof d.kind !== "string") return;
      // Clear: the agent is told (in its context, never shown); no turn of its own.
      if (d.kind === "clear") pi.sendMessage({ customType: CLEAR_TYPE, content: String(d.text ?? ""), display: false, details: { at: d.at } }, { triggerTurn: false });
      else if (d.voice === true && d.kind === "line") pi.sendMessage({ customType: VOICE_TYPE, content: voiceLineContent(d), display: true, details: d }, { triggerTurn: false });
      else pi.appendEntry("vc-note", d);
    },
  });
}
