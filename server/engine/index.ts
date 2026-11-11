import { globalCutover } from "../convlog/globalCutover";
// Boot the engine: install/locate the pinned pi, write its agent dir and
// extension, build the sandbox, and hand the HTTP layer the routes it takes
// over (/message, /answer, /kill). Everything runtime-neutral (conversations,
// wakes, jobs, resume, tools, ledger, CONTEXT, /poll) is
// engine.ts; pi itself is pi/backend.ts.
import { mkdirSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { configureContext } from "./context";
import { Engine, type EngineNotice } from "./engine";
import { registeredVaultContent } from "./vaultContent";
export { engineShuttingDown } from "./engine";
import { excludeLocalDir } from "./wakes";
import { boxLogs } from "../boxLogs";
import { turnSummary } from "./turnLog";
import { initCapabilities } from "./capabilities";
import { findBwrap } from "./sandbox-build";
import { agentWorkDir } from "../workArea";
import { HOME_CREDENTIALS, activeFolders, setFolderWalls, under as underDir } from "../projectFolders";
import { isGatedProject } from "../projectChanges";
import { masterDir, masterLayout } from "../master";
import { outerWith, type Sandbox } from "./sandbox";
import { ClaudeCodeBackend } from "./claude/backend";
import { wallsOf } from "./claude/filePolicy";
import { isClaudeModel, isEffort, validModel, type Effort } from "./claude/models";
import type { ModelChoice } from "./backend";
import { McpRuntime } from "../mcp/runtime";
import { claudePaths, type ClaudePaths } from "./claude/paths";
import { claudeCliEnv } from "./claude/cliEnv";
import { findClaude, type ClaudeInstall } from "./claude/install";
import { logOf } from "./convs";
import { signal } from "../convlog/log";
import { agentKeyEnv, claudeCodeToken } from "../keys";
import { sweepJobEnvFiles } from "./jobs";
import { PushGate, pushGate } from "../pushGate";
import { legacyPushEnabled } from "../pushPreferences";

/** A vault on this box: its working copy and bare repo. The main one keeps the paths it always had. */
export type VaultRef = { name: string; path: string; bare: string; main: boolean };

export type EngineBoot = {
  vault: string;
  /** The main vault's name. */
  vaultName?: string;
  /** Every vault on the box, the main one included (sync.ts listVaults). */
  vaults?: () => VaultRef[];
  /** A turn ended in a vault other than the main one (a sync cycle brings the result to the laptop). */
  onTurnEnded?: (name: string) => void;
  /** The agent wrote files in a vault (vault-relative paths): publish them now (server/liveEdits.ts). */
  onFilesWritten?: (name: string, paths: string[]) => void;
  stateDir: string;
  secretsDir: string;
  tokenPath: string;
  localStoragePath: string;
  pushSubsPath: string;
  serverVersion: string;
  sendPush: (title: string, body: string, url: string, tag: string) => Promise<number>;
  notificationAppend: (vault: string, line: string) => void;
};

export type EngineHandle = {
  engine: Engine | null;
  error: string | null;
  health: () => Record<string, unknown>;
  /** The models the box runs: the chat agent, the vision fallback, the subagent child's default. */
  roles?: () => { chat: string; vision: string; subagent: string };
  /**
   * The box's last choice of model, which is what a NEW chat starts on. A chat
   * of its own is set per conversation (Engine.setChatModel) — this is only the
   * default behind it, and nothing in the UI sets it directly any more.
   */
  setModel?: (model: string) => { ok: true; model: string } | { ok: false; error: string };
  /** What a chat can run on, by name (GET /api/v1/models). */
  models?: () => ModelChoice[];
  /** A new sign-in arrived: forget the old verdict, then check the new token. */
  tokenChanged?: () => void;
  /** The engine of a vault, started on first use (the main one is `engine`). */
  open?: (v: VaultRef) => Promise<Engine>;
};

/**
 * The Claude model a chat runs on when nothing else has been chosen. Carl's
 * answer when he was asked: Opus, and the picker beside Send is where he changes
 * it (UPDATE 22:35 — "Opus 5.5 (default)").
 */
const CLAUDE_DEFAULT_MODEL = "opus";

/** One of the box's remembered choices (the last model, the last effort). */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Remember one, best effort: a choice that cannot be written still applies to the chat that made it. */
function setStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* the chat's own field is the record that matters */
  }
}

/**
 * The effort a chat runs at when Carl has not set one for it: his last choice,
 * or the deployment's. None at all means the model decides for itself, which is
 * what every chat did before the control existed.
 */
export function engineEffort(): Effort | undefined {
  const e = stored("vault_chat_engine_effort") ?? process.env.VC_ENGINE_EFFORT ?? null;
  return isEffort(e) ? e : undefined;
}

export function engineModel(): string {
  const ls = stored("vault_chat_engine_model");
  // Carl's choice (set from the laptop) over the deployment's default.
  const chosen = ls || process.env.VC_ENGINE_MODEL || null;
  // Claude Code runs Claude's own models and nothing else. A model id left over
  // from the OpenRouter days — the old default was openai/gpt-6.1-sol — is not
  // one it can run, and handing it one fails EVERY turn with "issue with the
  // selected model". So a non-Claude choice gives way to the Claude default
  // instead of breaking the chat.
  return chosen && isClaudeModel(chosen) ? chosen : process.env.VC_CLAUDE_MODEL || CLAUDE_DEFAULT_MODEL;
}

/** Web Push + notifications.jsonl + the /poll "notif" event, . A vault other
 * than the main one: its own feed, and the push opens the phone on that vault.
 * The feed always gets the card; the phone buzzes only as the push gate's rule says. */
export function engineNotify(b: EngineBoot, v?: VaultRef) {
  const vault = v?.path ?? b.vault;
  const q = v && !v.main ? `&vault=${encodeURIComponent(v.name)}` : "";
  let own: PushGate | null = null;
  const gateOf = () => pushGate() ?? (own ??= new PushGate({ send: b.sendPush, legacyEnabled: legacyPushEnabled }));
  return async (n: EngineNotice): Promise<string | null> => {
    const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    if (!n.pushOnly) {
      const rec: Record<string, unknown> = { id, ts: Date.now(), kind: n.kind, title: n.title.slice(0, 90), body: n.body.slice(0, 2000), convId: n.convId };
      if (n.kind === "ask") {
        rec.deliberation = {
          ask: n.body.slice(0, 600),
          options: (n.options ?? []).slice(0, 6).map((o) => ({ answer: o.slice(0, 200), title: o.slice(0, 120), body: "" })),
        };
      }
      try {
        b.notificationAppend(vault, JSON.stringify(rec));
      } catch {
        /* feed is best effort */
      }
      signal(vault, { type: "notif" });
    }
    // One push per conversation: the tag is the conversation id (a newer push replaces the older one).
    const d = await gateOf()
      .offer({
        vault,
        eventId: id,
        explicitPush: n.explicitPush,
        workId: n.workId,
        why: n.why ?? (n.kind === "ask" ? "ask" : "finished"),
        title: n.title.slice(0, 90),
        body: n.body.slice(0, 180),
        url: `/phone?conv=${encodeURIComponent(n.convId)}${q}`,
        tag: n.convId,
        convId: n.convId,
        trigger: n.trigger ?? (n.kind === "ask" ? "AskUser" : "Notify"),
        byCarl: n.byCarl,
        stillNeeded: n.stillNeeded,
      })
      .catch(() => null);
    // The card's id when there is one (the feed), else whether the phone was sent it.
    return !n.pushOnly || (d?.act === "push" && d.sent) ? id : null;
  };
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Credential locations in the user's home the agent never sees (server/projectFolders.ts). */
export { HOME_CREDENTIALS } from "../projectFolders";

/** A job's sandbox: the agent's outer layer with its own pid namespace (a job cannot see or signal the
 *  server, pi or other jobs) but not tied to the turn — the systemd unit is its parent, not pi. */
export function jobWrap(outer: string[] | null): string[] | null {
  return outer ? outer.filter((x) => x !== "--die-with-parent") : null;
}

/** The agent runs unsandboxed: Carl wants no bounds on it (a bypass-permissions agent with the
 *  whole box, systemctl and its session bus included). VC_AGENT_SANDBOX=1 puts the bubblewrap layer back. */
export function agentOuter(sb: Sandbox): string[] | null {
  return process.env.VC_AGENT_SANDBOX === "1" ? outerWith(sb) : null;
}

/** The server's own environment file (systemd's EnvironmentFile holds tokens): VC_ENV_FILE, else the unit's default. */
export function serverEnvFile(home: string): string {
  return process.env.VC_ENV_FILE || join(home, ".config", "vault-chat-server.env");
}

/** A vault's work area outside the vault (server/workArea.ts). */
export { agentWorkDir } from "../workArea";

const under = (p: string, dir: string) => {
  const r = relative(dir, p);
  return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r));
};

/**
 * The two bubblewrap layers. pi itself runs in the outer one: its own pid
 * namespace (killing it kills every descendant, detached or not). The home
 * directory is read-only; writable are only the vault's own working copy, pi's
 * sessions and agent dir, the vault's jobs dir, its work area
 * (`~/agent-work/<vault>/`) and /tmp. Every vault root is hidden (all vaults
 * and bare repos on the box, known to this server or not) and the own vault is
 * bound back in. Hidden: the key store, the phone token / VAPID keys / push
 * subscriptions, the server's env file, credential dirs (HOME_CREDENTIALS),
 * the user's systemd and tmux sockets (both would run commands outside). The
 * conversation files and wakes stay the server's (read-only). Each shell
 * command runs in the inner layer: the same mounts again (it inherits the
 * outer view anyway) and a pid namespace of its own (it cannot see pi's process).
 * Network and the nix store are untouched.
 */
export function buildSandbox(o: {
  bwrap: string | null;
  home: string;
  stateDir: string;
  secretsDir: string;
  hideFiles: string[];
  sessionsDir: string;
  agentDir: string;
  vault: string;
  uid: number;
  /** Directories holding vaults and bare repos (default: the vault's parent and ~/vaults). */
  vaultRoots?: string[];
  /** The vault's jobs dir (StartJob logs). */
  jobsDir?: string;
  /** The vault's work area (default agentWorkDir(home, vault)). */
  workDir?: string;
  /** The server's env file (default serverEnvFile(home)). */
  envFile?: string;
}): Sandbox {
  const creds = HOME_CREDENTIALS.map((p) => join(o.home, p));
  const envFile = o.envFile ?? serverEnvFile(o.home);
  const denyRead = [o.secretsDir, ...o.hideFiles, envFile, ...creds, "/proc", ...(o.uid >= 0 ? [`/run/user/${o.uid}`] : [])];
  const denyWrite = [o.stateDir, join(o.vault, ".vault-chat", "conversations"), join(o.vault, ".vault-chat", "events"), join(o.vault, ".vault-chat", "local")];
  if (!o.bwrap) return { vault: o.vault, outer: null, shell: null, denyRead, denyWrite };
  const work = o.workDir ?? agentWorkDir(o.home, o.vault);
  const roots = [...new Set((o.vaultRoots ?? [dirname(o.vault), join(o.home, "vaults")]).map((r) => r.replace(/[\\/]+$/, "")))]
    // Never the home itself (or above it), never a root that holds the server's state.
    .filter((r) => isDir(r) && !under(o.home, r) && !under(o.stateDir, r));
  const mounts: string[] = [];
  // Later mounts win: home read-only, the vault roots emptied, the state read-only,
  // then the writable dirs, then the server's files inside them read-only, then what is hidden.
  if (isDir(o.home)) mounts.push("--ro-bind", o.home, o.home);
  for (const r of roots) mounts.push("--tmpfs", r);
  if (isDir(o.stateDir)) mounts.push("--ro-bind", o.stateDir, o.stateDir);
  for (const d of [o.vault, o.sessionsDir, o.agentDir, ...(o.jobsDir ? [o.jobsDir] : []), work]) if (isDir(d)) mounts.push("--bind", d, d);
  for (const f of ["settings.json", "models.json"]) if (isFile(join(o.agentDir, f))) mounts.push("--ro-bind", join(o.agentDir, f), join(o.agentDir, f));
  // The conversation log (and the older conversation files) and wakes are the server's to write.
  for (const d of [join(o.vault, ".vault-chat", "conversations"), join(o.vault, ".vault-chat", "events"), join(o.vault, ".vault-chat", "local")]) if (isDir(d)) mounts.push("--ro-bind", d, d);
  const hidden: string[] = [];
  const hide = (p: string) => {
    if (isDir(p)) mounts.push("--tmpfs", p, "--remount-ro", p);
    else if (isFile(p)) mounts.push("--ro-bind", "/dev/null", p);
    else return;
    hidden.push(p);
  };
  hide(o.secretsDir);
  for (const f of o.hideFiles) hide(f);
  hide(envFile);
  for (const c of creds) hide(c);
  if (o.uid >= 0) {
    hide(`/run/user/${o.uid}`);
    hide(`/tmp/tmux-${o.uid}`);
  }
  const head = [o.bwrap, "--dev-bind", "/", "/", "--proc", "/proc", "--unshare-pid", "--die-with-parent"];
  return { vault: o.vault, outer: [...head, ...mounts, "--"], shell: [...head, ...mounts, "--"], denyRead, denyWrite, roots, hidden };
}

/** Boot the engine. Claude Code is the engine; there is no other. */
export async function startEngine(b: EngineBoot): Promise<EngineHandle> {
  const fail = (error: string): EngineHandle => {
    console.error(`[engine:claude] ${error}`);
    return { engine: null, error, health: () => ({ backend: "claude", claude: { state: "missing", error } }) };
  };
  const claudeFound = findClaude({ stateDir: b.stateDir });
  if (!("install" in claudeFound)) {
    return fail(`no Claude Code on this box: ${claudeFound.error} — ${claudeFound.tried.join("; ")}`);
  }
  const claudeInstall: ClaudeInstall = claudeFound.install;
  console.log(`[engine:claude] Claude Code ${claudeInstall.version} at ${claudeInstall.cli} (${claudeInstall.source})`);

  const bwrap = findBwrap();
  // VC_PI_UNSAFE is the name every test and the ship host already use for
  // this, so it keeps working; VC_SANDBOX_UNSAFE is what it is called now.
  const unsafe = process.env.VC_SANDBOX_UNSAFE === "1" || process.env.VC_PI_UNSAFE === "1";
  if (!bwrap && process.platform === "linux" && !unsafe) {
    return fail("bubblewrap (bwrap) was not found: the agent will not run without its sandbox on Linux (set VC_BWRAP, or VC_SANDBOX_UNSAFE=1 to run without it)");
  }

  initCapabilities(join(b.stateDir, "capabilities.json"), `claude-${claudeInstall.version}`);
  const model = engineModel();
  const visionModel = process.env.VC_VISION_MODEL || process.env.VC_CLAUDE_FAST_MODEL || "haiku";
  configureContext({ vault: b.vault, conversationRoot: b.vault, agentModel: model, vaults: () => (b.vaults?.() ?? []).map((v) => v.path) });

  console.log(`[engine:claude] model ${model}; sandbox ${bwrap ?? "OFF"}`);

  const home = process.env.HOME || homedir();
  const uid = (() => {
    try {
      return userInfo().uid;
    } catch {
      return -1;
    }
  })();

  const mainRef: VaultRef = { name: b.vaultName ?? "main", path: b.vault, bare: "", main: true };
  const vaults = (): VaultRef[] => b.vaults?.() ?? [mainRef];
  const stateOf = (v: VaultRef) => vaultState(b.stateDir, v);

  const make = (v: VaultRef): Engine => {
    const st = stateOf(v);
    excludeLocalDir(v.path);
    // The sandbox read-only-binds these; they must exist when it is built.
    for (const d of [join(v.path, ".vault-chat", "conversations"), join(v.path, ".vault-chat", "events"), join(v.path, ".vault-chat", "local"), st.jobs]) mkdirSync(d, { recursive: true });
    // Its conversation log is open (older files are imported as they are opened).
    logOf(v.path);
    // Its work area outside the vault, writable in the sandbox (the rest of the home is read-only there).
    const workDir = agentWorkDir(home, v.path);
    if (bwrap) mkdirSync(workDir, { recursive: true });
    const content = registeredVaultContent(v, vaults, (w) => stateOf(w).walls);
    const others = () => content().hidden;
    // The vault-chat folder's hubs (server/master.ts) are hidden like the vault roots.
    const m = masterDir();
    const vaultRoots = [...new Set([dirname(b.vault), dirname(v.path), join(home, "vaults"), ...(m ? [masterLayout(m).vaults, masterLayout(m).hub] : [])])];
    // A project folder Carl chose (server/projectFolders.ts) may be neither inside nor around anything this
    // sandbox hides or keeps read-only: the server's state and env file, the key store, the tokens, the
    // private vault metadata and bare repos, the vault roots.
    setFolderWalls(v.path, {
      home,
      protect: () => [b.stateDir, b.secretsDir, serverEnvFile(home), b.tokenPath, b.localStoragePath, b.pushSubsPath, ...vaultRoots.filter((r) => !underDir(home, r)), ...others()].filter(Boolean),
    });
    const sandbox: Sandbox = {
      ...buildSandbox({
        bwrap,
        home,
        stateDir: b.stateDir,
        secretsDir: b.secretsDir,
        hideFiles: [b.tokenPath, b.localStoragePath, b.pushSubsPath],
        sessionsDir: st.claude.root,
        agentDir: st.claude.configDir,
        vault: v.path,
        uid,
        jobsDir: st.jobs,
        workDir,
        vaultRoots,
      }),
      others,
      vaultContent: () => content().folders,
      // The project folders Carl chose outside the vault: read-write, read at each spawn.
      projects: () => activeFolders(v.path).map((f) => f.abs).filter((f) => !underDir(f, v.path) && !isGatedProject(f)),
      // A project that is a git repo: its folder read-only; the agent works in its clone in the work area (Keep is Carl's).
      readOnly: () => [...new Set(vaults().flatMap(w => activeFolders(w.path).map(f => f.abs)))].filter(f => isGatedProject(f)),
    };
    // A job's keys travel in a 0600 EnvironmentFile (never systemd-run's argv) that is
    // deleted once the unit started; one a crash left behind is swept here, at boot.
    sweepJobEnvFiles();
    const jobEnv = {
      logDir: st.jobs,
      // Jobs outlive turns: the same registered content and private-state walls as pi's sandbox, in a pid namespace of their own.
      get wrap() {
        return jobWrap(agentOuter(sandbox));
      },
      // Read at each StartJob: the keys as they are now (server/keys.ts agentKeyEnv), written to the job's env file.
      get env() {
        return { PATH: process.env.PATH ?? "/run/current-system/sw/bin", HOME: home, ...agentKeyEnv() };
      },
    };
    // Claude Code's own sessions for this vault: its transcripts go into the
    // feed's own sessions folder, so the clients read them unchanged.
    const claude = new ClaudeCodeBackend({
          install: claudeInstall,
          paths: st.claude,
          vault: v.path,
          feedSessionsDir: join(v.path, ".vault-chat", "events", "sessions"),
          // Only the CLI gets this (phase 6 adds the sign-in token here).
          // Read at each session start: the saved keys as they are now reach every
          // shell, worker and subagent of the session (claude/cliEnv.ts).
          env: () => claudeCliEnv({ processEnv: process.env, configDir: st.claude.configDir, token: claudeCodeToken(), keys: agentKeyEnv() }),
          // The same deny lists pi uses, from the sandbox alone (filePolicy.wallsOf):
          // what Claude Code's own file tools are ruled against when they are on.
          walls: () => wallsOf(sandbox),
          // Claude Code's own file tools, ruled by vault-chat's policy before
          // each call (filePolicy.ruleOnToolUse, through the PreToolUse hook).
          // The host's own file tools were pi's — they ran pi's core tools in
          // pi's sandbox — so with pi gone these are the file tools there are.
          ownFileTools: process.env.VC_CLAUDE_OWN_FILE_TOOLS !== "0",
          // vault-chat's tools, bound per session over its own loopback MCP
          // server: the bearer travels only in the session's HTTP headers.
          mcp: new McpRuntime(),
          toolTimeoutMs: Number(process.env.VC_CLAUDE_TOOL_TIMEOUT_MS) || 6 * 3_600_000,
          // The same outer layer pi gets, read at each session start.
          sandbox: () => agentOuter(sandbox),
          // The box's one-shots (a note's title, spoken maths) run on the fast model.
          fastModel: process.env.VC_CLAUDE_FAST_MODEL || "haiku",
          idleMs: Number(process.env.VC_CLAUDE_IDLE_MS) || 10 * 60_000,
          maxSessions: Number(process.env.VC_CLAUDE_MAX_SESSIONS) || 4,
          ...(v.main ? {} : { log: (m: string) => console.log(`[claude:${v.name}] ${m}`) }),
    });
    const engine = new Engine({
      vault: v.path,
      backend: claude,
      jobEnv,
      model: () => engineModel(),
      effort: () => engineEffort(),
      rememberModel: (m) => void setStored("vault_chat_engine_model", m),
      rememberEffort: (e) => void setStored("vault_chat_engine_effort", e),
      broadcast: (ev) => signal(v.path, ev),
      // A chat lives in the log of the vault that holds it: the agent's Delete/Restore reach that vault's engine.
      engineAt: async (path) => {
        const ref = vaults().find((x) => x.path === path);
        return ref ? open(ref) : null;
      },
      onTurnEnded: () => b.onTurnEnded?.(v.name),
      visionModel,
      notify: engineNotify(b, v.main ? undefined : v),
      ...(v.main ? {} : { log: (m: string) => console.log(`[engine:${v.name}] ${m}`) }),
      onFilesWritten: (paths) => b.onFilesWritten?.(v.name, paths),
      vaultName: v.name,
      // The vault's own tools use the same registered content capabilities as commands.
      // Vault tools served to external MCP clients keep the bubblewrap layer: that is their
      // authority boundary (server/mcp/recordUI.ts), not a bound on Carl's agent.
      shell: () => outerWith(sandbox),
      // One line per turn: the full record in <state>/logs/turns.jsonl, a summary in the journal.
      turnLog: (line) => {
        boxLogs(b.stateDir).turns.append(line);
        console.log(turnSummary(line));
      },
    });
    engine.start();
    return engine;
  };

  const engine = make(mainRef);
  const engines = new Map<string, Engine>([[mainRef.name, engine]]);
  const opening = new Map<string, Promise<Engine>>();
  const open = (v: VaultRef): Promise<Engine> => {
    if (v.main || v.path === b.vault || globalCutover(b.vault)?.legacyRoots.includes(v.path)) return Promise.resolve(engine);
    const hit = opening.get(v.name);
    if (hit) return hit;
    const p = (async () => {
      // Its conversations: its own event log.
      const n = logOf(v.path).rows().length;
      const e = make(v);
      engines.set(v.name, e);
      console.log(`[engine] vault ${v.name}: engine started (${n} conversation(s))`);
      return e;
    })();
    opening.set(v.name, p);
    p.catch(() => opening.delete(v.name));
    return p;
  };
  return {
    engine,
    error: null,
    health: () => ({
      ...engine.health(),
      model,
      version: claudeInstall.version,
      ...(engines.size > 1 ? { vaults: Object.fromEntries([...engines].filter(([n]) => n !== mainRef.name).map(([n, e]) => [n, e.health()])) } : {}),
    }),
    // A child runs on the same model as its parent unless it was given one.
    roles: () => ({ chat: engineModel(), vision: visionModel, subagent: process.env.VC_SUBAGENT_MODEL || engineModel() }),
    /** What a chat can run on, by name: the runtime's own list (GET /api/v1/models). */
    models: () => engine.models(),
    setModel: (id: string) => {
      const m = String(id ?? "").trim();
      if (!validModel(m)) return { ok: false as const, error: `"${m.slice(0, 80)}" is not a model id` };
      try {
        localStorage.setItem("vault_chat_engine_model", m);
      } catch (e) {
        return { ok: false as const, error: (e as Error).message };
      }
      // Every thread's next turn runs on it (backend.startTurn).
      configureContext({ agentModel: m });
      console.log(`[engine:claude] model ${m} (Carl's choice)`);
      return { ok: true as const, model: m };
    },
    /**
     * A new sign-in reached the box (server/main.ts setKeys): every vault's
     * engine forgets what the API said about the old token, and the main one
     * spends one tiny call finding out whether the new one works. Carl asked for
     * that check because a token can be stored, pushed and still refused.
     */
    tokenChanged: () => {
      for (const e of engines.values()) e.tokenChanged();
      void engine.checkToken().then((r) => {
        if (r.ok === false) console.log(`[engine:claude] the API refused this box's sign-in: ${r.error ?? "no reason given"}`);
        else if (r.ok) console.log("[engine:claude] sign-in checked: it works");
      });
    },
    open,
  };
}

/** Where a vault's engine state lives: the main vault's where it always was (no
 * data moves); another vault's pi sessions and jobs under <state>/vaults/<name>/,
 * its ledger beside its wakes. `walls`: what the other vaults' agents may not see. */
export function vaultState(stateDir: string, v: VaultRef): { claude: ClaudePaths; jobs: string; ledger: string; walls: string[] } {
  if (v.main) {
    const claude = claudePaths(stateDir);
    return { claude, jobs: join(stateDir, "jobs"), ledger: join(stateDir, "ledger.json"), walls: [claude.root, join(stateDir, "jobs")] };
  }
  const root = join(stateDir, "vaults", v.name);
  return { claude: claudePaths(root), jobs: join(root, "jobs"), ledger: join(v.path, ".vault-chat", "local", "ledger.json"), walls: [root] };
}

/**
 * Which engine a conversation's next thread runs on. Claude Code is the only
 * one there is, so this is a constant — kept as a function because the feed,
 * the clients and the old conversations still ask.
 */
export function boxEngine(): "claude" {
  return "claude";
}

/** Legacy full-isolation projection, retained for old policy callers/tests. Runtime
 * content capabilities use registeredVaultContent; only private paths stay hidden. */
export function otherVaultPaths(v: VaultRef, all: VaultRef[], walls: (w: VaultRef) => string[]): string[] {
  return all.filter((w) => w.path !== v.path).flatMap((w) => [w.path, ...(w.bare ? [w.bare] : []), ...walls(w)]);
}
