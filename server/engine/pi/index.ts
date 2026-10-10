// Boot the pi engine (VC_ENGINE=pi): install/locate the pinned pi, write its
// agent dir and extension, build the sandbox, and hand the HTTP layer the
// same routes the Codex engine takes (/message, /answer, /kill). Everything
// engine-neutral (conversations, wakes, keep-going, watchdog, resume, tools,
// ledger, CONTEXT, /poll) is the shared Engine (../engine.ts); pi is its
// EngineBackend (backend.ts).
import { statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { EngineBoot, EngineHandle } from "../index";
import { engineModel, engineNotify } from "../index";
import { Engine } from "../engine";
import { Ledger } from "../ledger";
import { loadCatalog, modelMeta } from "../catalog";
import { configureContext, setModelWindow } from "../context";
import { excludeLocalDir } from "../wakes";
import { initCapabilities } from "../capabilities";
import { ensurePi, findBwrap, type PiInstall } from "./install";
import { listPiModels, modelWindow, piPaths, writePiConfig } from "./config";
import { PiBackend, type PiSandbox } from "./backend";
import { startJob, jobStatus } from "./jobs";

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

/**
 * The two bubblewrap layers. pi itself runs in the outer one: its own pid
 * namespace (killing it kills every descendant, detached or not), the key
 * store and the phone token / VAPID keys / push subscriptions hidden, the
 * user's systemd and tmux sockets hidden (both would run commands outside),
 * the server's state read-only except pi's sessions and agent dir. Each shell
 * command runs in the inner one: a pid namespace of its own (it cannot see
 * pi's process) and the key store hidden again.
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
}): PiSandbox {
  const denyRead = [o.secretsDir, ...o.hideFiles, "/proc", ...(o.uid >= 0 ? [`/run/user/${o.uid}`] : [])];
  const denyWrite = [o.stateDir, join(o.vault, ".vault-chat", "conversations"), join(o.vault, ".vault-chat", "local")];
  if (!o.bwrap) return { outer: null, shell: null, denyRead, denyWrite };
  const outer: string[] = [o.bwrap, "--dev-bind", "/", "/", "--proc", "/proc", "--unshare-pid", "--die-with-parent"];
  // Later mounts win: the read-only state first, then pi's own writable dirs, then what is hidden.
  if (isDir(o.stateDir)) outer.push("--ro-bind", o.stateDir, o.stateDir);
  for (const d of [o.sessionsDir, o.agentDir]) if (isDir(d)) outer.push("--bind", d, d);
  for (const f of ["settings.json", "models.json"]) if (isFile(join(o.agentDir, f))) outer.push("--ro-bind", join(o.agentDir, f), join(o.agentDir, f));
  // The conversation files and wakes are the server's to write.
  for (const d of [join(o.vault, ".vault-chat", "conversations"), join(o.vault, ".vault-chat", "local")]) if (isDir(d)) outer.push("--ro-bind", d, d);
  const hide = (p: string) => {
    if (isDir(p)) outer.push("--tmpfs", p);
    else if (isFile(p)) outer.push("--ro-bind", "/dev/null", p);
  };
  hide(o.secretsDir);
  for (const f of o.hideFiles) hide(f);
  if (o.uid >= 0) {
    hide(`/run/user/${o.uid}`);
    hide(`/tmp/tmux-${o.uid}`);
  }
  outer.push("--");
  const shell = [o.bwrap, "--dev-bind", "/", "/", "--proc", "/proc", "--unshare-pid", "--die-with-parent"];
  if (isDir(o.secretsDir)) shell.push("--tmpfs", o.secretsDir);
  shell.push("--");
  return { outer, shell, denyRead, denyWrite };
}

export async function startPiEngine(b: EngineBoot): Promise<EngineHandle> {
  const fail = (error: string): EngineHandle => {
    console.error(`[engine:pi] ${error}`);
    return { engine: null, install: null, error, health: () => ({ backend: "pi", pi: { state: "missing", error } }) };
  };
  let install: PiInstall;
  try {
    install = ensurePi(b.stateDir);
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
  excludeLocalDir(b.vault);

  const paths = piPaths(b.stateDir);
  const baseUrl = b.openrouterBase ? b.openrouterBase.replace(/\/+$/, "") : undefined;
  writePiConfig({ paths, install, catalog: piCat, models: [model, visionModel], baseUrl });
  console.log(`[engine:pi] model ${model} (window ${win}${modelMeta(model) ? "" : piCat.has(model) ? ", pi catalog" : ", defined in models.json"}); sandbox ${bwrap ?? "OFF"}`);

  const home = process.env.HOME || homedir();
  const uid = (() => {
    try {
      return userInfo().uid;
    } catch {
      return -1;
    }
  })();
  // The sandbox read-only-binds these; they must exist when it is built.
  for (const d of [join(b.vault, ".vault-chat", "conversations"), join(b.vault, ".vault-chat", "local"), join(b.stateDir, "jobs")]) mkdirSync(d, { recursive: true });
  const sandbox = buildSandbox({
    bwrap,
    home,
    stateDir: b.stateDir,
    secretsDir: b.secretsDir,
    hideFiles: [b.tokenPath, b.localStoragePath, b.pushSubsPath],
    sessionsDir: paths.sessionsDir,
    agentDir: paths.agentDir,
    vault: b.vault,
    uid,
  });
  const backend = new PiBackend({
    install,
    paths,
    catalog: piCat,
    sandbox,
    apiKey: b.apiKey,
    thinking: process.env.VC_PI_THINKING || "medium",
    idleMs: Number(process.env.VC_PI_IDLE_MS) || 10 * 60_000,
    maxProcs: Number(process.env.VC_PI_MAX_PROCS) || 6,
  });
  const jobEnv = {
    logDir: join(b.stateDir, "jobs"),
    // Jobs outlive turns: the same hiding as pi's sandbox, without its pid namespace.
    wrap: sandbox.outer ? sandbox.outer.filter((x) => x !== "--unshare-pid" && x !== "--die-with-parent") : null,
    env: { PATH: process.env.PATH ?? "/run/current-system/sw/bin", HOME: home },
  };
  const engine = new Engine({
    vault: b.vault,
    backend,
    ledger: new Ledger(join(b.stateDir, "ledger.json"), b.apiKey, baseUrl ?? "https://openrouter.ai/api/v1"),
    jobEnv: { codexBin: "", jobsHome: "", logDir: jobEnv.logDir },
    jobs: { start: (cwd, a) => startJob(jobEnv, cwd, a), status: (a) => jobStatus(jobEnv, a) },
    model: engineModel,
    webSearchModel: process.env.VC_WEBSEARCH_MODEL || "google/gemini-2.5-flash-lite",
    apiKey: b.apiKey,
    broadcast: b.broadcast,
    visionModel,
    stallMs: Number(process.env.VC_ENGINE_STALL_MS) || 30 * 60_000,
    notify: engineNotify(b),
  });
  engine.start();
  backend.start();
  return { engine, install: null, error: null, health: () => ({ ...engine.health(), model, version: install.version }) };
}
