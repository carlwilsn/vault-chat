// Voice on the box: the ElevenLabs agent's client tools run here, against the
// box's working copy, whichever client holds the mic (the laptop in box mode,
// the phone). Three routes (http.ts), each with an optional vault:
//   POST /api/v1/voice/tool       {name, args}                → {result}
//   GET  /api/v1/voice/session    ?convId=                    → {conversationToken, signedUrl, systemPrompt, …}
//   POST /api/v1/voice/transcript {convId?, fromConvId?, role, text, system?, tool?: {name, args, result}} → {convId}
// The vault's own voice tools (.vault-chat/tools/<name>/TOOL.md + run.*) run
// here too, in the same sandbox as Bash, with only the keys TOOL.md's
// requires_keys names.
// The tools keep the engine's posture: paths stay inside the vault (realpath),
// never .git, never the conversation files or .vault-chat/local (the server's
// to write), never a .vaultchatdeny entry; writes also respect humanized files.
// Bash runs in the engine's shell sandbox (bubblewrap: own pid namespace, the
// key store hidden). AskAgent / AgentStatus hand heavy work to the engine.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fsCommands } from "./commands/fs";
import { netCommands } from "./commands/net";
import { killTree } from "./commands/proc";
import { conversationObjects as readConversationObjects } from "./engine/convs";
import { keychainCommands, agentKeyEnv } from "./keys";
import { runGit } from "./git";
import { conversationDetail, dispatchVoiceTool } from "./phoneData";
import { activitySummary, appendActivity, projectContextFor } from "./activity";
import { voiceLineEntry, voiceToolEntry, clean } from "../src/activityCore";
import { stripAudioTags } from "../src/voiceTags";
import { NOTES_FILE, noteTool } from "./notesTools";

export type VoiceDeps = {
  /** The vault's working copy, its name on the box, and whether it is the main one (the store's). */
  vault: string;
  name?: string;
  main?: boolean;
  /** The engine's per-command sandbox argv (ends with "--"); null = the engine
   * runs without one (not Linux, or VC_PI_UNSAFE); undefined = no engine. */
  shell?: string[] | null;
  /** The engine's /message (start or continue a box chat). */
  message?: (b: { text: string; convId?: string | null; source?: "voice" }) => Promise<Record<string, unknown> | null>;
  /** After a write: run a sync cycle so it reaches the laptop; `paths` (vault-relative) when a file tool
   * wrote them — the open file on the laptop then updates live (server/liveEdits.ts). */
  onWrite?: (paths?: string[]) => void;
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

type RunOut = { code: number; out: string; err: string; timedOut: boolean } | { refused: string };

/** Run argv in the engine's per-command sandbox (bubblewrap: own pid
 * namespace, the key store hidden) with a minimal environment plus `extraEnv`. */
function runSandboxed(d: VoiceDeps, argv: string[], o: { cwd: string; timeoutMs: number; stdin?: string; extraEnv?: Record<string, string> }): Promise<RunOut> {
  let prog: string;
  let args: string[];
  if (d.shell && d.shell.length) {
    prog = d.shell[0]!;
    args = [...d.shell.slice(1), ...argv];
  } else if (d.shell === null || process.platform !== "linux" || process.env.VC_PI_UNSAFE === "1") {
    prog = argv[0]!;
    if (process.platform === "win32" && prog === "bash") {
      prog = ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"].find((c) => existsSync(c)) ?? "bash";
    }
    args = argv.slice(1);
  } else {
    return Promise.resolve({ refused: "unavailable right now — the box's sandbox comes with the agent engine, which is still starting or off." });
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
    ...(o.extraEnv ?? {}),
  };
  return new Promise((done) => {
    let out = "";
    let err = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(prog, args, { cwd: o.cwd, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return done({ refused: (e as Error).message });
    }
    child.stdout!.on("data", (c) => (out += c));
    child.stderr!.on("data", (c) => (err += c));
    child.stdin!.on("error", () => {});
    child.stdin!.end(o.stdin ?? "");
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, o.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ refused: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: timedOut ? -1 : (code ?? -1), out, err, timedOut });
    });
  });
}

async function runShell(d: VoiceDeps, command: string, timeoutMs: number): Promise<string> {
  // The keys Carl added are the agent's (as environment variables, read now).
  const r = await runSandboxed(d, ["bash", "-lc", command], { cwd: d.vault, timeoutMs, extraEnv: agentKeyEnv() });
  if ("refused" in r) return `Error: Bash is ${r.refused}`;
  const parts = [`exit: ${r.code}${r.timedOut ? " (TIMED OUT)" : ""}`];
  if (r.out) parts.push(`stdout:\n${clip(r.out, OUT_CAP)}`);
  if (r.err) parts.push(`stderr:\n${clip(r.err, OUT_CAP)}`);
  return parts.join("\n");
}

// ---------------------------------------------------------------- the vault's own tools

/** The interpreter for a tool's run file (server/commands/proc.ts interpreterFor). */
function interpreter(path: string): string[] | null {
  const l = path.toLowerCase();
  if (l.endsWith(".py")) return [process.platform === "win32" ? "python" : "python3", path];
  if (l.endsWith(".mjs") || l.endsWith(".js")) return ["node", path];
  if (l.endsWith(".ts")) return ["npx", "tsx", path];
  if (l.endsWith(".sh") || l.endsWith(".bash")) return ["bash", path];
  return null;
}

/** A vault tool (TOOL.md + run.*), run like the laptop runs it (stdin = the
 * args as JSON, cwd = its folder, stdout = the result), but sandboxed, with
 * the keys as environment variables (its declared ones under their own names). ElevenLabs waits 30 s for a client tool. */
async function runVaultTool(d: VoiceDeps, name: string, args: unknown): Promise<string | null> {
  const { vaultToolSpecs } = await import("../src/meta");
  const hit = (await vaultToolSpecs(d.vault)).find((x) => x.spec.name === name);
  if (!hit) return null;
  const argv = interpreter(hit.runPath);
  if (!argv) return `Error: no interpreter for ${hit.runPath}`;
  // Every key (as the agent's commands get them), plus each declared one under its own name.
  const keys: Record<string, string> = { ...agentKeyEnv() };
  for (const k of hit.spec.requires_keys ?? []) {
    const v = keychainCommands.keychain_get({ key: `user.${k}` });
    if (typeof v === "string" && v) keys[k] = v;
  }
  const r = await runSandboxed(d, argv, { cwd: hit.toolDir, stdin: JSON.stringify(args ?? {}), timeoutMs: Math.min(hit.spec.timeout_ms ?? 25_000, 28_000), extraEnv: keys });
  if ("refused" in r) return `Error: ${name} is ${r.refused}`;
  if (r.timedOut) return `(timed out)\n${clip(r.err, OUT_CAP)}`;
  if (r.code !== 0) return `exit ${r.code}\nstderr:\n${clip(r.err, OUT_CAP)}\nstdout:\n${clip(r.out, OUT_CAP)}`;
  return clip(r.out.trim(), READ_CAP) || "(no output)";
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

export { NOTES_FILE } from "./notesTools";

async function runTool(d: VoiceDeps, name: string, a: any): Promise<string> {
  const vault = d.vault;
  const wrote = (msg: string, rel?: string) => {
    d.onWrite?.(rel ? [rel] : undefined);
    return msg;
  };
  switch (name) {
    case "Read": {
      const { abs, rel } = voicePath(vault, a.path, "read");
      if (/\.pdf$/i.test(abs)) return `${rel} is a PDF — use PdfExtract.`;
      const raw = fsCommands.read_text_file({ path: abs }) as string;
      let text = raw;
      if (/\.ipynb$/i.test(abs)) text = (await import("../src/fileText")).stripNotebook(raw);
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
      return wrote(`Wrote ${rel}`, rel);
    }
    case "Edit": {
      const { abs, rel } = voicePath(vault, a.path, "write");
      const out = fsCommands.edit_text_file({ path: abs, oldString: s(a.old_string), newString: s(a.new_string), replaceAll: !!a.replace_all }) as string;
      return wrote(out.split(abs).join(relIn(realish(resolve(vault)), abs) ?? abs), rel);
    }
    case "NotebookEdit": {
      const { abs, rel } = voicePath(vault, a.path, "write");
      const { applyNotebookEdit } = await import("../src/fileText");
      const r = applyNotebookEdit(readFileSync(abs, "utf8"), a.action, Number(a.cell_index), a.source, a.cell_type);
      if (!r.ok) return `Error: ${r.error}`;
      fsCommands.write_text_file({ path: abs, contents: r.contents });
      return wrote(`${r.summary} in ${rel}`, rel);
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
    // Notes: this vault's .vault-chat/notes.jsonl on the box, read and written there (never the headless store's
    // copy, which is another vault's or stale), by the same code pi's notes tools run (server/notesTools.ts). Each
    // result says what the file now holds — the voice agent tells Carl only what the result confirms (2026-10-18:
    // "I've saved a note … in your notes panel" when he could not see it there).
    case "ListNotes":
    case "CreateNote":
    case "UpdateNote":
    case "ResolveNote":
    case "ReopenNote":
    case "DeleteNote": {
      const r = await noteTool(vault, name, a, d.name ? `the "${d.name}" vault's notes` : "the vault's notes");
      return r.wrote ? wrote(r.text, NOTES_FILE) : r.text;
    }
    case "ListProjects":
      return projectsText(vault, a);
    case "AskAgent": {
      if (!d.message) return "Error: the box's agent is not running, so nothing was handed over.";
      const task = s(a.task).trim();
      if (!task) return "Error: AskAgent needs a task.";
      const convId = s(a.conversationId).trim() || null;
      // Into the shared stream first: the agent's first turn then shows the hand-off with the voice turns before it.
      appendActivity(vault, voiceToolEntry("AskAgent", a, "")!);
      // A conversation the voice agent started is a voice conversation (its source), not a phone chat. An ordinary
      // message: no project (only Carl puts a chat into a project, in the app — the IEMS 469 hand-off, 2026-10-18).
      const out = await d.message({ text: task, convId, source: "voice" });
      if (!out || out.error) return `Error: ${s(out?.error) || "the agent did not take it"}`;
      return JSON.stringify({ conversationId: out.convId, started: !convId, ...(out.steered ? { steered: true } : {}), ...(out.answered ? { answered: true } : {}) });
    }
    case "AgentStatus":
      return agentStatus(vault, s(a.conversationId).trim(), await store().catch(() => null));
    default: {
      if (VOICE_LOCAL_TOOLS.has(name)) return `${name} moves a screen; there is none on the box, so nothing moved.`;
      const out = await runVaultTool(d, name, a);
      if (out !== null) {
        d.onWrite?.(); // a vault tool may have changed files
        return out;
      }
      return `Error: tool "${name}" is not available on the box.`;
    }
  }
}

// ---------------------------------------------------------------- live sessions

/** A voice session with no tool call or transcript line for this long is over (a client that died without its end line). */
export const VOICE_IDLE_MS = 10 * 60_000;
/** Per vault: when its voice session last did anything. Present = a session is live. */
const voiceLive = new Map<string, number>();

/** A voice session is live in `vault` (its session was minted, a tool ran, a line was said) — or, `ended`, it is over. */
export function voiceActivity(vault: string, ended = false, now = Date.now()): void {
  if (ended) voiceLive.delete(vault);
  else voiceLive.set(vault, now);
}

/** Live voice sessions on this box (one per vault at most): the health's busy
 * counts them, so the updater never restarts the server under someone talking. */
export function activeVoiceSessions(now = Date.now()): number {
  let n = 0;
  for (const at of voiceLive.values()) if (now - at < VOICE_IDLE_MS) n++;
  return n;
}

/** The end-of-session line the clients write ("Voice session ended."). */
const ENDED_LINE = /^voice session ended\b/i;

// ---------------------------------------------------------------- transcripts

/** POST /api/v1/voice/transcript: one line of a voice session (what was said,
 * a tool marker, "Voice session ended") saved on the box. A voice session is a
 * conversation of its own (source "voice"): `convId` names it once the first
 * line made it; a convId that is not a voice conversation on this box (a
 * laptop's local id, an engine chat) starts a new one, tagged with the
 * project of `fromConvId` (the chat the user was in). Returns the id. */
export async function voiceTranscript(d: VoiceDeps, b: any): Promise<{ status: number; body: Record<string, unknown> }> {
  const said = s(b?.text).trim();
  if (!said) return { status: 400, body: { error: "empty transcript line" } };
  // The agent's audio tags ("[excited]") are for its TTS, not the transcript (an older client sends them).
  const text = b?.role !== "user" && b?.system !== true ? stripAudioTags(said) : said;
  if (!text) {
    voiceActivity(d.vault);
    return { status: 200, body: { ok: true, convId: s(b?.convId) || null } };
  }
  const ended = b?.ended === true || (b?.system === true && ENDED_LINE.test(text));
  voiceActivity(d.vault, ended);
  const msg: Record<string, unknown> & { role: "user" | "assistant"; content: string; system?: boolean } = {
    role: b?.role === "user" ? ("user" as const) : ("assistant" as const),
    content: text.slice(0, 20_000),
    ...(b?.system === true ? { system: true } : {}),
    // The client's id for the line: the item's id in the log (a repeat is a no-op; the client confirms its copy in place).
    ...(s(b?.clientId) ? { mid: s(b.clientId).slice(0, 80) } : {}),
    // A tool call voice made: written as a tool row (`text` is its one-line marker, for an older reader).
    ...(b?.tool && typeof b.tool === "object" && s(b.tool.name) ? { toolCalls: [{ name: s(b.tool.name).slice(0, 80), input: toolArgs(b.tool.args), result: s(b.tool.result).slice(0, 4000) }] } : {}),
  };
  const { readConv, createConv, appendMessage } = await import("./engine/convs");
  let id = s(b?.convId);
  const cur = id ? await readConv(d.vault, id) : null;
  // The end of a session where nothing was said: no conversation for it.
  if (ended && (!cur || cur.source !== "voice")) return { status: 200, body: { ok: true, convId: null } };
  if (!cur || cur.source !== "voice") {
    const from = s(b?.fromConvId) ? await readConv(d.vault, s(b.fromConvId)) : null;
    const project = s(b?.project) || (from && typeof from.project === "string" ? from.project : "");
    const c = await createConv(d.vault, { source: "voice", ...(project ? { project } : {}) }, msg.role === "user" ? text : "Voice");
    id = c.id;
  }
  // Images Carl sent in the chat while voice was on (the voice agent got them):
  // saved like any chat capture, so the text agent sees them in the thread later.
  if (msg.role === "user" && Array.isArray(b?.images) && b.images.length) {
    const attachments = saveTranscriptImages(d.vault, id, b.images);
    if (attachments.length) msg.attachments = attachments;
  }
  await appendMessage(d.vault, id, msg as any);
  if (!msg.system) {
    const e = voiceLineEntry(msg.role, text, id);
    if (e) appendActivity(d.vault, { ...e, ...(cur && typeof cur.project === "string" && cur.project ? { project: cur.project } : {}) });
  }
  d.onWrite?.();
  return { status: 200, body: { ok: true, convId: id } };
}

/** A voice tool call's arguments as the row shows them: an object, long strings cut. */
function toolArgs(a: unknown): Record<string, unknown> {
  if (!a || typeof a !== "object" || Array.isArray(a)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a as Record<string, unknown>).slice(0, 20)) {
    if (typeof v === "string") out[k] = v.length > 500 ? v.slice(0, 500) + "…" : v;
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else {
      const j = JSON.stringify(v) ?? "";
      out[k] = j.length > 500 ? j.slice(0, 500) + "…" : v;
    }
  }
  return out;
}

/** Save a voice line's images under .vault-chat/captures/ (≤ 5, ≤ 15 MB each), as the engine saves a chat's. */
function saveTranscriptImages(vault: string, convId: string, images: unknown[]): { imageDataUrl: string; capturedFilePath: string }[] {
  const out: { imageDataUrl: string; capturedFilePath: string }[] = [];
  images.slice(0, 5).forEach((raw, i) => {
    const img = (raw ?? {}) as { mime?: unknown; dataBase64?: unknown };
    const mime = s(img.mime) || "image/png";
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(mime)) return;
    const b64 = s(img.dataBase64).replace(/^data:[^,]*,/, "");
    const buf = Buffer.from(b64, "base64");
    if (!buf.length || buf.length > 15 * 1024 * 1024) return;
    const ext = /jpe?g/i.test(mime) ? ".jpg" : /webp/i.test(mime) ? ".webp" : /gif/i.test(mime) ? ".gif" : ".png";
    const rel = `.vault-chat/captures/${new Date().toISOString().replace(/[:.]/g, "-")}-${convId.slice(0, 8)}-v${i}${ext}`;
    mkdirSync(join(vault, ".vault-chat", "captures"), { recursive: true });
    writeFileSync(join(vault, rel), buf);
    out.push({ imageDataUrl: buf.length < 400_000 ? `data:${mime};base64,${b64}` : "", capturedFilePath: rel });
  });
  return out;
}

/** ListProjects {project?}: Carl's projects and their chats (read-only, the same answer pi gets). */
async function projectsText(vault: string, a: Record<string, unknown>): Promise<string> {
  const { configureContext, ctxConfig, withVault, listProjectsText } = await import("./context");
  let v = "";
  try {
    v = ctxConfig().vault;
  } catch {
    /* not configured yet */
  }
  if (!v) configureContext({ vault });
  const { allConvs } = await import("./engine/convs");
  const convs = (await allConvs(vault).catch(() => [])) as any[];
  const r = withVault(vault, () => listProjectsText(typeof a.project === "string" ? a.project : null, null, convs));
  return r.ok ? r.text : `Error: ${r.text}`;
}

/** POST /api/v1/voice/tool {name, args}. Never throws: errors are the result the agent hears. */
export async function voiceTool(d: VoiceDeps, body: any): Promise<{ result: string }> {
  const name = s(body?.name);
  const args = body?.args ?? body?.arguments ?? body?.parameters ?? {};
  if (!name) return { result: "Error: missing tool name." };
  voiceActivity(d.vault);
  const a = args && typeof args === "object" ? args : {};
  let result: string;
  try {
    result = await runTool(d, name, a);
  } catch (e) {
    result = typeof e === "string" ? e : `Error: ${(e as Error)?.message ?? String(e)}`;
  }
  // What voice changed, into the shared stream (AskAgent wrote its own entry before the hand-off).
  if (name !== "AskAgent") {
    const e = voiceToolEntry(name, a, result, d.vault);
    if (e) appendActivity(d.vault, e);
  }
  return { result };
}

/** The voice builder's marker for "this thread's recent turns are in the prompt" (src/voice-elevenlabs buildSystemPrompt). */
const THREAD_HISTORY_MARK = "Recent conversation context (earlier turns of THIS same thread";
export const hasThreadHistory = (prompt: string) => prompt.includes(THREAD_HISTORY_MARK);

/** The box's one rule on top of the builder's prompt: say only what a tool's result confirms. */
export const VOICE_TRUTH = [
  "What your tools did is only what their results say.",
  "- Say something was done (saved, written, sent, handed over, resolved) only after a tool result says it was, and say where in the result's own words (a note's result names its file and when the laptop gets it).",
  "- After a Write or Edit, read the changed part back (Read) before you say it is done; for a sweeping change, check every place.",
  '- A result that starts with "Error" or says nothing changed means it was not done: say that plainly, and why.',
  "- Never guess where something went or promise where it will show; if Carl asks, read it back (ListNotes, Read) before you answer.",
  "- If Carl says he can't see it, check with a tool before you agree or disagree.",
].join("\n");

/** The voice session's prompt: the builder's, then the shared stream's block, then the box's rule (VOICE_TRUTH). */
export function composeVoicePrompt(base: string, shared: string): string {
  return [base, shared, VOICE_TRUTH].filter(Boolean).join("\n\n");
}

/** The voice session's share of the shared stream: what Carl did lately, and
 * the last exchange of the chat the session was started from (unless
 * `exchange: false` — the prompt carries that chat's turns already). The
 * stream leaves that chat's own exchange out either way. */
export async function voiceContextBlock(d: VoiceDeps, fromConvId: string | null, o: { exchange?: boolean } = {}): Promise<string> {
  const parts: string[] = [];
  let project: string | null = null;
  if (fromConvId) {
    try {
      const { readConv } = await import("./engine/convs");
      const c = await readConv(d.vault, fromConvId);
      if (c) {
        if (typeof c.project === "string" && c.project) project = c.project;
        if (c.source !== "voice" && o.exchange !== false) {
          const msgs = (c.messages ?? []).filter((m: any) => !m.hidden && !m.system && s(m.content).trim());
          const lastUser = [...msgs].reverse().find((m: any) => m.role === "user");
          const lastAgent = [...msgs].reverse().find((m: any) => m.role === "assistant");
          if (lastUser || lastAgent) {
            parts.push(
              [
                `This voice session was started from the chat "${clean(c.title, 120)}" (conversation ${c.id}; AskAgent with that conversationId continues it). Its last exchange:`,
                ...(lastUser ? [`Carl: ${clean(lastUser.content, 600)}`] : []),
                ...(lastAgent ? [`Agent: ${clean(lastAgent.content, 600)}`] : []),
              ].join("\n"),
            );
          }
        }
      }
    } catch {
      /* no conversation */
    }
  }
  // Carl's rules and the project's shared notes (project.md): binding on voice as on every surface (the builder loads AGENTS.md-style files only).
  const proj = await projectContextFor(d.vault, project);
  if (proj) parts.unshift(proj);
  const act = activitySummary(d.vault, { project, excludeConv: fromConvId });
  if (act) parts.push(act);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------- the session

/** GET /api/v1/voice/session: a signed ElevenLabs URL for the box's agent
 * (provisioned with the box's key, the same builder the laptop uses), and the
 * session's prompt. The key itself never leaves the box. */
/** The vault's files for the voice prompt's index, the cheap way: git's index
 * (capped), minus .vault-chat and denied entries. Empty when git can't say. */
export async function fileIndex(vault: string, cap = 2000): Promise<string[]> {
  try {
    const r = await runGit(vault, ["ls-files", "--cached", "--others", "--exclude-standard"]);
    if (r.code !== 0) return [];
    const deny = listLines("read_deny_lines", vault);
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith(".vault-chat/") && !deny.some((x) => under(l, x)))
      .slice(0, cap);
  } catch {
    return [];
  }
}

export async function voiceSession(
  convId: string | null,
  d: VoiceDeps,
  choice: { llm?: string | null; voice?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const v = await import("../src/voice-elevenlabs");
  // The laptop's Settings choice (voice model, voice) — the box's agent follows
  // it; a changed model re-provisions the agent (ensureAgent compares).
  if (choice.llm && v.SUPPORTED_VOICE_LLMS.has(choice.llm)) localStorage.setItem("vault_chat_elevenlabs_llm", choice.llm);
  if (choice.voice && /^[A-Za-z0-9]{8,40}$/.test(choice.voice)) localStorage.setItem("vault_chat_elevenlabs_voice", choice.voice);
  v.resetAgentCreateBreaker();
  // Another vault than the store's: its working copy, its own conversation for
  // the history, and an agent of its own (its own tools).
  const other = d.main === false;
  // The thread's turns, from the box's own conversation (pi's session as the feed folds it), in every vault: the
  // headless store's copy has no voice conversation's lines, so a session continuing one (the board keeps one
  // for as long as Carl is on it) was built without them.
  let history: any[] | undefined;
  if (convId) {
    const { readConv } = await import("./engine/convs");
    history = ((await readConv(d.vault, convId).catch(() => null))?.messages ?? []) as any[];
  }
  const ctx = await v.buildPhoneVoiceContext(convId || undefined, {
    agentOnBox: true,
    fileIndex: await fileIndex(d.vault),
    ...(other ? { vault: d.vault, history: history ?? [], slot: `vault:${d.name ?? d.vault}` } : history?.length ? { history } : {}),
  });
  if (!ctx) {
    const err = v.getLastAgentCreateError();
    return {
      status: 503,
      body: {
        error: err
          ? /^voice [A-Za-z0-9]+: /.test(err.body)
            ? `ElevenLabs won't use the picked ${err.body.slice(0, 400)} — pick another voice in Settings → Voice`
            : `ElevenLabs agent could not be provisioned (HTTP ${err.status})`
          : "voice is not ready on the box (no ElevenLabs key — the laptop's Settings sends it)",
      },
    };
  }
  // The builder already carries this thread's recent turns when it found them: then not its last exchange again.
  const shared = await voiceContextBlock(d, convId, { exchange: !hasThreadHistory(ctx.systemPrompt) }).catch(() => "");
  const systemPrompt = composeVoicePrompt(ctx.systemPrompt, shared);
  // Both credentials, minted at once: a WebRTC conversation token (the
  // recommended transport) and a signed URL (WebSocket: Linux webviews, older clients).
  const [signedUrl, conversationToken] = await Promise.all([
    v.getSignedUrl(ctx.elKey, ctx.agentId, other ? `vault:${d.name ?? d.vault}` : undefined),
    v.getConversationToken(ctx.elKey, ctx.agentId),
  ]);
  if (!signedUrl && !conversationToken) return { status: 502, body: { error: "ElevenLabs refused a signed URL and a conversation token" } };
  // Someone is about to talk: the box is busy until the session's end line (or VOICE_IDLE_MS of silence).
  voiceActivity(d.vault);
  return {
    status: 200,
    body: {
      signedUrl,
      conversationToken,
      agentId: ctx.agentId,
      voiceId: ctx.voiceId,
      systemPrompt,
      dynamicVariables: ctx.dynamicVariables,
      toolNames: ctx.toolNames,
      // Where the prompt's absolute paths point (a client maps them back for ScrollTo).
      vaultRoot: ctx.vault,
      onBox: true,
    },
  };
}
