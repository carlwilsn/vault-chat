// vault-chat-server: the box. The engine runs every turn; the phone host and sync run headless here.
// Boot order matters: browser globals first (store.ts reads localStorage at
// import), then the command table, then the app modules (dynamic imports so
// they evaluate after the shims).
import "./shims/globals";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { activeVoiceSessions, voiceLiveIn } from "./voiceBrain";
import { localVoiceReady, pipelineState, stopPipeline, wantPipeline } from "./voicePipeline";
import { ELEVENLABS_VOICE_PLUGIN, ELEVENLABS_VOICE_KEY, voiceProvider } from "./voiceProvider";

import { configureChangeDelivery, currentDeliveryHealth } from "./changeDelivery";
import { observeReleaseVoiceHealth, type BoxReleaseHealth } from "./releaseHealth";
import { loadConfig, SERVER_VERSION, SERVER_REV } from "./config";
import { registerCommands } from "./commands";
import { loadKeyStore, hasKey, keyValue, saveKeys, keyNames, CLAUDE_CODE_KEY } from "./keys";
import { hostname, userInfo } from "node:os";
import { setLegacySource, signal, signalLog, convLog, setSharedClock, setFeedVaults, prereadConvLog } from "./convlog/log";
import { endOwnProcesses, promote, takeOwnership } from "./owner";
import type { FileLocalStorage } from "./shims/globals";
import { legacySource } from "./convlog/importer";
import { pluginStopped, supervisorOf } from "./supervisor";
import { CORE_PART } from "../src/coreBundle";

function fatal(msg: string, code = 2): never {
  console.error(`[vault-chat-server] FATAL: ${msg}`);
  process.exit(code);
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

  // Keys: in-process from the box's encrypted store. The server still starts
  // with none (health says so) so the laptop's Settings can send them (POST
  // /api/v1/keys); turns fail until one way of running them is there.
  const ks = await loadKeyStore(cfg.secretsDir);
  if (ks.error) console.error(`[vault-chat-server] ${ks.error}`);
  // One way to run a turn: Carl's Claude sign-in. (A box can also be signed in
  // directly with `claude setup-token`, which leaves its credentials in the
  // engine's own config dir — the engine reports that as signed in.)
  if (!hasKey(CLAUDE_CODE_KEY)) {
    console.error(
      `[vault-chat-server] the key store (${cfg.secretsDir}/secrets.age) has no "${CLAUDE_CODE_KEY}". ` +
        `Turns cannot run until Carl signs in (laptop: Settings → Sign in with Claude).`,
    );
  }

  checkGit();
  setInterval(checkGit, 60_000).unref();

  // ---- taking over ----
  // Nothing above touches the box's data. A server behind the front (an update starts it beside the one serving,
  // server/deploy/vault-chat-update.sh) reads every vault's log ahead, then waits for that one to drain and exit
  // (server/owner.ts). Requests meanwhile wait at the front, so the switch costs only what follows.
  const { listVaults: vaultsOnBox, vaultPaths: pathsOf } = await import("./sync");
  if (cfg.backend) {
    for (const v of vaultsOnBox()) prereadConvLog(v.main ? cfg.vault : pathsOf(v.name).vault);
    await takeOwnership(cfg.stateDir, cfg.port);
    // What the last owner wrote last.
    for (const s of [globalThis.localStorage, globalThis.sessionStorage]) (s as unknown as FileLocalStorage).reload?.();
  }
  // Every vault's conversations are its event log; an older conversation file is imported when first opened.
  setLegacySource(legacySource);
  // Every vault's log takes its seqs from one clock: the clients read one feed over all of them (GlobalFeed).
  setSharedClock(join(cfg.stateDir, "convlog-clock"));
  // Carl's plan usage (the context ring's popover): the last box's answer at once, then read again when stale.
  const plan = await import("./planUsage");
  plan.keepPlanUsageIn(join(cfg.stateDir, "plan-usage.json"));
  setTimeout(() => plan.refreshPlanUsage(), 10_000).unref();

  // ---- the app, headless ----
  const store = await import("../src/store");
  const { useStore } = store;
  useStore.getState().setVault(cfg.vault);
  await store.hydrateKeychain({ migrate: false });
  const loaded = convLog(cfg.vault).rows().length;
  console.log(`[vault-chat-server] ${loaded} conversation(s) in the log; keys: ${keyNames().length}`);

  // CONTEXT needs only the vault and the key store (the engine adds the rest when it is up).
  (await import("./context/config")).configureContext({ vault: cfg.vault, conversationRoot: cfg.vault });
  const { startPhoneAppHost, sendPush } = await import("../src/phoneApp");
  await startPhoneAppHost();

  // Every agent turn runs in pi (server/engine). The old in-process loop
  // stays in the bundle for legacy mission threads until Phase 3 removes it.
  const { notificationAppend } = await import("./commands/phone");
  const { readSetting, setSetting } = await import("./settings");
  const { startEngine, engineModel, engineEffort, engineShuttingDown } = await import("./engine");
  const { startBoxSync, syncStatus, syncSummary, triggerSync, syncNow, listVaults, addVault, vaultPaths } = await import("./sync");
  // An agent's edits reach the laptop's open file in seconds: commit + publish, then /poll "vault_changed".
  const { LiveEdits } = await import("./liveEdits");
  // Every vault on the box; the main one keeps its own paths (config).
  const vaultRefs = () =>
    listVaults().map((v) => (v.main ? { name: v.name, path: cfg.vault, bare: cfg.bareRepo, main: true } : { name: v.name, path: vaultPaths(v.name).vault, bare: vaultPaths(v.name).bare, main: false }));
  (await import("./context/config")).configureContext({ vault: cfg.vault, conversationRoot: cfg.vault, vaults: () => vaultRefs().map(v => v.path) });
  // The clients' feed: every vault's conversations, whatever vault is open; Main is the main vault's.
  setFeedVaults(cfg.vault, () => vaultRefs().map((v) => v.path));
  // Device actions kept while the device was away run when it is back (server/deviceQueue.ts).
  {
    const { startDeviceQueue } = await import("./deviceQueue");
    const { pluginOfferTool } = await import("./pluginOffersTool");
    const { signal } = await import("./convlog/log");
    startDeviceQueue({
      stateDir: cfg.stateDir,
      run: (q) => pluginOfferTool({ vault: q.vault, emit: (ev) => void signal(q.vault, ev), stateDir: cfg.stateDir }, "PluginAct", { plugin: q.plugin, action: q.action, args: q.args, device: q.device }),
      say: async (q, line) => {
        if (q.conv) await (await import("./engine/convs")).writeNotes(q.vault, q.conv, [{ kind: "notice", text: line, level: "info" }]);
      },
    });
  }
  // A daily copy of every vault's event log and the engine's transcripts (server/dailyBackup.ts).
  {
    const { startDailyBackup } = await import("./dailyBackup");
    startDailyBackup(cfg.stateDir, () => [
      ...vaultRefs().map((v) => ({ label: `vault-${v.name}`, dir: join(v.path, ".vault-chat", "events") })),
      { label: "claude-projects", dir: join(process.env.VC_CLAUDE_CONFIG_DIR || join(cfg.stateDir, "claude", "config"), "projects") },
    ]);
  }
  for (const v of vaultRefs()) convLog(v.path);
  // The laptop app's core is a bundle this box builds from accepted main and serves (server/coreBundles.ts): its records
  // are app/core plugin.change records in the main vault's log; a new main is built as a StartJob job outside this
  // server while Carl's setting corePublish is on (the default); a built bundle that passes the one gate is kept by
  // "gate" (server/gate.ts landCore) and the laptop's loader takes it.
  {
    const core = await import("./coreBundles");
    const { landCore } = await import("./gate");
    core.configureCore({ stateDir: cfg.stateDir, vault: cfg.vault });
    const { readSetting } = await import("./settings");
    core.startCorePublisher({
      stateDir: cfg.stateDir,
      // Carl's setting corePublish off: the tick does nothing at all.
      on: () => readSetting("corePublish") === true,
      changes: () => supervisorOf(cfg.vault).changes(CORE_PART),
      land: () => landCore(),
    });
  }
  // The box server's own handovers (server/deploy/vault-chat-update.sh notes each one): box.server.switch records.
  // A switch back (a new build failed readiness and the box went back) is a failed promotion: it goes to Carl's in-app
  // alerts at once and, once the push gate is up, through the self-updater's needs-you alert, never only a log line.
  const switchBacks: string[] = [];
  let switchBackAlert: ((line: string) => void) | null = null;
  {
    const sw = await import("./serverSwitches");
    const { notificationAppend } = await import("./commands/phone");
    sw.startServerSwitches(cfg.stateDir, cfg.vault, (ev) => {
      const line = sw.describeSwitchBack(ev);
      console.warn(`[update] needs you: ${line}`);
      try {
        notificationAppend(cfg.vault, JSON.stringify({ id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36), ts: Date.now(), kind: "info", title: "Needs you: a box server update failed", body: line }));
        signal(cfg.vault, { type: "notif" });
      } catch { /* the push below still goes */ }
      if (switchBackAlert) switchBackAlert(line);
      else switchBacks.push(line);
    });
  }
  // Carl's settings are records in the main vault's log (server/settings.ts); what the box kept in its localStorage
  // file moves there once, backed up first (outside the vault).
  {
    const { configureSettings, migrateSettings } = await import("./settings");
    const { isClaudeModel } = await import("./engine/claude/models");
    configureSettings({ log: () => signalLog(cfg.vault), check: { model: (m) => (isClaudeModel(String(m)) ? null : `"${String(m).slice(0, 80)}" is not a model this engine runs`) } });
    try {
      const m = migrateSettings({ storage: localStorage, backupDir: process.env.VC_SETTINGS_BACKUP_DIR || join(cfg.stateDir, "backups"), source: cfg.localStoragePath });
      if (m.backup) console.log(`[vault-chat-server] settings moved to records: ${m.moved.join(", ") || "none"}${m.dropped.length ? `; dropped ${m.dropped.join(", ")}` : ""} (backup ${m.backup})`);
    } catch (e) {
      console.error(`[vault-chat-server] settings migration failed (the old file is untouched where it failed): ${(e as Error).message}`);
    }
  }
  const liveEdits = new LiveEdits({
    flush: (name) => syncNow(name === cfg.vaultName ? undefined : name),
    // A signal in that vault's log.
    broadcast: ({ vault, ...ev }) => {
      const v = !vault || vault === cfg.vaultName ? cfg.vault : vaultRefs().find((x) => x.name === vault)?.path;
      if (v) signal(v, ev);
    },
  });

  // The engine starts in the background (a first start installs pi with npm,
  // which can take minutes): the server answers at once, health says
  // "starting", and agent routes say so until it is up.
  type Handle = Awaited<ReturnType<typeof startEngine>>;
  let engine: Handle = { engine: null, error: null, health: () => ({ backend: "claude", claude: { state: "starting" } }) };
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
    serverVersion: SERVER_VERSION,
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
  // (Main: the main vault's; box:chats openProject's hand-over to a project of another vault).
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
  const { readActivity } = await import("./activity");
  const { legacyPushEnabled } = await import("./pushPreferences");
  const { surfaceOff } = await import("./surfaces");
  const gate = configurePushGate({
    legacyEnabled: legacyPushEnabled,
    send: (title, body, url, tag) => sendPush(title, body, url, tag),
    // The phone app switched off (server/surfaces.ts): nothing buzzes it.
    phoneOff: (vault) => surfaceOff(vault, "phone") ?? surfaceOff(cfg.vault, "phone"),
    attention: (vault, now) => {
      if (voiceLiveIn(vault, now)) return { looking: true, where: "a voice call" };
      const mine = readActivity(vault, now, ACTIVITY_MS).filter((e) => e.device || e.kind === "voice");
      const last = mine[mine.length - 1];
      return last ? { looking: true, where: `${last.device ?? "voice"} activity ${Math.round((now - last.ts) / 1000)} s ago` } : { looking: false, where: null };
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

  switchBackAlert = (line) => void alert("Needs you: a box server update failed", line, "vault-chat-update");
  for (const line of switchBacks.splice(0)) switchBackAlert(line);

  const { startHttpServer, endLongPolls } = await import("./http");
  const { drainServer, SHUTDOWN_GRACE_MS } = await import("./drain");
  const { recentInput } = await import("./presence");
  const bootedAt = Date.now();
  const boxReleaseHealth = async (): Promise<BoxReleaseHealth> => {
    const health = engine.health() as { claude?: { state?: string } };
    const pipeline = pipelineState();
    const required = process.env.VC_VOICE_PIPELINE !== "off";
    return { version: SERVER_VERSION, revision: SERVER_REV, observedAt: Date.now(), ready: !!engine.engine && !engine.error && health.claude?.state === "up",
      ...(engine.error ? { error: "Box agent engine failed to initialize" } : {}),
      // Check the managed child, listener ownership and actual runtime HTTP schema; never process-running alone.
      voice: await observeReleaseVoiceHealth({ required, pipeline, stateDir: cfg.stateDir, port: cfg.voicePort, startupDeadline: bootedAt + 10 * 60_000 }) };
  };
  configureChangeDelivery({ boxHealth: boxReleaseHealth,
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
      voice: pipelineState(),
      // No API key is held or needed: the engine runs on Carl's Claude sign-in,
      // which health reports as keys.claudeCode. The field stays because the
      // installed ship host's preflight reads it (host/real-copy-startup.mjs,
      // which is not in the repo), and Carl asked for it to stay false.
      hasKey: false,
      keyNames: keyNames(),
      version: SERVER_VERSION,
      rev: SERVER_REV,
      releaseReadiness: await (async () => {
        const b = await boxReleaseHealth();
        const delivery = await currentDeliveryHealth(SERVER_VERSION, SERVER_REV);
        const failed = !!b.error || b.voice?.state === "failed" || delivery.failed;
        const ready = b.ready && (!b.voice?.required || (b.voice.state === "ready" && b.voice.owned));
        // The reason names which check failed (fixed messages, no private data): the updater copies it into its
        // switch-back record, which reaches Carl's alerts and LaptopBuild (server/serverSwitches.ts).
        const why = b.error ?? (b.voice?.state === "failed" ? `Voice: ${b.voice.error ?? "failed"}` : delivery.failed ? "This release is recorded as failed in the shipping journal" : "");
        return { status: failed ? "failed" : ready ? "healthy" : "pending", reason: failed ? `Actual release readiness failed: ${why}`.slice(0, 200) : ready ? "Box ready; laptop verification tracked separately" : "Waiting for actual engine/voice readiness" };
      })(),
      vault: cfg.vaultName,
      git: gitState,
      keys: { claudeCode: hasKey(CLAUDE_CODE_KEY) },
      // A live voice session counts as a run: the updater waits for busy.runs == 0
      // (server/deploy/vault-chat-update.sh), so it never restarts under someone talking.
      // It also waits for busy.inputs == 0: no surface Carl used in the last 10 minutes
      // (server/presence.ts: typed messages, voice, the phone, `input`: seconds ago).
      // And for busy.workers == 0: background workers outlive the turn that started them
      // (Claude Code's subagents and shells, background workers), across every vault's engine.
      busy: (() => {
        const agent = activeRuns().length;
        const voice = activeVoiceSessions();
        const input = recentInput();
        // resumesWork: this server's hand-over saves its background workers and the next server resumes them in their
        // chats (Engine.saveCutWork), so the updater waits for workers only a while (WORKERS_MAX_S), never hours.
        return { runs: agent + voice, agent, voice, workers: engine.workers?.() ?? 0, resumesWork: !!engine.saveCutWork, inputs: Object.keys(input).length, input };
      })(),
      conversations: convLog(cfg.vault).rows().length,
      // The laptop app's core bundle (server/coreBundles.ts): which one the box offers, and its newest build.
      core: (await import("./coreBundles")).coreHealth(cfg.stateDir, supervisorOf(cfg.vault).changes(CORE_PART), (await import("./settings")).readSetting("corePublish") === true),
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
        await store.hydrateKeychain({ migrate: false });
        console.log(`[vault-chat-server] keys from the laptop: ${Object.keys(keys).sort().join(", ") || "none"}`);
        // A sign-in among them: the engine forgets whatever the API said about
        // the last token and spends one tiny call on this one. The value itself
        // is never read here — only whether the push carried that key at all.
        if (CLAUDE_CODE_KEY in keys) engine.tokenChanged?.();
      }
      return changed;
    },
    mcp: process.env.VC_ENGINE === "0" ? undefined : async (v, context) => (await engineOf(v)).mcpBinding(context),
    engine: process.env.VC_ENGINE === "0"
      ? undefined
      : {
          models: () => (engine.engine && engine.models ? engine.models() : []),
          defaultModel: () => engineModel(),
          defaultEffort: () => engineEffort(),
          chatModel: async (v, convId, body) => (await engineOf(v)).setChatModel(convId, body),
          message: async (v, b, viewerRoot) => (await engineOf(v)).message(b, viewerRoot),
          answer: async (v, b) => (await engineOf(v)).answerRoute(b),
          kill: async (v, b) => (await engineOf(v)).kill(b),
          subagent: async (v, c, sid, op, b) => (await engineOf(v)).subagent(c, sid, op, b),
          // A chat is in the log of the vault that holds it, which is not always the open one (the list is the whole
          // box's): an intent about chats goes to each owner's engine, or the open vault's engine says "no such chat".
          intent: async (v, b, viewerRoot) => {
            const { ownerVault } = await import("./convlog/log");
            const engineAt = async (id: string) => {
              const at = ownerVault(id, v.path);
              const o = at && at !== v.path ? vaultRefs().find((x) => x.path === at) : null;
              return o ? engineOf(o) : engineOf(v);
            };
            if ((b?.type === "delete" || b?.type === "restoreConversation") && (Array.isArray(b.convIds) || b.convId)) {
              const ids: string[] = (Array.isArray(b.convIds) ? b.convIds : [b.convId]).map(String);
              const groups = new Map<Awaited<ReturnType<typeof engineOf>>, string[]>();
              for (const id of ids) {
                const e = await engineAt(id);
                groups.set(e, [...(groups.get(e) ?? []), id]);
              }
              if (groups.size > 1) {
                const outs = await Promise.all([...groups].map(([e, g]) => e.intent(Array.isArray(b.convIds) ? { ...b, convIds: g } : { ...b, convId: g[0] }, viewerRoot)));
                const deleted = outs.flatMap((o) => (Array.isArray(o.deleted) ? (o.deleted as string[]) : []));
                const refused = outs.flatMap((o) => (Array.isArray(o.refused) ? (o.refused as unknown[]) : []));
                return { ok: deleted.length > 0 || !ids.length, deleted, refused };
              }
              return [...groups.keys()][0]!.intent(b, viewerRoot);
            }
            const id = typeof b?.convId === "string" ? b.convId : "";
            return (id ? await engineAt(id) : await engineOf(v)).intent(b, viewerRoot);
          },
          side: {
            start: async (v, b, viewerRoot) => (await engineOf(v)).sideStart(b, viewerRoot),
            poll: async (v, id, after, wait) => (await engineOf(v)).sidePoll(id, after, wait),
            stop: async (v, id) => (await engineOf(v)).sideStop(id),
          },
        },
    // Voice with one brain (server/voiceBrain.ts): the conversation's engine, the box's ElevenLabs key, the pipeline on loopback.
    brain: (v) => ({
      vault: v.path,
      engine: async () => engineOf(v),
      elKey: () => keyValue(ELEVENLABS_VOICE_KEY),
      voiceId: () => String(readSetting("voice") ?? "nPczCjzI2devNBz1zQrb"),
      elevenlabsPluginOn: () => !pluginStopped(cfg.vault, ELEVENLABS_VOICE_PLUGIN),
      localVoiceReady,
      pipelineState,
      pipelineReady: async () => {
        const p = pipelineState();
        if (!p.wanted || !p.running || process.env.VC_VOICE_PIPELINE === "off") return false;
        const health = await observeReleaseVoiceHealth({ required: true, pipeline: p, stateDir: cfg.stateDir, port: cfg.voicePort, startupDeadline: bootedAt + 10 * 60_000 });
        return health.owned && health.state === "ready";
      },
      botUrl: `http://127.0.0.1:${cfg.voicePort}`,
      setVoiceId: (id) => void setSetting("voice", id, "carl"),
      selfUrl: `http://127.0.0.1:${cfg.port}`,
      logDir: join(cfg.stateDir, "logs"),
      stateDir: cfg.stateDir,
      // The board a call draws on, in front of him (as Show does it; nothing waits on the laptop's answer).
      showBoard: (path) => {
        void import("./show").then(({ show }) => show({ vault: v.path, device: "laptop", emit: (ev) => signal(v.path, ev) }, { path, where: "laptop" })).catch(() => undefined);
      },
    }),
  });
  console.log(`[vault-chat-server] listening on http://${cfg.host}:${cfg.port}`);
  // Behind the front: every request comes here from now on.
  if (cfg.backend) promote(cfg.stateDir, cfg.port);

  // Ship results are not delivered to project-vault-chat one by one (every lane's result woke that long chat:
  // ~650k tokens each). The session that submitted waits for its own result in the background (Claude Code wakes it
  // when the wait ends). VC_KEEP_GOING=1 brings the old delivery back.
  const vcVault = vaultRefs().find((v) => v.name === "vault-chat");
  if (vcVault && process.env.VC_KEEP_GOING === "1") {
    (await import("./keepGoing")).startKeepGoing({
      stateDir: cfg.stateDir,
      workDir: join(process.env.HOME ?? "", "agent-work", "vault-chat"),
      deliver: async (name, body) => (await engineOf(vcVault)).run("project-vault-chat", `Ship result ${name}:\n${body}\nRead this result and handle any actionable next work in the current assignment; if blocked, wait rather than recheck.`, "wake"),
    });
  }

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
    // Background work (Claude Code's workers and shells) ends with this server's processes: each chat gets
    // a durable wake, so the next server resumes its workers right after it takes over and says so in the chat.
    try {
      const cut = engine.saveCutWork?.() ?? 0;
      if (cut) console.log(`[vault-chat-server] ${cut} background task(s) running: saved for the next server to resume`);
    } catch (e) {
      console.error(`[vault-chat-server] could not save the running background work: ${(e as Error).message}`);
    }
    // A write in flight (a message, a note) finishes and gets its answer; long polls are cut (their clients
    // reconnect). Nothing is left half-open: whatever is still running at the grace's end is closed, so its client
    // sees an error and retries.
    // Long polls answer first (an empty answer, never a cut connection): their clients simply ask again.
    endLongPolls();
    void new Promise((r) => setTimeout(r, 50)).then(() => drainServer(server, SHUTDOWN_GRACE_MS)).then(async (left) => {
      if (left) console.warn(`[vault-chat-server] ${left} request(s) still running after ${SHUTDOWN_GRACE_MS} ms — closed`);
      // Behind the front the next server takes over the moment this one exits: nothing of this one outlives it.
      if (cfg.backend) {
        stopPipeline();
        await endOwnProcesses(cfg.port);
      }
      // Behind the front only a hand-over is a clean exit: a SIGTERM nobody planned (not systemd's own stop) must
      // bring the slot back (vault-chat-server@.service: Restart=always, RestartPreventExitStatus=0), never leave the
      // box with no server while the front holds every request.
      process.exit(!cfg.backend || sig === "hand-over" ? 0 : sig === "SIGINT" ? 130 : 143);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // The updater's hand-over (server/deploy/vault-chat-update.sh): this server goes only when no agent turn or voice
  // call runs here. Busy: it stays and keeps serving, and the updater asks again (after its maximum wait, 2 h, the
  // updater stops this slot instead: vault-chat-update.sh handover). Background workers do not hold it (the updater
  // gives them a while to finish first): shutdown saves them and the next server resumes them (Engine.saveCutWork).
  process.on("SIGUSR2", () => {
    const busy = { agent: activeRuns().length, voice: activeVoiceSessions() };
    if (busy.agent || busy.voice) {
      console.log(`[vault-chat-server] hand-over declined: still running ${JSON.stringify({ ...busy, workers: engine.workers?.() ?? 0 })}`);
      return;
    }
    shutdown("hand-over");
  });
  // The New voice's pipeline runs as this server's child (server/voicePipeline.ts).
  if (process.env.VC_VOICE_PIPELINE !== "off")
    void wantPipeline({ stateDir: cfg.stateDir, serverPort: cfg.publicPort, port: cfg.voicePort, log: (s) => console.log(s),
      wantsLocal: () => voiceProvider({ elevenlabsPluginOn: !pluginStopped(cfg.vault, ELEVENLABS_VOICE_PLUGIN), elKey: keyValue(ELEVENLABS_VOICE_KEY) }) === "local" }, true).catch(() => {}); // failure is retained in health/UI
  process.on("exit", () => stopPipeline());
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (e) => {
  console.error("[vault-chat-server] unhandled rejection:", e);
});

// `vault-chat-server.mjs record-ui`: the RecordUI tool's recorder, run by the tool inside the agent's sandbox (server/recordUI.ts).
if (process.argv[2] === "record-ui") void import("./recordUI").then((m) => m.recordCli());
// `vault-chat-server.mjs install-claude-cli <path> [stateDir]`: put the pinned
// Claude Code CLI where this box reads it from (server/engine/claude/cliInstall.ts).
// The box updater calls it with the CLI a release carries, so a fresh install has
// a Claude Code without anyone copying one in by hand.
else if (process.argv[2] === "install-claude-cli") void import("./engine/claude/cliInstall").then((m) => process.exit(m.installClaudeCli(process.argv.slice(3), loadConfig().stateDir)));
else main().catch((e) => fatal(`boot failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, 1));
