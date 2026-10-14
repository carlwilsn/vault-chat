// Boot the engine: install/locate the pinned pi, write its agent dir and
// extension, build the sandbox, and hand the HTTP layer the routes it takes
// over (/message, /answer, /kill). Everything runtime-neutral (conversations,
// wakes, keep-going, watchdog, resume, tools, ledger, CONTEXT, /poll) is
// engine.ts; pi itself is pi/backend.ts.
import { mkdirSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { loadCatalog, modelMeta } from "./catalog";
import { configureContext, setModelWindow } from "./context";
import { Engine } from "./engine";
export { engineShuttingDown } from "./engine";
import { Ledger } from "./ledger";
import { excludeLocalDir } from "./wakes";
import { initCapabilities } from "./capabilities";
import { ensurePi, findBwrap, type PiInstall } from "./pi/install";
import { listPiModels, modelWindow, piPaths, vaultPiPaths, writePiConfig, type PiPaths } from "./pi/config";
import { PiBackend, outerWith, type PiSandbox } from "./pi/backend";
import { allConvs, openMirror } from "./convs";

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
  stateDir: string;
  secretsDir: string;
  tokenPath: string;
  localStoragePath: string;
  pushSubsPath: string;
  openrouterBase?: string;
  serverVersion: string;
  apiKey: () => string | null;
  sendPush: (title: string, body: string, url: string, tag: string) => Promise<number>;
  notificationAppend: (vault: string, line: string) => void;
  broadcast: (ev: Record<string, unknown>) => void;
};

export type EngineHandle = {
  engine: Engine | null;
  error: string | null;
  health: () => Record<string, unknown>;
  /** The models the box runs: the chat agent, the vision fallback, the subagent child's default. */
  roles?: () => { chat: string; vision: string; subagent: string };
  /** A vault's sandbox for commands run from the server (voice's Bash and vault tools): the
   * outer layer with the other vaults hidden; null without bubblewrap, undefined before the
   * vault's engine is up. */
  shellFor?: (vault: string) => string[] | null | undefined;
  /** The engine of a vault, started on first use (the main one is `engine`). */
  open?: (v: VaultRef) => Promise<Engine>;
};

export function engineModel(): string {
  let ls: string | null = null;
  try {
    ls = localStorage.getItem("vault_chat_engine_model");
  } catch {
    ls = null;
  }
  return process.env.VC_ENGINE_MODEL || ls || "openai/gpt-6.1-sol";
}

/** Web Push + notifications.jsonl + the /poll "notif" event, . A vault other
 * than the main one: its own feed, and the push opens the phone on that vault. */
export function engineNotify(b: EngineBoot, v?: VaultRef) {
  const vault = v?.path ?? b.vault;
  const q = v && !v.main ? `&vault=${encodeURIComponent(v.name)}` : "";
  return async (n: { kind: "info" | "ask"; title: string; body: string; convId: string; options?: string[] }): Promise<string | null> => {
    const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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
    b.broadcast(v && !v.main ? { vault: v.name, type: "notif" } : { type: "notif" });
    // One push per conversation: the tag is the conversation id (a newer push replaces the older one).
    const sent = await b.sendPush(n.title.slice(0, 90), n.body.slice(0, 180), `/phone?conv=${encodeURIComponent(n.convId)}${q}`, n.convId).catch(() => 0);
    return sent ? id : null;
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

/** Credential locations in the user's home the agent never sees (hidden in both layers, denied to pi's own tools). */
export const HOME_CREDENTIALS = [
  ".ssh",
  ".gnupg",
  ".config/gh",
  ".config/hub",
  ".config/git/credentials",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".docker",
  ".aws",
  ".kube",
  ".password-store",
  ".local/share/keyrings",
  ".config/rclone",
  ".local/state/thinkbox",
  // The default key store and server env file, hidden even when this server is configured elsewhere
  // (a second instance — the test one — must not expose the live box's).
  ".config/vault-chat",
  ".config/vault-chat-server.env",
];

/** A job's sandbox: the agent's outer layer with its own pid namespace (a job cannot see or signal the
 *  server, pi or other jobs) but not tied to the turn — the systemd unit is its parent, not pi. */
export function jobWrap(outer: string[] | null): string[] | null {
  return outer ? outer.filter((x) => x !== "--die-with-parent") : null;
}

/** The server's own environment file (systemd's EnvironmentFile holds tokens): VC_ENV_FILE, else the unit's default. */
export function serverEnvFile(home: string): string {
  return process.env.VC_ENV_FILE || join(home, ".config", "vault-chat-server.env");
}

/** A vault's work area outside the vault (code checkouts, builds, scratch): `~/agent-work/<vault>/`, writable in the sandbox. */
export function agentWorkDir(home: string, vault: string): string {
  return join(home, "agent-work", basename(vault.replace(/[\\/]+$/, "")));
}

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
}): PiSandbox {
  const creds = HOME_CREDENTIALS.map((p) => join(o.home, p));
  const envFile = o.envFile ?? serverEnvFile(o.home);
  const denyRead = [o.secretsDir, ...o.hideFiles, envFile, ...creds, "/proc", ...(o.uid >= 0 ? [`/run/user/${o.uid}`] : [])];
  const denyWrite = [o.stateDir, join(o.vault, ".vault-chat", "conversations"), join(o.vault, ".vault-chat", "local")];
  if (!o.bwrap) return { outer: null, shell: null, denyRead, denyWrite };
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
  // The conversation files and wakes are the server's to write.
  for (const d of [join(o.vault, ".vault-chat", "conversations"), join(o.vault, ".vault-chat", "local")]) if (isDir(d)) mounts.push("--ro-bind", d, d);
  const hide = (p: string) => {
    if (isDir(p)) mounts.push("--tmpfs", p);
    else if (isFile(p)) mounts.push("--ro-bind", "/dev/null", p);
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
  return { outer: [...head, ...mounts, "--"], shell: [...head, ...mounts, "--"], denyRead, denyWrite, roots };
}

/** Boot the engine on pi. */
export async function startEngine(b: EngineBoot): Promise<EngineHandle> {
  const fail = (error: string): EngineHandle => {
    console.error(`[engine:pi] ${error}`);
    return { engine: null, error, health: () => ({ backend: "pi", pi: { state: "missing", error } }) };
  };
  let install: PiInstall;
  try {
    install = await ensurePi(b.stateDir);
  } catch (e) {
    return fail((e as Error).message);
  }
  console.log(`[engine:pi] pi ${install.version} at ${install.cli}${install.installed ? " (installed now)" : ""}`);
  const bwrap = findBwrap();
  if (!bwrap && process.platform === "linux" && process.env.VC_PI_UNSAFE !== "1") {
    return fail("bubblewrap (bwrap) was not found: the pi engine will not run without its sandbox on Linux (set VC_BWRAP, or VC_PI_UNSAFE=1 to run without it)");
  }

  const cat = await loadCatalog(join(b.stateDir, "openrouter-models.json"));
  console.log(`[engine:pi] OpenRouter catalog: ${cat.models} model(s) (${cat.source})`);
  setInterval(() => void loadCatalog(join(b.stateDir, "openrouter-models.json")), 24 * 3_600_000).unref();
  initCapabilities(join(b.stateDir, "capabilities.json"), `pi-${install.version}`);
  const piCat = listPiModels(install);
  const model = engineModel();
  const visionModel = process.env.VC_VISION_MODEL || "openai/gpt-6.1-sol";
  const win = modelWindow(model, piCat);
  setModelWindow(model, win);
  configureContext({ vault: b.vault, agentModel: model, apiKey: b.apiKey, verifierDeny: [b.stateDir, b.tokenPath, b.localStoragePath, b.pushSubsPath] });

  const base = piPaths(b.stateDir);
  const baseUrl = b.openrouterBase ? b.openrouterBase.replace(/\/+$/, "") : undefined;
  writePiConfig({ paths: base, install, catalog: piCat, models: [model, visionModel], baseUrl });
  console.log(`[engine:pi] model ${model} (window ${win}${modelMeta(model) ? "" : piCat.has(model) ? ", pi catalog" : ", defined in models.json"}); sandbox ${bwrap ?? "OFF"}`);

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
  const stateOf = (v: VaultRef) => vaultState(b.stateDir, base, v);

  const sandboxes = new Map<string, PiSandbox>();
  const make = (v: VaultRef): Engine => {
    const st = stateOf(v);
    excludeLocalDir(v.path);
    // The sandbox read-only-binds these; they must exist when it is built.
    for (const d of [join(v.path, ".vault-chat", "conversations"), join(v.path, ".vault-chat", "local"), st.jobs, st.pi.sessionsDir, st.pi.instrDir]) mkdirSync(d, { recursive: true });
    // Its work area outside the vault, writable in the sandbox (the rest of the home is read-only there).
    const workDir = agentWorkDir(home, v.path);
    if (bwrap) mkdirSync(workDir, { recursive: true });
    const others = () => otherVaultPaths(v, vaults(), (w) => stateOf(w).walls);
    const sandbox: PiSandbox = {
      ...buildSandbox({
        bwrap,
        home,
        stateDir: b.stateDir,
        secretsDir: b.secretsDir,
        hideFiles: [b.tokenPath, b.localStoragePath, b.pushSubsPath],
        sessionsDir: st.pi.sessionsDir,
        agentDir: st.pi.agentDir,
        vault: v.path,
        uid,
        jobsDir: st.jobs,
        workDir,
        vaultRoots: [...new Set([dirname(b.vault), dirname(v.path), join(home, "vaults")])],
      }),
      others,
    };
    sandboxes.set(v.name, sandbox);
    const backend = new PiBackend({
      install,
      paths: st.pi,
      catalog: piCat,
      sandbox,
      apiKey: b.apiKey,
      thinking: process.env.VC_PI_THINKING || "medium",
      idleMs: Number(process.env.VC_PI_IDLE_MS) || 10 * 60_000,
      maxProcs: Number(process.env.VC_PI_MAX_PROCS) || 6,
      subagents: {
        agentsDirs: [st.pi.agentsDir, join(v.path, ".vault-chat", "agents")],
        concurrency: Number(process.env.VC_PI_SUBAGENT_CONCURRENCY) || 4,
        maxTasks: Number(process.env.VC_PI_SUBAGENT_MAX_TASKS) || 8,
        hostMax: Number(process.env.VC_PI_SUBAGENT_HOST_MAX) || 8,
        timeoutMs: Number(process.env.VC_PI_SUBAGENT_TIMEOUT_MS) || 30 * 60_000,
        graceMs: Number(process.env.VC_PI_SUBAGENT_GRACE_MS) || 5_000,
        defaultModel: process.env.VC_PI_SUBAGENT_MODEL || null,
      },
      ...(v.main ? {} : { log: (m: string) => console.log(`[pi:${v.name}] ${m}`) }),
    });
    const jobEnv = {
      logDir: st.jobs,
      // Jobs outlive turns: the same hiding as pi's sandbox (the other vaults included), in a pid namespace of their own.
      get wrap() {
        return jobWrap(outerWith(sandbox));
      },
      env: { PATH: process.env.PATH ?? "/run/current-system/sw/bin", HOME: home },
    };
    const engine = new Engine({
      vault: v.path,
      backend,
      ledger: new Ledger(st.ledger, b.apiKey, baseUrl ?? "https://openrouter.ai/api/v1"),
      jobEnv,
      model: engineModel,
      webSearchModel: process.env.VC_WEBSEARCH_MODEL || "google/gemini-2.5-flash-lite",
      apiKey: b.apiKey,
      broadcast: v.main ? b.broadcast : (ev) => b.broadcast({ vault: v.name, ...ev }),
      visionModel,
      stallMs: Number(process.env.VC_ENGINE_STALL_MS) || 30 * 60_000,
      notify: engineNotify(b, v.main ? undefined : v),
      ...(v.main ? {} : { log: (m: string) => console.log(`[engine:${v.name}] ${m}`) }),
      deny: others,
    });
    engine.start();
    backend.start();
    return engine;
  };

  const engine = make(mainRef);
  const engines = new Map<string, Engine>([[mainRef.name, engine]]);
  const opening = new Map<string, Promise<Engine>>();
  const open = (v: VaultRef): Promise<Engine> => {
    if (v.main || v.path === b.vault) return Promise.resolve(engine);
    const hit = opening.get(v.name);
    if (hit) return hit;
    const p = (async () => {
      // Its conversations in a mirror of their own (never the store: its persist writes the main vault).
      const seed = await allConvs(v.path).catch(() => []);
      openMirror(v.path, seed, (ev) => b.broadcast({ vault: v.name, ...ev }), () => b.onTurnEnded?.(v.name));
      const e = make(v);
      engines.set(v.name, e);
      console.log(`[engine:pi] vault ${v.name}: engine started (${seed.length} conversation(s))`);
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
      version: install.version,
      ...(engines.size > 1 ? { vaults: Object.fromEntries([...engines].filter(([n]) => n !== mainRef.name).map(([n, e]) => [n, e.health()])) } : {}),
    }),
    // A child runs on its agent's model, else VC_PI_SUBAGENT_MODEL, else the parent's (subagents.ts).
    roles: () => ({ chat: engineModel(), vision: visionModel, subagent: process.env.VC_PI_SUBAGENT_MODEL || engineModel() }),
    shellFor: (name) => {
      const sb = sandboxes.get(name);
      return sb ? outerWith(sb) : undefined;
    },
    open,
  };
}

/** Where a vault's engine state lives: the main vault's where it always was (no
 * data moves); another vault's pi sessions and jobs under <state>/vaults/<name>/,
 * its ledger beside its wakes. `walls`: what the other vaults' agents may not see. */
export function vaultState(stateDir: string, base: PiPaths, v: VaultRef): { pi: PiPaths; jobs: string; ledger: string; walls: string[] } {
  if (v.main) return { pi: base, jobs: join(stateDir, "jobs"), ledger: join(stateDir, "ledger.json"), walls: [base.sessionsDir, base.instrDir, join(stateDir, "jobs")] };
  const root = join(stateDir, "vaults", v.name);
  return { pi: vaultPiPaths(base, join(root, "pi")), jobs: join(root, "jobs"), ledger: join(v.path, ".vault-chat", "local", "ledger.json"), walls: [root] };
}

/** What one vault's agent may not read or write: every other vault's working copy, bare repo and engine state. */
export function otherVaultPaths(v: VaultRef, all: VaultRef[], walls: (w: VaultRef) => string[]): string[] {
  return all.filter((w) => w.path !== v.path).flatMap((w) => [w.path, ...(w.bare ? [w.bare] : []), ...walls(w)]);
}
