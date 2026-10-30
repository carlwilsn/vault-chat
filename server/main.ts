// vault-chat-server: the box. The engine runs every turn; the phone host and sync run headless here.
// Boot order matters: browser globals first (store.ts reads localStorage at
// import), then the command table, then the app modules (dynamic imports so
// they evaluate after the shims).
import "./shims/globals";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { voiceEngine } from "./voiceBrain";
import { pipelineState, stopPipeline, wantPipeline } from "./voicePipeline";

/** Where the New voice's pipeline listens (loopback only). */
const VOICE_PIPELINE_PORT = Number(process.env.VC_VOICE_PIPELINE_PORT) || 8857;
import { configureChangeDelivery, currentDeliveryRecovery, dispatchSourceRollback } from "./changeDelivery";
import { observeReleaseVoiceHealth, type BoxReleaseHealth } from "./releaseHealth";
import { loadConfig, SERVER_VERSION, SERVER_REV } from "./config";
import { registerCommands } from "./commands";
import { loadKeyStore, hasKey, keychainCommands, saveKeys, keyNames } from "./keys";
import { hostname, userInfo } from "node:os";
import { setLegacySource, signal, convLog, setSharedClock, setFeedVaults } from "./convlog/log";
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
  // Every vault's log takes its seqs from one clock: the clients read one feed over all of them (GlobalFeed).
  setSharedClock(join(cfg.stateDir, "convlog-clock"));

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

  // CONTEXT needs only the vault and the key store (the engine adds the rest when it is up).
  (await import("./context/config")).configureContext({ vault: cfg.vault });
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
  // The clients' feed: every vault's conversations, whatever vault is open; Main is the main vault's.
  setFeedVaults(cfg.vault, () => vaultRefs().map((v) => v.path));
  for (const v of vaultRefs()) convLog(v.path);
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
  // Conversations are the box's, not a vault's: a message to one goes to the engine of the vault whose log holds it
  // (Main: the main vault's; OpenProject's hand-over to a project of another vault).
  const { setConversationRouter } = await import("./projectRoutes");
  const { ownerVault } = await import("./convlog/log");
  setConversationRouter(async (b) => {
    const at = ownerVault(b.convId, cfg.vault);
    const v = vaultRefs().find((x) => x.path === at) ?? vaultRefs().find((x) => x.main)!;
    return (await engineOf(v)).message(b);
  }, vaultRefs);
  // Carl's ⋯ on a folder (server/folderOps.ts): what it may act on.
  const { setFolderOpsWalls } = await import("./folderOps");
  const { masterDir } = await import("./master");
  setFolderOpsWalls(() => ({ master: masterDir(), mainVault: cfg.vault, vaults: vaultRefs().map((v) => v.path) }));
  // One-shots on the box itself (a note's title): pi, no session, no tools (engine/pi/side.ts).
  (await import("../src/complete")).setComplete((req) => ready().once(req));
  void engineBoot
    .then((h) => {
      engine = h;
      console.log(`[vault-chat-server] engine ${h.engine ? "up" : `not running: ${h.error}`}`);
      // Wakes, jobs and cut turns of every vault come back with the server.
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
  // When the phone buzzes: one rule (server/pushGate.ts). Carl is "looking" while a surface says
  // so (POST /api/v1/attention), while his own activity reached the vault's context stream in the
  // last two minutes, or while a voice call is live.
  const { configurePushGate, ACTIVITY_MS } = await import("./pushGate");
  const { voiceLiveIn } = await import("./voice");
  const { readActivity } = await import("./activity");
  const gate = configurePushGate({
    send: (title, body, url, tag) => sendPush(title, body, url, tag),
    attention: (vault, now) => {
      if (voiceLiveIn(vault, now)) return { looking: true, where: "a voice call" };
      const mine = readActivity(vault, now, ACTIVITY_MS).filter((e) => e.device || e.kind === "voice");
      const last = mine[mine.length - 1];
      return last ? { looking: true, where: `${last.device === "board" ? "iPad" : (last.device ?? "voice")} activity ${Math.round((now - last.ts) / 1000)} s ago` } : { looking: false, where: null };
    },
  });
  // An alert (box sync, the self-updater, the laptop's sync) is a failure he must act on: it waits
  // while he is looking and goes out when he leaves. `needsYou: false` (a recovery, a rollback that
  // fixed itself) never buzzes. The tag becomes the Web Push tag, so a repeat replaces the last one.
  const alert = async (title: string, body: string, tag?: string, needsYou = true) => {
    const t = tag || "vault-chat";
    const syncTag = t === "vault-chat-sync";
    const offer = {
      vault: cfg.vault,
      why: "failed" as const,
      title,
      body,
      url: "/phone",
      tag: t,
      trigger: syncTag ? "box sync" : t.startsWith("vc-sync") ? "laptop sync" : t === "vault-chat-update" ? "self-update" : "alert",
      // Box sync failing: only while it still fails.
      ...(syncTag && /failing/i.test(title) ? { stillNeeded: () => (syncStatus() as { ok?: boolean } | null)?.ok !== true } : {}),
    };
    if (!needsYou) {
      gate.resolve(t);
      console.log(`[push] dropped trigger=${offer.trigger} why=failed "${title.slice(0, 80)}" — nothing for Carl to do`);
      return 0;
    }
    try {
      const d = await gate.offer(offer);
      return d.sent ?? 0;
    } catch (e) {
      console.warn("[alert] push failed:", e);
      return 0;
    }
  };

  const { startHttpServer } = await import("./http");
  const { drainServer, SHUTDOWN_GRACE_MS } = await import("./drain");
  const { activeVoiceSessions } = await import("./voice");
  const { recentInput } = await import("./presence");
  const bootedAt = Date.now();
  const boxReleaseHealth = async (): Promise<BoxReleaseHealth> => {
    const pi = engine.health() as { pi?: { state?: string } };
    const pipeline = pipelineState();
    const required = voiceEngine({ stateDir: cfg.stateDir }) === "new" && process.env.VC_VOICE_PIPELINE !== "off";
    return { version: SERVER_VERSION, revision: SERVER_REV, observedAt: Date.now(), ready: !!engine.engine && !engine.error && pi.pi?.state === "up",
      ...(engine.error ? { error: "Box agent engine failed to initialize" } : {}),
      // Check the managed child, listener ownership and actual runtime HTTP schema; never process-running alone.
      voice: await observeReleaseVoiceHealth({ required, pipeline, stateDir: cfg.stateDir, port: VOICE_PIPELINE_PORT, startupDeadline: bootedAt + 10 * 60_000 }) };
  };
  configureChangeDelivery({ boxHealth: boxReleaseHealth, requestSourceRollback: dispatchSourceRollback,
    vaults: () => vaultRefs().map(v => ({ name: v.name, path: v.path })), stateDir: cfg.stateDir });
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
      releaseReadiness: await (async () => {
        const b = await boxReleaseHealth();
        const recovery = await currentDeliveryRecovery(SERVER_VERSION, SERVER_REV);
        const failed = !!b.error || b.voice?.state === "failed" || recovery.failed;
        const ready = b.ready && (!b.voice?.required || (b.voice.state === "ready" && b.voice.owned));
        return { status: failed ? "failed" : ready ? "healthy" : "pending", binaryFallback: recovery.binaryFallback, reason: failed ? "Actual release readiness failed" : ready ? "Box ready; laptop verification tracked separately" : "Waiting for actual engine/voice readiness" };
      })(),
      vault: cfg.vaultName,
      git: gitState,
      keys: { openrouter: hasKey("api.openrouter"), elevenlabs: hasKey("service.elevenlabs") },
      // A live voice session counts as a run: the updater waits for busy.runs == 0
      // (server/deploy/vault-chat-update.sh), so it never restarts under someone talking.
      // It also waits for busy.inputs == 0: no surface Carl used in the last 10 minutes
      // (server/presence.ts: board saves, typed messages, voice, the phone, `input`: seconds ago).
      busy: (() => {
        const agent = activeRuns().length;
        const voice = activeVoiceSessions();
        const input = recentInput();
        return { runs: agent + voice, agent, voice, inputs: Object.keys(input).length, input };
      })(),
      conversations: convLog(cfg.vault).rows().length,
      sync: syncSummary(),
      engine: engine.error ? { error: engine.error } : engine.health(),
    }),
    syncStatus,
    alert,
    onGitPushed: (name) => triggerSync(name),
    master: await import("./master"),
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
    vaultList: vaultRefs,
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
    mcp: process.env.VC_ENGINE === "0" ? undefined : async (v, context) => (await engineOf(v)).mcpBinding(context),
    engine: process.env.VC_ENGINE === "0"
      ? undefined
      : {
          models: () => (engine.engine ? modelsList() : []),
          boxModels: () => (engine.engine && engine.roles ? boxModelChecks(engine.roles()) : undefined),
          setModel: (m) => (engine.engine && engine.setModel ? engine.setModel(m) : { ok: false, error: "engine not running" }),
          message: async (v, b) => (await engineOf(v)).message(b),
          answer: async (v, b) => (await engineOf(v)).answerRoute(b),
          kill: async (v, b) => (await engineOf(v)).kill(b),
          subagent: async (v, c, sid, op, b) => (await engineOf(v)).subagent(c, sid, op, b),
          intent: async (v, b) => (await engineOf(v)).intent(b),
          side: {
            start: async (v, b) => (await engineOf(v)).sideStart(b),
            poll: async (v, id, after, wait) => (await engineOf(v)).sidePoll(id, after, wait),
            stop: async (v, id) => (await engineOf(v)).sideStop(id),
          },
        },
    // Voice with one brain (server/voiceBrain.ts): the conversation's engine, the box's ElevenLabs key, the pipeline on loopback.
    brain: (v) => ({
      vault: v.path,
      engine: async () => engineOf(v),
      elKey: () => useStore.getState().serviceKeys.elevenlabs || null,
      voiceId: () => localStorage.getItem("vault_chat_elevenlabs_voice") || "nPczCjzI2devNBz1zQrb",
      botUrl: `http://127.0.0.1:${VOICE_PIPELINE_PORT}`,
      onEngine: (e) => wantPipeline({ stateDir: cfg.stateDir, port: VOICE_PIPELINE_PORT, log: (s) => console.log(s) }, e === "new" && process.env.VC_VOICE_PIPELINE !== "off"),
      selfUrl: `http://127.0.0.1:${cfg.port}`,
      logDir: join(cfg.stateDir, "logs"),
      stateDir: cfg.stateDir,
    }),
    // Voice (server/voice.ts) in the request's vault: its conversations, its engine (Ask hands
    // Carl's request to the conversation's agent), its sync.
    voice: async (v) => {
      // Its engine opens its conversation mirror, so voice's lines reach the clients' /poll.
      if (!v.main && engine.engine) await engineOf(v).catch((e) => console.error(`[voice] vault ${v.name}:`, e));
      return {
        vault: v.path,
        name: v.name,
        main: v.main,
        message: async (b) => (await engineOf(v)).message(b),
        // Voice's Ask: a pi side thread forked from the conversation (never a turn of it, never a steer).
        side: {
          start: async (b) => (await engineOf(v)).sideStart(b),
          wait: async (id) => {
            for (;;) {
              const st = await (await engineOf(v)).sidePoll(id, Number.MAX_SAFE_INTEGER, 25_000);
              if (!st) return { text: "", error: "the side request is gone" };
              if (st.done) return { text: st.text, error: st.error, file: st.file };
            }
          },
        },
        onWrite: (paths) => (paths?.length ? liveEdits.note(v.name, paths) : triggerSync(v.main ? undefined : v.name)),
      };
    },
  });
  console.log(`[vault-chat-server] listening on http://${cfg.host}:${cfg.port}`);

  // Only the box fires schedules: each due one is a message to the engine.
  const { startSchedulerLoop } = await import("../src/schedulerLoop");
  void startSchedulerLoop(cfg.vault, async (convId, text) => {
    const out = await ready().message({ convId, text, client: "schedule" });
    if (out?.error) console.warn(`[scheduler] the engine refused a schedule: ${out.error}`);
  });

  await startBoxSync(alert);

  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[vault-chat-server] ${sig} — shutting down`);
    // pi's processes die with the server: not a crash. Their turns stay "running" for the next boot to resume once.
    engineShuttingDown();
    // A write in flight (a board save, a message) finishes and gets its answer; long polls are cut (their clients
    // reconnect). Nothing is left half-open: whatever is still running at the grace's end is closed, so its client
    // sees an error and retries.
    void drainServer(server, SHUTDOWN_GRACE_MS).then((left) => {
      if (left) console.warn(`[vault-chat-server] ${left} request(s) still running after ${SHUTDOWN_GRACE_MS} ms — closed`);
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // The New voice's pipeline runs as this server's child while the box's engine is "new" (server/voicePipeline.ts).
  if (voiceEngine({ stateDir: cfg.stateDir }) === "new" && process.env.VC_VOICE_PIPELINE !== "off")
    wantPipeline({ stateDir: cfg.stateDir, port: VOICE_PIPELINE_PORT, log: (s) => console.log(s) }, true);
  process.on("exit", () => stopPipeline());
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (e) => {
  console.error("[vault-chat-server] unhandled rejection:", e);
});

// `vault-chat-server.mjs record-ui`: the RecordUI tool's recorder, run by the tool inside the agent's sandbox (server/recordUI.ts).
// `vault-chat-server.mjs master …`: the vault-chat folder's CLI (server/masterCli.ts), never the server.
if (process.argv[2] === "record-ui") void import("./recordUI").then((m) => m.recordCli());
else if (process.argv[2] === "prove-change-ui" || process.argv[2] === "verify-change-video") void import("./changeUI").then(m => m.changeUICli(process.argv[2]!, process.argv[3]!));
else if (process.argv[2] === "recover-published-release") void import("./publishedRecovery").then(async m => process.exit(await m.runPublishedRecoveryCli())).catch(e => fatal(`source recovery failed: ${String(e)}`, 1));
else if (process.argv[2] === "master") void import("./masterCli").then(async (m) => process.exit(await m.runMasterCli(process.argv.slice(3))));
else if (process.argv[2] === "projects") void import("./projectsCli").then(async (m) => process.exit(await m.runProjectsCli(process.argv.slice(3))));
else main().catch((e) => fatal(`boot failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, 1));
