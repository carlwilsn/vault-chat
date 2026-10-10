// Boot the Codex engine: install/locate the pinned binary, write CODEX_HOME's
// config.toml, start the supervised app-server, and hand the HTTP layer the
// routes it takes over (/message, /answer, /kill for engine conversations).
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { CodexSupervisor } from "./appServer";
import { ensureCodex, type CodexInstall } from "./install";
import { writeCodexConfig, type CodexConfigInput } from "./codexConfig";
import { loadCatalog, modelMeta } from "./catalog";
import { configureContext, setModelWindow } from "./context";
import { Engine } from "./engine";
import { CodexBackend } from "./codexBackend";
import { Ledger } from "./ledger";
import { excludeLocalDir } from "./wakes";
import { initCapabilities } from "./capabilities";

export type EngineBoot = {
  vault: string;
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
  install: CodexInstall | null;
  error: string | null;
  health: () => Record<string, unknown>;
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

/** Web Push + notifications.jsonl + the /poll "notif" event, for either runtime. */
export function engineNotify(b: EngineBoot) {
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
      b.notificationAppend(b.vault, JSON.stringify(rec));
    } catch {
      /* feed is best effort */
    }
    b.broadcast({ type: "notif" });
    // One push per conversation: the tag is the conversation id (a newer push replaces the older one).
    const sent = await b.sendPush(n.title.slice(0, 90), n.body.slice(0, 180), `/phone?conv=${encodeURIComponent(n.convId)}`, n.convId).catch(() => 0);
    return sent ? id : null;
  };
}

/** VC_ENGINE: "codex" runs turns on Codex; anything else (default "pi", Carl 2026-10-11) on pi (server/engine/pi). "0" never gets here (main.ts). */
export async function startEngine(b: EngineBoot): Promise<EngineHandle> {
  if (String(process.env.VC_ENGINE ?? "").trim().toLowerCase() !== "codex") return (await import("./pi")).startPiEngine(b);
  let install: CodexInstall;
  try {
    install = ensureCodex(b.stateDir);
  } catch (e) {
    const error = (e as Error).message;
    console.error(`[engine] ${error}`);
    return { engine: null, install: null, error, health: () => ({ codex: { state: "missing", error } }) };
  }
  console.log(`[engine] codex ${install.version} at ${install.bin}${install.installed ? " (installed now)" : ""}`);

  const cat = await loadCatalog(join(b.stateDir, "openrouter-models.json"));
  console.log(`[engine] model catalog: ${cat.models} model(s) (${cat.source})`);
  // Refreshed daily (capabilities come from it for free).
  setInterval(() => void loadCatalog(join(b.stateDir, "openrouter-models.json")), 24 * 3_600_000).unref();
  // Learned capabilities are stamped with the Codex version: an upgrade makes them stale.
  initCapabilities(join(b.stateDir, "capabilities.json"), install.version);
  const model = engineModel();
  const win = modelMeta(model)?.contextLength;
  if (win) setModelWindow(model, win);
  configureContext({ vault: b.vault, agentModel: model, apiKey: b.apiKey, verifierDeny: [b.stateDir, b.tokenPath, b.localStoragePath, b.pushSubsPath] });
  excludeLocalDir(b.vault);

  const home = process.env.HOME || homedir();
  const uid = (() => {
    try {
      return userInfo().uid;
    } catch {
      return -1;
    }
  })();
  const codexHome = join(b.stateDir, "codex-home");
  const jobsHome = join(b.stateDir, "codex-jobs-home");
  const baseUrl = (b.openrouterBase || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const cfg = (h: string): CodexConfigInput => ({
    home: h,
    baseUrl,
    model,
    write: [...new Set([home, "/tmp", b.vault])],
    readOnly: [join(home, ".config"), b.stateDir],
    deny: [
      b.secretsDir,
      // The phone token, the VAPID keys (in the localStorage file) and the push subscriptions.
      b.tokenPath,
      b.localStoragePath,
      b.pushSubsPath,
      ...(uid >= 0 ? [`/run/user/${uid}`, `/tmp/tmux-${uid}`] : []),
    ],
  });
  writeCodexConfig(cfg(jobsHome));
  mkdirSync(join(b.stateDir, "jobs"), { recursive: true });

  let backend: CodexBackend;
  const sup = new CodexSupervisor({
    bin: install.bin,
    codexHome,
    clientVersion: b.serverVersion,
    beforeStart: () => writeCodexConfig(cfg(codexHome)),
    env: () => {
      // The key goes to the child only; Codex keeps it out of tool shells
      // (shell_environment_policy.exclude) and the profile denies the key store.
      const env: NodeJS.ProcessEnv = { ...process.env };
      const key = b.apiKey();
      if (key) env.OPENROUTER_API_KEY = key;
      return env;
    },
    onServerRequest: (m, p) => backend.onServerRequest(m, p),
  });
  backend = new CodexBackend(sup, install.version, { codexHome, permissions: process.platform === "linux" ? "vc" : null });
  const ledger = new Ledger(join(b.stateDir, "ledger.json"), b.apiKey);
  const engine = new Engine({
    vault: b.vault,
    backend,
    ledger,
    jobEnv: { codexBin: install.bin, jobsHome, logDir: join(b.stateDir, "jobs") },
    model: engineModel,
    webSearchModel: process.env.VC_WEBSEARCH_MODEL || "google/gemini-2.5-flash-lite",
    apiKey: b.apiKey,
    broadcast: b.broadcast,
    visionModel: process.env.VC_VISION_MODEL || "openai/gpt-6.1-sol",
    stallMs: Number(process.env.VC_ENGINE_STALL_MS) || 30 * 60_000,
    notify: engineNotify(b),
  });
  engine.start();
  backend.start();
  return {
    engine,
    install,
    error: null,
    health: () => ({ ...engine.health(), model, version: install.version }),
  };
}
