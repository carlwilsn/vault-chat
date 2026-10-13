// Voice on the box: the ElevenLabs agent's client tools run here, against the
// box's working copy, whichever client holds the mic (the laptop in box mode,
// the phone). Two routes (http.ts):
//   POST /api/v1/voice/tool    {name, args}       → {result}
//   GET  /api/v1/voice/session ?convId=            → {signedUrl, systemPrompt, …}
// The tools keep the engine's posture: paths stay inside the vault (realpath),
// never .git, never the conversation files or .vault-chat/local (the server's
// to write), never a .vaultchatdeny entry; writes also respect humanized files.
// Bash runs in the engine's shell sandbox (bubblewrap: own pid namespace, the
// key store hidden). AskAgent / AgentStatus hand heavy work to the engine.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fsCommands } from "./commands/fs";
import { netCommands } from "./commands/net";
import { killTree } from "./commands/proc";
import { readConversationObjects } from "./commands/conversations";
import { conversationDetail, dispatchVoiceTool } from "./phoneData";

export type VoiceDeps = {
  vault: string;
  /** The engine's per-command sandbox argv (ends with "--"); null = the engine
   * runs without one (not Linux, or VC_PI_UNSAFE); undefined = no engine. */
  shell?: string[] | null;
  /** The engine's /message (start or continue a box chat). */
  message?: (b: { text: string; project?: string; convId?: string | null }) => Promise<Record<string, unknown> | null>;
  /** After a write: run a sync cycle so it reaches the laptop. */
  onWrite?: () => void;
  openrouterKey?: () => string | null;
  webSearchModel?: string;
};

const READ_CAP = 24_000;
const OUT_CAP = 8_000;
/** Tools that move the user's screen: they run in the client, never here. */
export const VOICE_LOCAL_TOOLS = new Set(["ScrollTo"]);

const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "\n…[truncated]" : t);

// ---------------------------------------------------------------- paths

/** The real path of `p`, or of its deepest existing ancestor plus the rest (a file not yet written). */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      rest.push(cur.slice(up.length).replace(/^[\\/]+/, ""));
      cur = up;
    }
  }
}

function relIn(root: string, abs: string): string | null {
  const r = relative(root, abs);
  if (r === "") return "";
  if (r.startsWith("..") || isAbsolute(r)) return null;
  return r.split(sep).join("/");
}

function listLines(cmd: "read_deny_lines" | "read_humanized", vault: string): string[] {
  try {
    const v = (fsCommands[cmd] as any)({ vault });
    return Array.isArray(v) ? v.map((x: unknown) => s(x).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const under = (rel: string, entry: string) => rel === entry || rel.startsWith(entry + "/");

/** Resolve a tool path (vault-relative or absolute) to an absolute path inside
 * the vault, or throw the refusal the agent hears. */
export function voicePath(vault: string, p: unknown, mode: "read" | "write"): { abs: string; rel: string } {
  const raw = s(p).trim();
  const root = realish(resolve(vault));
  const abs = realish(resolve(raw ? (isAbsolute(raw) ? raw : join(vault, raw)) : vault));
  const rel = relIn(root, abs);
  if (rel === null) throw `Refused: ${raw || "(empty path)"} is outside the vault.`;
  const parts = rel.split("/");
  if (parts.includes(".git")) throw `Refused: the .git folder is off limits.`;
  if (mode === "write" && (under(rel, ".vault-chat/conversations") || under(rel, ".vault-chat/local"))) {
    throw `Refused: ${rel} belongs to the server (conversations and local state are not written by tools).`;
  }
  for (const d of listLines("read_deny_lines", vault)) if (under(rel, d)) throw `Refused: ${rel} is restricted from the agent.`;
  if (mode === "write") for (const h of listLines("read_humanized", vault)) if (rel === h) throw `Refused: ${rel} is a humanized file; the agent does not write it.`;
  return { abs, rel };
}

// ---------------------------------------------------------------- bash

function runShell(d: VoiceDeps, command: string, timeoutMs: number): Promise<string> {
  let prog: string;
  let args: string[];
  if (d.shell && d.shell.length) {
    prog = d.shell[0]!;
    args = [...d.shell.slice(1), "bash", "-lc", command];
  } else if (d.shell === null || process.platform !== "linux" || process.env.VC_PI_UNSAFE === "1") {
    if (process.platform === "win32") {
      const gb = ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"].find((c) => existsSync(c));
      prog = gb ?? "bash";
    } else prog = "bash";
    args = ["-lc", command];
  } else {
    return Promise.resolve("Error: Bash is unavailable here — the box's shell sandbox is not running (the engine is off).");
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/run/current-system/sw/bin",
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    GIT_AUTHOR_NAME: "vault-chat-agent",
    GIT_AUTHOR_EMAIL: "agent@vault-chat.local",
    GIT_COMMITTER_NAME: "vault-chat-agent",
    GIT_COMMITTER_EMAIL: "agent@vault-chat.local",
    ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "", MSYS_NO_PATHCONV: "1" } : {}),
  };
  return new Promise((done) => {
    let out = "";
    let err = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(prog, args, { cwd: d.vault, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return done(`Error: ${(e as Error).message}`);
    }
    child.stdout!.on("data", (c) => (out += c));
    child.stderr!.on("data", (c) => (err += c));
    const t = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(t);
      done(`Error: ${e.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      const parts = [`exit: ${timedOut ? -1 : (code ?? -1)}${timedOut ? " (TIMED OUT)" : ""}`];
      if (out) parts.push(`stdout:\n${clip(out, OUT_CAP)}`);
      if (err) parts.push(`stderr:\n${clip(err, OUT_CAP)}`);
      done(parts.join("\n"));
    });
  });
}

// ---------------------------------------------------------------- the agent

function agentStatus(vault: string, id: string, live: any): string {
  if (!id) return "Error: AgentStatus needs a conversationId.";
  const d = conversationDetail(vault, id, 12) as any;
  if (!d) return `No conversation ${id}.`;
  const raw = readConversationObjects(vault).find((c) => c.id === id) ?? {};
  const out: Record<string, unknown> = { conversationId: id, title: d.title };
  let running = d.status === "running" || d.state === "running";
  try {
    // The live run, when this process has one (the store mirrors the engine's turn).
    const rt = live?.getState?.().convRuntime?.[id];
    if (rt) {
      running = true;
      const tool = Array.isArray(rt.liveTools) && rt.liveTools.length ? rt.liveTools[rt.liveTools.length - 1] : null;
      if (tool?.name) out.now = `running ${tool.name}`;
      if (s(rt.streamingText).trim()) out.saying = clip(s(rt.streamingText).trim().replace(/\s+/g, " "), 300);
    }
  } catch {
    /* no store */
  }
  out.state = raw.pendingAsk ? "waiting for Carl's answer" : running ? "working" : d.state === "sleeping" ? "sleeping" : s(d.state) || "idle";
  if (raw.pendingAsk) out.question = clip(s(raw.pendingAsk.question ?? raw.pendingAsk), 400);
  if (d.wakeReason) out.wakeReason = d.wakeReason;
  if (typeof d.nextWakeAt === "number") out.nextWake = new Date(d.nextWakeAt).toISOString();
  const doing = (d.todos ?? []).find((t: any) => t?.status === "in_progress");
  if (doing) out.step = s(doing.activeForm || doing.content);
  if (d.verdict) out.verdict = d.verdict;
  const last = [...(d.messages ?? [])].reverse().find((m: any) => m.role === "assistant" && !m.system && s(m.content).trim());
  if (last) out.lastReply = clip(s(last.content).trim(), 800);
  if (typeof d.costUsd === "number") out.costUsd = Math.round(d.costUsd * 10000) / 10000;
  return JSON.stringify(out);
}

// ---------------------------------------------------------------- the tools

async function store(): Promise<any> {
  return (await import("../src/store")).useStore;
}

async function runTool(d: VoiceDeps, name: string, a: any): Promise<string> {
  const vault = d.vault;
  const wrote = (msg: string) => {
    d.onWrite?.();
    return msg;
  };
  switch (name) {
    case "Read": {
      const { abs, rel } = voicePath(vault, a.path, "read");
      if (/\.pdf$/i.test(abs)) return `${rel} is a PDF — use PdfExtract.`;
      const raw = fsCommands.read_text_file({ path: abs }) as string;
      let text = raw;
      if (/\.ipynb$/i.test(abs)) text = (await import("../src/tools")).stripNotebook(raw);
      return clip(text, READ_CAP);
    }
    case "ListDir": {
      const { abs } = voicePath(vault, a.path, "read");
      const entries = fsCommands.list_dir({ path: abs }) as { name: string; is_dir: boolean }[];
      return entries.length ? entries.map((e) => (e.is_dir ? `${e.name}/` : e.name)).join("\n") : "(empty)";
    }
    case "Glob":
    case "GitLog":
    case "ListConversations":
    case "ReadConversation":
      // The phone's read-only set (vault-confined; GitLog's subdir checked here).
      if (name === "GitLog") voicePath(vault, s(a.subdir) || ".", "read");
      return dispatchVoiceTool(vault, JSON.stringify({ name, arguments: a }));
    case "Grep": {
      const { abs } = voicePath(vault, a.path, "read");
      const root = realish(resolve(vault));
      const deny = listLines("read_deny_lines", vault);
      const hits = fsCommands.grep_files({ pattern: s(a.pattern), path: abs, globFilter: a.glob_filter ?? null, caseInsensitive: !!a.case_insensitive, maxResults: 200 }) as {
        path: string;
        line: number;
        text: string;
      }[];
      const rows = hits
        .map((h) => ({ ...h, rel: relIn(root, realish(h.path)) }))
        .filter((h) => h.rel !== null && !deny.some((x) => under(h.rel!, x)))
        .slice(0, 100)
        .map((h) => `${h.rel}:${h.line}: ${h.text}`);
      return rows.length ? rows.join("\n") : "(no matches)";
    }
    case "Write": {
      const { abs, rel } = voicePath(vault, a.path, "write");
      fsCommands.write_text_file({ path: abs, contents: s(a.contents) });
      return wrote(`Wrote ${rel}`);
    }
    case "Edit": {
      const { abs } = voicePath(vault, a.path, "write");
      const out = fsCommands.edit_text_file({ path: abs, oldString: s(a.old_string), newString: s(a.new_string), replaceAll: !!a.replace_all }) as string;
      return wrote(out.split(abs).join(relIn(realish(resolve(vault)), abs) ?? abs));
    }
    case "NotebookEdit": {
      const { abs, rel } = voicePath(vault, a.path, "write");
      const { applyNotebookEdit } = await import("../src/tools");
      const r = applyNotebookEdit(readFileSync(abs, "utf8"), a.action, Number(a.cell_index), a.source, a.cell_type);
      if (!r.ok) return `Error: ${r.error}`;
      fsCommands.write_text_file({ path: abs, contents: r.contents });
      return wrote(`${r.summary} in ${rel}`);
    }
    case "PdfExtract": {
      const { abs } = voicePath(vault, a.path, "read");
      const { pdfRead } = await import("./engine/extraTools");
      return pdfRead(vault, { path: abs, pages: a.pages });
    }
    case "WebFetch": {
      const url = s(a.url).trim();
      let host = "";
      try {
        host = new URL(url).hostname.replace(/^\[|\]$/g, "");
      } catch {
        return "Error: WebFetch needs a full http(s) URL.";
      }
      // The box's own services answer loopback without auth: never fetch them for a voice.
      if (/^(localhost|127\.|0\.0\.0\.0|::1$|10\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/i.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
        return "Refused: WebFetch does not reach the box's own network.";
      }
      return (await netCommands.http_fetch({ url, maxChars: Math.min(Number(a.max_chars) || 24_000, 40_000) })) as string;
    }
    case "WebSearch": {
      const { webSearch } = await import("./engine/extraTools");
      return webSearch(s(a.query), d.openrouterKey?.() ?? null, d.webSearchModel || "google/gemini-2.5-flash-lite");
    }
    case "Bash": {
      const cmd = s(a.command);
      if (!cmd.trim()) return "Error: Bash needs a command.";
      const nv = realish(resolve(vault)).replace(/\\/g, "/");
      for (const x of [...listLines("read_deny_lines", vault)]) {
        if (cmd.includes(x) || cmd.includes(`${nv}/${x}`)) return `Refused: command references restricted path '${x}'.`;
      }
      const out = await runShell(d, cmd, Math.min(Number(a.timeout_ms) || 20_000, 25_000));
      d.onWrite?.(); // a command may have changed files
      return out;
    }
    case "CreateNote": {
      const st = (await store()).getState();
      const { buildNote } = await import("../src/notes");
      const anchors = a.source_path ? [{ source_path: s(a.source_path), source_kind: "code" as const, source_anchor: a.source_anchor ?? null, primary: true }] : [];
      const note = buildNote({ anchors, userDraft: s(a.text) });
      await st.addNote(note);
      return wrote(`Saved note ${note.id}.`);
    }
    case "ListNotes": {
      const us = await store();
      await us.getState().loadNotes?.();
      const status = a.status ?? "open";
      const notes: any[] = (us.getState().notes ?? []).filter((n: any) => status === "all" || n.status === status);
      const shown = notes.slice(0, Number(a.limit) || 50);
      if (!shown.length) return `No ${status === "all" ? "" : status + " "}notes.`;
      return `${notes.length} note(s) (showing ${shown.length}):\n\n${shown
        .map((n) => `[${n.id}] ${n.status} · ${s(n.timestamp).slice(0, 16)}\n  ${s(n.formatted ?? n.user_draft ?? n.turns?.[0]?.content).slice(0, 160).replace(/\n+/g, " ")}`)
        .join("\n\n")}`;
    }
    case "ResolveNote":
    case "ReopenNote": {
      const us = await store();
      await us.getState().loadNotes?.();
      const want = name === "ResolveNote" ? "resolved" : "open";
      const n = (us.getState().notes ?? []).find((x: any) => x.id === a.id);
      if (!n) return `No note with id "${s(a.id)}".`;
      if (n.status === want) return `Note ${a.id} is already ${want}.`;
      await us.getState().setNoteStatus(a.id, want);
      return wrote(`${want === "resolved" ? "Resolved" : "Reopened"} note ${a.id}.`);
    }
    case "AskAgent": {
      if (!d.message) return "Error: the box's agent is not running, so nothing was handed over.";
      const task = s(a.task).trim();
      if (!task) return "Error: AskAgent needs a task.";
      const convId = s(a.conversationId).trim() || null;
      const out = await d.message({ text: task, convId, ...(s(a.project).trim() ? { project: s(a.project).trim() } : {}) });
      if (!out || out.error) return `Error: ${s(out?.error) || "the agent did not take it"}`;
      return JSON.stringify({ conversationId: out.convId, started: !convId, ...(out.steered ? { steered: true } : {}), ...(out.answered ? { answered: true } : {}) });
    }
    case "AgentStatus":
      return agentStatus(vault, s(a.conversationId).trim(), await store().catch(() => null));
    default:
      if (VOICE_LOCAL_TOOLS.has(name)) return `${name} moves a screen; there is none on the box, so nothing moved.`;
      return `Error: tool "${name}" is not available on the box.`;
  }
}

/** POST /api/v1/voice/tool {name, args}. Never throws: errors are the result the agent hears. */
export async function voiceTool(d: VoiceDeps, body: any): Promise<{ result: string }> {
  const name = s(body?.name);
  const args = body?.args ?? body?.arguments ?? body?.parameters ?? {};
  if (!name) return { result: "Error: missing tool name." };
  try {
    return { result: await runTool(d, name, args && typeof args === "object" ? args : {}) };
  } catch (e) {
    return { result: typeof e === "string" ? e : `Error: ${(e as Error)?.message ?? String(e)}` };
  }
}

// ---------------------------------------------------------------- the session

/** GET /api/v1/voice/session: a signed ElevenLabs URL for the box's agent
 * (provisioned with the box's key, the same builder the laptop uses), and the
 * session's prompt. The key itself never leaves the box. */
export async function voiceSession(convId: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const v = await import("../src/voice-elevenlabs");
  v.resetAgentCreateBreaker();
  const ctx = await v.buildPhoneVoiceContext(convId || undefined, { agentOnBox: true });
  if (!ctx) {
    const err = v.getLastAgentCreateError();
    return {
      status: 503,
      body: { error: err ? `ElevenLabs agent could not be provisioned (HTTP ${err.status})` : "voice is not ready on the box (no ElevenLabs key — the laptop's Settings sends it)" },
    };
  }
  const signedUrl = await v.getSignedUrl(ctx.elKey, ctx.agentId);
  if (!signedUrl) return { status: 502, body: { error: "ElevenLabs refused a signed URL" } };
  return {
    status: 200,
    body: {
      signedUrl,
      agentId: ctx.agentId,
      voiceId: ctx.voiceId,
      systemPrompt: ctx.systemPrompt,
      dynamicVariables: ctx.dynamicVariables,
      toolNames: ctx.toolNames,
      onBox: true,
    },
  };
}
