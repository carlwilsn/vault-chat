// Pure helpers for vault-chat's pi extension (vc.mjs). Plain JS: pi loads the
// extension through jiti from $VC_STATE_DIR/pi/ext/, and the server's tests
// import this file directly. No pi imports here.
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Env names that never reach the agent's shell. */
const SECRET_ENV = /OPENROUTER|API_KEY|APIKEY|_TOKEN$|^TOKEN$|SECRET|PASSW|^VC_|^AWS_|^GH_|^GITHUB_TOKEN|^NPM_TOKEN/i;

/** A copy of `env` without anything that looks like a credential or vault-chat's own config. */
export function scrubEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v === undefined || SECRET_ENV.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** POSIX single-quote a shell word. */
export function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * `p` (relative to `cwd`, `~` expanded) resolved through symlinks as far as
 * the path exists, with the missing tail re-appended — so a symlink planted in
 * the vault that points into the key store resolves to the key store.
 */
export function realish(p, cwd, home) {
  let s = String(p ?? "").trim();
  if (s.startsWith("@")) s = s.slice(1); // pi accepts @path
  if (s === "~") s = home;
  else if (s.startsWith("~/")) s = join(home, s.slice(2));
  const abs = resolve(cwd, s || ".");
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      const r = realpathSync(cur);
      return rest.length ? join(r, ...rest.reverse()) : r;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

export function isUnder(p, dir) {
  if (!dir) return false;
  const d = dir.endsWith(sep) && dir.length > 1 ? dir.slice(0, -1) : dir;
  return p === d || p.startsWith(d + sep);
}

/** Each deny entry resolved too (the key store dir may itself be a symlink). */
export function resolveList(list, home) {
  return (list ?? []).filter(Boolean).flatMap((d) => {
    const a = resolve(String(d));
    const r = realish(a, "/", home);
    return r === a ? [a] : [a, r];
  });
}

/** Tools whose arguments name a path, and which argument. */
const PATH_ARGS = {
  read: ["path", "file_path"],
  write: ["path", "file_path"],
  edit: ["path", "file_path"],
  grep: ["path"],
  find: ["path"],
  ls: ["path"],
};
const WRITES = new Set(["write", "edit"]);

/**
 * Why a call of one of pi's in-process tools must be blocked, or null.
 * denyRead: never read or written (key store, tokens, /proc). denyWrite: read-only (state, pi's agent dir).
 */
export function guardToolCall(toolName, input, { cwd, home, denyRead, denyWrite }) {
  const keys = PATH_ARGS[toolName];
  if (!keys) return null;
  for (const k of keys) {
    const v = input?.[k];
    if (typeof v !== "string" || !v.trim()) continue;
    const p = realish(v, cwd, home);
    for (const d of denyRead) if (isUnder(p, d)) return `${toolName}: ${v} is in a protected location (vault-chat's key store and server state are off limits).`;
    if (WRITES.has(toolName)) for (const d of denyWrite) if (isUnder(p, d)) return `${toolName}: ${v} is read-only for the agent.`;
  }
  // pi's read gives a PDF's raw bytes (Carl was asked for a screenshot of an exam the agent could not read this way).
  if (toolName === "read" && /\.pdf$/i.test(String(input?.path ?? "").trim())) return `read: ${input.path} is a PDF, and read gives only its raw bytes. Use PdfRead {path, pages} for its text (without PdfRead: pdftotext in the shell).`;
  // grep/find with a glob that climbs out of the tree is not followed by pi's
  // tools (no symlink following); nothing more to check.
  return null;
}

/**
 * Gemini through OpenRouter caches only with explicit cache_control markers
 * (OpenRouter's shape: a text part with {cache_control:{type:"ephemeral"}}),
 * and it honours one breakpoint per request. mode "system" (the default)
 * marks only the system prompt — a breakpoint that never moves, so later
 * calls can read what the first wrote; "last" also marks the newest user
 * message (measured live: every call wrote a cache, none read one). Returns
 * the new payload, or undefined when nothing applies.
 */
export function addCacheMarkers(payload, mode = "system") {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) return undefined;
  if (!/^google\//.test(String(payload.model ?? ""))) return undefined;
  const msgs = payload.messages.map((m) => (m && typeof m === "object" ? { ...m } : m));
  const mark = (m) => {
    if (!m) return false;
    if (typeof m.content === "string") {
      if (!m.content) return false;
      m.content = [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }];
      return true;
    }
    if (Array.isArray(m.content)) {
      for (let i = m.content.length - 1; i >= 0; i--) {
        const part = m.content[i];
        if (part && part.type === "text" && part.text) {
          m.content = m.content.slice();
          m.content[i] = { ...part, cache_control: { type: "ephemeral" } };
          return true;
        }
      }
    }
    return false;
  };
  let changed = false;
  const sys = msgs.findIndex((m) => m && (m.role === "system" || m.role === "developer"));
  if (sys >= 0) changed = mark(msgs[sys]) || changed;
  for (let i = msgs.length - 1; mode === "last" && i >= 0; i--) {
    if (msgs[i] && msgs[i].role === "user" && mark(msgs[i])) {
      changed = true;
      break;
    }
  }
  return changed ? { ...payload, messages: msgs } : undefined;
}

/** A JSON-schema tool spec (the engine's tool shape) → TypeBox, for pi.registerTool. */
export function toTypebox(Type, s) {
  const d = s && typeof s.description === "string" ? { description: s.description } : {};
  if (s && Array.isArray(s.enum) && s.enum.length) return Type.Union(s.enum.map((v) => Type.Literal(v)), d);
  switch (s?.type) {
    case "string":
      return Type.String(d);
    case "number":
    case "integer":
      return Type.Number(d);
    case "boolean":
      return Type.Boolean(d);
    case "array":
      return Type.Array(toTypebox(Type, s.items ?? {}), d);
    case "object": {
      const req = new Set(Array.isArray(s.required) ? s.required : []);
      const props = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        const t = toTypebox(Type, v);
        props[k] = req.has(k) ? t : Type.Optional(t);
      }
      return Type.Object(props, d);
    }
    default:
      return typeof Type.Any === "function" ? Type.Any(d) : Type.Unknown(d);
  }
}

/** The cost and generation id OpenRouter reports, from one parsed stream event (any API pi uses). */
export function costFromStreamEvent(data) {
  if (!data || typeof data !== "object") return null;
  const u = data.usage ?? data.message?.usage ?? data.delta?.usage ?? null;
  if (!u || typeof u !== "object") return null;
  const c = Number(u.cost);
  if (!Number.isFinite(c)) return null;
  return { cost: c, id: typeof data.id === "string" ? data.id : null };
}

/** The custom message type of the "you" layer in a pi session (vc.mjs before_agent_start). */
export const YOU_TYPE = "vc-you";

/**
 * What this session has seen of the "you" layer: the `until` of the last
 * `vc-you` custom message on its branch (a fork carries its parent's), or null
 * (a new conversation: it gets the whole layer).
 */
export function youSince(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e?.type === "custom_message" && e.customType === YOU_TYPE) {
      const u = Number(e.details?.until);
      if (Number.isFinite(u)) return u;
    }
  }
  return null;
}

/** The custom message type of a line said on a voice call (vc.mjs /vc-note with `voice`; server/convlog/piSession.ts). */
export const VOICE_TYPE = "vc-voice";

/**
 * What the model reads for a voice line (a custom_message is sent as user-role text): who said it, on the
 * call. Voice is this conversation's front of house, not another agent: its words are the conversation's.
 */
export function voiceLineContent(d) {
  const text = String(d?.text ?? "").trim();
  return d?.role === "user" ? `[voice call] Carl said: ${text}` : `[voice call] You said to Carl (spoken by your voice): ${text}`;
}

/** Carl cleared a thread's view (the engine's Clear): a custom message in the model's context, never shown. */
export const CLEAR_TYPE = "vc-clear";

// The memory files' caps (server/context/memory.ts says the same): Claude Code's near-cap reminder.
const MEMORY_CAPS = { lines: 200, chars: 25_000, projectChars: 8_000, projectMemoryLines: 60, near: 0.8 };

/**
 * The near-cap reminder for a write or edit that touched a memory file — `.vault-chat/MEMORY.md` or a
 * project's `agent-projects/<slug>/project.md` — appended to that tool's result (pi's tool_result hook),
 * or null. `read(abs)` returns the file's text after the write.
 */
export function memoryCapNote(toolName, input, cwd, read) {
  if (toolName !== "write" && toolName !== "edit") return null;
  const p = String(input?.path ?? input?.file_path ?? "");
  if (!p) return null;
  const abs = p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) ? p : `${cwd.replace(/[\\/]+$/, "")}/${p}`;
  const norm = abs.replace(/\\/g, "/");
  let text;
  try {
    text = String(read(abs) ?? "");
  } catch {
    return null;
  }
  const lines = (s) => (s.trim() ? s.trim().split(/\r?\n/).length : 0);
  if (/\/\.vault-chat\/MEMORY\.md$/.test(norm)) {
    const n = lines(text);
    if (n < MEMORY_CAPS.lines * MEMORY_CAPS.near && text.length < MEMORY_CAPS.chars * MEMORY_CAPS.near) return null;
    return `[memory] MEMORY.md is at ${n} of ${MEMORY_CAPS.lines} lines: merge related lines and drop stale ones now${n > MEMORY_CAPS.lines ? " (past the cap the rest is not loaded)" : ""}.`;
  }
  if (/\/agent-projects\/[a-z0-9-]+\/project\.md$/.test(norm)) {
    const m = /^##\s+Memory\s*$/im.exec(text);
    let n = 0;
    if (m) {
      const rest = text.slice(m.index + m[0].length);
      const end = /^##\s+/m.exec(rest);
      n = (end ? rest.slice(0, end.index) : rest).split(/\r?\n/).filter((l) => l.trim()).length;
    }
    const big = text.trim().length >= MEMORY_CAPS.projectChars * MEMORY_CAPS.near;
    if (n < MEMORY_CAPS.projectMemoryLines * MEMORY_CAPS.near && !big) return null;
    return `[memory] This project.md's ## Memory is at ${n} of ${MEMORY_CAPS.projectMemoryLines} lines${big ? ` and the file at ${text.trim().length} of ${MEMORY_CAPS.projectChars} characters loaded` : ""}: merge related memory lines and drop stale ones now (never Carl's instructions above ## Memory).`;
  }
  return null;
}
