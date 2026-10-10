// vault-chat-server: vault-chat's existing mission/phone machinery, headless.
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
import { loadKeyStore, hasKey, keychainCommands } from "./keys";
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
  if (!hasKey("api.openrouter")) {
    fatal(
      `no "api.openrouter" key in the key store (${cfg.secretsDir}/secrets.age). ` +
        `Missions cannot run without it. Add the key with the desktop app on this machine, then restart.`,
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
  const { modelsList } = await import("./engine/capabilities");
  const engine = process.env.VC_ENGINE === "0"
    ? { engine: null, error: "disabled (VC_ENGINE=0): turns run on the old in-process loop", health: () => ({}) }
    : await startEngine({
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

  const { activeRuns } = await import("../src/runRegistry");
  const { startBoxSync, syncStatus, syncSummary, triggerSync } = await import("./sync");
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
      version: SERVER_VERSION,
      rev: SERVER_REV,
      vault: cfg.vaultName,
      git: gitState,
      keys: { openrouter: hasKey("api.openrouter") },
      busy: { runs: activeRuns().length },
      conversations: useStore.getState().conversations.length,
      sync: syncSummary(),
      engine: engine.error ? { error: engine.error } : engine.health(),
    }),
    syncStatus,
    alert,
    onGitPushed: () => triggerSync(),
    engine: engine.engine
      ? {
          models: () => modelsList(),
          message: (b) => engine.engine!.message(b),
          answer: (b) => engine.engine!.answerRoute(b),
          kill: (b) => engine.engine!.kill(b),
          subagent: (c, sid, op, b) => engine.engine!.subagent(c, sid, op, b),
        }
      : undefined,
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
