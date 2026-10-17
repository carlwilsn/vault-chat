// vault-chat-server: the box. The engine runs every turn; the phone host and sync run headless here.
// Boot order matters: browser globals first (store.ts reads localStorage at
// import), then the command table, then the app modules (dynamic imports so
// they evaluate after the shims).
import "./shims/globals";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { loadConfig, SERVER_VERSION, SERVER_REV } from "./config";
import { registerCommands } from "./commands";
import { loadKeyStore, hasKey, keychainCommands, saveKeys, keyNames } from "./keys";
import { hostname, userInfo } from "node:os";
import { setLegacySource, signal, convLog } from "./convlog/log";
import { legacySource } from "./convlog/importer";

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
  // Every vault's conversations are its event log; an older conversation file is imported when first opened.
  setLegacySource(legacySource);

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
  const loaded = convLog(cfg.vault).rows().length;
  console.log(`[vault-chat-server] ${loaded} conversation(s) in the log; keys: ${Object.keys(useStore.getState().apiKeys).join(", ") || "none"}`);

  const { startPhoneAppHost, sendPush } = await import("../src/phoneApp");
  await startPhoneAppHost();

  // Every agent turn runs in pi (server/engine). The old in-process loop
  // stays in the bundle for legacy mission threads until Phase 3 removes it.
  const { notificationAppend } = await import("./commands/phone");
  const { startEngine, engineModel, engineShuttingDown } = await import("./engine");
  const { startBoxSync, syncStatus, syncSummary, triggerSync, syncNow, listVaults, addVault, vaultPaths } = await import("./sync");
  // An agent's edits reach the laptop's open file in seconds: commit + publish, then /poll "vault_changed".
  const { LiveEdits } = await import("./liveEdits");
  // Every vault on the box; the main one keeps its own paths (config).
  const vaultRefs = () =>
    listVaults().map((v) => (v.main ? { name: v.name, path: cfg.vault, bare: cfg.bareRepo, main: true } : { name: v.name, path: vaultPaths(v.name).vault, bare: vaultPaths(v.name).bare, main: false }));
  const liveEdits = new LiveEdits({
    flush: (name) => syncNow(name === cfg.vaultName ? undefined : name),
    // A signal in that vault's log.
    broadcast: ({ vault, ...ev }) => {
      const v = !vault || vault === cfg.vaultName ? cfg.vault : vaultRefs().find((x) => x.name === vault)?.path;
      if (v) signal(v, ev);
    },
  });
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
    vaultName: cfg.vaultName,
    vaults: vaultRefs,
    onTurnEnded: (name) => triggerSync(name),
    onFilesWritten: (name, paths) => liveEdits.note(name, paths),
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
  });
  const ready = () => {
    if (engine.engine) return engine.engine;
    throw new Error(engine.error ? `the agent engine is not running: ${engine.error}` : "the agent engine is still starting — try again in a minute");
  };
  // Each vault's own engine (conversations, wakes, ledger, projects, rules,
  // sandbox), started on first use; every vault already on the box at boot.
  const engineOf = async (v: { name: string; path: string; bare: string; main: boolean }) => {
    const main = ready();
    return v.main || !engine.open ? main : await engine.open(v);
  };
  void engineBoot
    .then((h) => {
      engine = h;
      console.log(`[vault-chat-server] engine ${h.engine ? "up" : `not running: ${h.error}`}`);
      // Wakes, the watchdog and cut turns of every vault come back with the server.
      if (h.engine) for (const v of vaultRefs()) if (!v.main) void engineOf(v).catch((e) => console.error(`[engine] vault ${v.name}:`, e));
    })
    .catch((e) => {
      engine = { engine: null, error: String((e as Error)?.message ?? e), health: () => ({}) };
      console.error(`[vault-chat-server] engine failed to start: ${engine.error}`);
    });

  const { activeRuns } = await import("../src/runRegistry");
  const vaultOf = (name: string | null) => {
    if (!name || name === cfg.vaultName) return { name: cfg.vaultName, path: cfg.vault, bare: cfg.bareRepo, main: true };
    return vaultRefs().find((v) => v.name === name) ?? null;
  };
  // The tag becomes the Web Push tag, so a repeat alert replaces the last one.
  const alert = async (title: string, body: string, tag?: string) => {
    try {
      return await sendPush(title, body, "/phone", tag || "vault-chat");
    } catch (e) {
      console.warn("[alert] push failed:", e);
      return 0;
    }
  };

  const { startHttpServer } = await import("./http");
  const { activeVoiceSessions } = await import("./voice");
  const server = await startHttpServer({
    health: async () => ({
      ok: true,
      app: "vault-chat-server",
      name: hostname(),
      // The account and the vaults' working copies: the laptop's terminal opens `ssh user@box` in one.
      user: (() => {
        try {
          return userInfo().username;
        } catch {
          return process.env.USER || null;
        }
      })(),
      vaults: vaultRefs().map((v) => ({ name: v.name, path: v.path })),
      hasKey: hasKey("api.openrouter"),
      keyNames: keyNames(),
      version: SERVER_VERSION,
      rev: SERVER_REV,
      vault: cfg.vaultName,
      git: gitState,
      keys: { openrouter: hasKey("api.openrouter"), elevenlabs: hasKey("service.elevenlabs") },
      // A live voice session counts as a run: the updater waits for busy.runs == 0
      // (server/deploy/vault-chat-update.sh), so it never restarts under someone talking.
      busy: (() => {
        const agent = activeRuns().length;
        const voice = activeVoiceSessions();
        return { runs: agent + voice, agent, voice };
      })(),
      conversations: convLog(cfg.vault).rows().length,
      sync: syncSummary(),
      engine: engine.error ? { error: engine.error } : engine.health(),
    }),
    syncStatus,
    alert,
    onGitPushed: (name) => triggerSync(name),
    vaults: {
      list: listVaults,
      add: async (name) => {
        const out = await addVault(name);
        const v = vaultOf(name);
        if (v && !v.main && engine.engine) await engineOf(v).catch((e) => console.error(`[engine] vault ${name}:`, e));
        return out;
      },
    },
    vault: vaultOf,
    vaultStatus: async (v) => {
      const h: any = engine.engine ? (await engineOf(v)).health() : {};
      return {
        vault: v.name,
        model: engineModel(),
        version: SERVER_VERSION,
        runs: (h.liveTurns ?? []).filter((l: any) => !l.waitingUser).map((l: any) => ({ convId: l.convId, source: "phone" })),
        schedules: [],
      };
    },
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
          message: async (v, b) => (await engineOf(v)).message(b),
          answer: async (v, b) => (await engineOf(v)).answerRoute(b),
          kill: async (v, b) => (await engineOf(v)).kill(b),
          subagent: async (v, c, sid, op, b) => (await engineOf(v)).subagent(c, sid, op, b),
          intent: async (v, b) => (await engineOf(v)).intent(b),
        },
    // Voice (server/voice.ts) in the request's vault: its working copy, its
    // engine (AskAgent), its sandbox (Bash, vault tools), its sync.
    voice: async (v) => {
      // Its engine opens its conversation mirror, so voice's lines reach the clients' /poll.
      if (!v.main && engine.engine) await engineOf(v).catch((e) => console.error(`[voice] vault ${v.name}:`, e));
      return {
        vault: v.path,
        name: v.name,
        main: v.main,
        get shell() {
          return engine.engine ? engine.shellFor?.(v.name) : undefined;
        },
        message: async (b) => (await engineOf(v)).message(b),
        onWrite: (paths) => (paths?.length ? liveEdits.note(v.name, paths) : triggerSync(v.main ? undefined : v.name)),
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
    // pi's processes die with the server: not a crash. Their turns stay "running" for the next boot to resume once.
    engineShuttingDown();
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
