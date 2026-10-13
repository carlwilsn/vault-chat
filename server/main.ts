// vault-chat-server: the box. The engine runs every turn; the phone host and sync run headless here.
// Boot order matters: browser globals first (store.ts reads localStorage at
// import), then the command table, then the app modules (dynamic imports so
// they evaluate after the shims).
import "./shims/globals";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, SERVER_VERSION, SERVER_REV } from "./config";
import { registerCommands } from "./commands";
import { initRing } from "./ring";
import { loadKeyStore, hasKey, keychainCommands, saveKeys, keyNames } from "./keys";
import { hostname } from "node:os";
import { getRing } from "./ring";

function fatal(msg: string, code = 2): never {
  console.error(`[vault-chat-server] FATAL: ${msg}`);
  process.exit(code);
}

/** Test hook: point OpenRouter at a scripted fake (never set in prod). */
function installOpenRouterRewrite(base: string): void {
  const real = globalThis.fetch;
  const from = "https://openrouter.ai/api/v1";
  const to = base.replace(/\/+$/, "");
  globalThis.fetch = ((input: any, init?: any) => {
    if (typeof input === "string" && input.startsWith(from)) input = to + input.slice(from.length);
    else if (input instanceof URL && input.href.startsWith(from)) input = to + input.href.slice(from.length);
    else if (input && typeof input === "object" && typeof input.url === "string" && input.url.startsWith(from)) {
      input = new Request(to + input.url.slice(from.length), input);
    }
    return real(input, init);
  }) as typeof fetch;
}

let gitState: "ok" | "missing" = "missing";
function checkGit(): void {
  const r = spawnSync("git", ["--version"], { windowsHide: true, timeout: 10_000 });
  gitState = r.status === 0 ? "ok" : "missing";
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`[vault-chat-server] v${SERVER_VERSION}${SERVER_REV ? ` (${SERVER_REV})` : ""} starting — vault ${cfg.vault}`);
  if (!existsSync(cfg.vault) || !statSync(cfg.vault).isDirectory()) {
    fatal(`VC_VAULT ${cfg.vault} is not a directory (set VC_VAULT to the box working copy)`);
  }

  registerCommands();
  initRing(join(cfg.stateDir, "poll-seq"));

  // Keys: in-process from the box's encrypted store. No OpenRouter key, no
  // missions — refuse to start rather than run turns with zero keys.
  const ks = await loadKeyStore(cfg.secretsDir);
  if (ks.error) console.error(`[vault-chat-server] ${ks.error}`);
  // No OpenRouter key: the server still starts (health says hasKey: false) so
  // the laptop's Settings can send one (POST /api/v1/keys); turns fail until then.
  if (!hasKey("api.openrouter")) {
    console.error(
      `[vault-chat-server] no "api.openrouter" key in the key store (${cfg.secretsDir}/secrets.age). ` +
        `Turns cannot run until one is added (laptop: Settings → Box → Box's OpenRouter key).`,
    );
  }
  if (cfg.openrouterBase) installOpenRouterRewrite(cfg.openrouterBase);

  checkGit();
  setInterval(checkGit, 60_000).unref();

  // ---- the app, headless ----
  const store = await import("../src/store");
  const { useStore } = store;
  useStore.getState().setVault(cfg.vault);
  await store.hydrateKeychain();
  await useStore.getState().loadConversations();
  const loaded = useStore.getState().conversations.length;
  console.log(`[vault-chat-server] ${loaded} conversation(s) loaded; keys: ${Object.keys(useStore.getState().apiKeys).join(", ") || "none"}`);

  const { startPhoneAppHost, sendPush } = await import("../src/phoneApp");
  await startPhoneAppHost();

  // Every agent turn runs in pi (server/engine). The old in-process loop
  // stays in the bundle for legacy mission threads until Phase 3 removes it.
  const { notificationAppend } = await import("./commands/phone");
  const { startEngine } = await import("./engine");
  const { modelsList, boxModelChecks } = await import("./engine/capabilities");
  // The engine starts in the background (a first start installs pi with npm,
  // which can take minutes): the server answers at once, health says
  // "starting", and agent routes say so until it is up.
  type Handle = Awaited<ReturnType<typeof startEngine>>;
  let engine: Handle = { engine: null, error: null, health: () => ({ backend: "pi", pi: { state: "starting" } }) };
  const engineBoot: Promise<Handle> = process.env.VC_ENGINE === "0"
    ? Promise.resolve({ engine: null, error: "disabled (VC_ENGINE=0): turns run on the old in-process loop", health: () => ({}) })
    : startEngine({
    vault: cfg.vault,
    stateDir: cfg.stateDir,
    secretsDir: cfg.secretsDir,
    tokenPath: cfg.tokenPath,
    localStoragePath: cfg.localStoragePath,
    pushSubsPath: cfg.pushSubsPath,
    openrouterBase: cfg.openrouterBase,
    serverVersion: SERVER_VERSION,
    apiKey: () => {
      const v = keychainCommands.keychain_get({ key: "api.openrouter" });
      return typeof v === "string" && v ? v : null;
    },
    sendPush: (title, body, url, tag) => sendPush(title, body, url, tag),
    notificationAppend,
    broadcast: (ev) => getRing().push(JSON.stringify(ev)),
  });
  void engineBoot
    .then((h) => {
      engine = h;
      console.log(`[vault-chat-server] engine ${h.engine ? "up" : `not running: ${h.error}`}`);
    })
    .catch((e) => {
      engine = { engine: null, error: String((e as Error)?.message ?? e), health: () => ({}) };
      console.error(`[vault-chat-server] engine failed to start: ${engine.error}`);
    });
  const ready = () => {
    if (engine.engine) return engine.engine;
    throw new Error(engine.error ? `the agent engine is not running: ${engine.error}` : "the agent engine is still starting — try again in a minute");
  };

  const { activeRuns } = await import("../src/runRegistry");
  const { startBoxSync, syncStatus, syncSummary, triggerSync, listVaults, addVault } = await import("./sync");
  // The tag becomes the Web Push tag, so a repeat alert replaces the last one.
  const alert = async (title: string, body: string, tag?: string) => {
    try {
      return await sendPush(title, body, "/phone", tag || "vault-chat");
    } catch (e) {
      console.warn("[alert] push failed:", e);
      return 0;
    }
  };

  // After each turn ends, run a sync cycle so results reach the laptop fast.
  let running = new Set<string>();
  useStore.subscribe((s) => {
    const now = new Set<string>([
      ...Object.keys(s.convRuntime ?? {}),
      ...s.conversations.filter((c) => c.status === "running").map((c) => c.id),
    ]);
    for (const id of running) {
      if (!now.has(id)) {
        triggerSync();
        break;
      }
    }
    running = now;
  });

  const { startHttpServer } = await import("./http");
  const server = await startHttpServer({
    health: async () => ({
      ok: true,
      app: "vault-chat-server",
      name: hostname(),
      hasKey: hasKey("api.openrouter"),
      keyNames: keyNames(),
      version: SERVER_VERSION,
      rev: SERVER_REV,
      vault: cfg.vaultName,
      git: gitState,
      keys: { openrouter: hasKey("api.openrouter"), elevenlabs: hasKey("service.elevenlabs") },
      busy: { runs: activeRuns().length },
      conversations: useStore.getState().conversations.length,
      sync: syncSummary(),
      engine: engine.error ? { error: engine.error } : engine.health(),
    }),
    syncStatus,
    alert,
    onGitPushed: (name) => triggerSync(name),
    vaults: { list: listVaults, add: addVault },
    setKeys: async (keys) => {
      const changed = await saveKeys(cfg.secretsDir, keys);
      if (changed) {
        await store.hydrateKeychain();
        console.log(`[vault-chat-server] keys from the laptop: ${Object.keys(keys).sort().join(", ") || "none"}`);
      }
      return changed;
    },
    engine: process.env.VC_ENGINE === "0"
      ? undefined
      : {
          models: () => (engine.engine ? modelsList() : []),
          boxModels: () => (engine.engine && engine.roles ? boxModelChecks(engine.roles()) : undefined),
          message: async (b) => ready().message(b),
          answer: async (b) => ready().answerRoute(b),
          kill: async (b) => ready().kill(b),
          subagent: async (c, sid, op, b) => ready().subagent(c, sid, op, b),
        },
    // Voice (server/voice.ts): one vault for now — the main one; a per-vault
    // engine maps `vault` to its own working copy and engine here.
    voice: (vault) => {
      if (vault && vault !== cfg.vaultName) return { error: `voice is not set up for vault "${vault}" on this box (only ${cfg.vaultName})` };
      return {
        vault: cfg.vault,
        get shell() {
          return engine.engine ? engine.shell : undefined;
        },
        message: async (b) => ready().message(b),
        onWrite: () => triggerSync(),
        openrouterKey: () => {
          const v = keychainCommands.keychain_get({ key: "api.openrouter" });
          return typeof v === "string" && v ? v : null;
        },
        webSearchModel: process.env.VC_WEBSEARCH_MODEL || "google/gemini-2.5-flash-lite",
      };
    },
  });
  console.log(`[vault-chat-server] listening on http://${cfg.host}:${cfg.port}`);

  // Only this machine fires schedules and missions.
  const { startSchedulerLoop } = await import("../src/schedulerLoop");
  void startSchedulerLoop(cfg.vault);

  await startBoxSync(alert);

  const shutdown = (sig: string) => {
    console.log(`[vault-chat-server] ${sig} — shutting down`);
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (e) => {
  console.error("[vault-chat-server] unhandled rejection:", e);
});

main().catch((e) => fatal(`boot failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, 1));
