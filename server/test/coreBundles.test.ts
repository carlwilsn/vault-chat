// The app's core as a part the box builds and serves (src/coreBundle.ts, server/coreBundles.ts, scripts/core-publish.ts):
// a bundle stored by its manifest's hash, served over the box's own routes byte for byte, landed and switched with the
// existing plugin.change record for app/core, refused when it needs a newer box; the publisher building a new main as
// a job outside the server, its result waiting for Carl as a Change ready card (never landing by itself). Real HTTP against the box's own server; no vault is written
// outside the test's temp folder.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Server } from "node:http";
import { freePort } from "./helpers";
import { _resetConvLogs, setFeedVaults, signalLog } from "../convlog/log";
import { configureSettings, setSetting } from "../settings";
import { startHttpServer, type VaultScope } from "../http";
import { coreAppVersion, storeCore, needsOf } from "../../scripts/core-publish";
import { CORE_BOX_API, CORE_PART, manifestProblem, missingNeeds, nextCoreStep, safeCorePath, scanNeeds, type CoreNeeds } from "../../src/coreBundle";

vi.mock("../../src-tauri/assets/phone.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/voice.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/icon-apple-touch.png", () => ({ default: "" }));
vi.mock("vc:phone-app", () => ({ default: {} }));
vi.mock("vc:board-app", () => ({ default: {} }));

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const NEEDS: CoreNeeds = { commands: ["app_ready", "read_text_file"], plugins: ["dialog"], boxApi: CORE_BOX_API };
const COMMIT = "a".repeat(40);

describe("core bundles on the box", () => {
  const home = mkdtempSync(join(tmpdir(), "vc-core-"));
  const A: VaultScope = { name: "main-vault", path: join(home, "a"), bare: "", main: true };
  const state = join(home, "state");
  const root = join(state, "core-bundles");
  let srv: Server | undefined;
  let base = "";
  let core: typeof import("../coreBundles");
  let sup: typeof import("../supervisor");

  /** A built dist with these files, stored as a bundle. */
  const build = (name: string, files: Record<string, string>, needs: CoreNeeds = NEEDS, commitTime = 100, builtAt = `2026-11-17T00:00:0${name.length % 10}Z`) => {
    const dist = join(home, "dist-" + name);
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(dist, p, ".."), { recursive: true });
      writeFileSync(join(dist, p), c);
    }
    return storeCore(root, dist, { commit: COMMIT, commitTime, needs, builtAt });
  };

  beforeAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("VC_")) delete process.env[k];
    mkdirSync(A.path, { recursive: true });
    writeFileSync(join(home, "token"), "test-only-token");
    _resetConvLogs();
    setFeedVaults(A.path, () => [A.path]);
    vi.stubEnv("VC_HOST", "127.0.0.1");
    vi.stubEnv("VC_PORT", String(await freePort()));
    const voice = String(await freePort());
    vi.stubEnv("VC_VOICE_PORT", voice);
    vi.stubEnv("VC_VOICE_PIPELINE_PORT", voice);
    vi.stubEnv("VC_VOICE_PIPELINE", "off");
    vi.stubEnv("VC_VAULT", A.path);
    vi.stubEnv("VC_STATE_DIR", state);
    vi.stubEnv("VC_TOKEN_FILE", join(home, "token"));
    srv = await startHttpServer({ health: async () => ({}), syncStatus: () => ({}), alert: async () => 0, onGitPushed: () => {}, vault: (n) => (!n || n === A.name ? A : null), vaultList: () => [A] });
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    core = await import("../coreBundles");
    sup = await import("../supervisor");
    core.configureCore({ stateDir: state, vault: A.path });
    configureSettings({ log: () => signalLog(A.path) });
  });
  afterAll(async () => {
    if (srv) await new Promise<void>((r) => srv!.close(() => r()));
    core.configureCore(null);
    _resetConvLogs();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const get = async (path: string) => {
    const r = await fetch(base + path);
    return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
  };
  const getJson = async (path: string) => JSON.parse((await get(path)).bytes.toString());
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  it("is on by default; Carl can turn it off: then nothing is built, nothing lands, nothing is offered", async () => {
    expect((await getJson("/api/v2/core")).publish).toBe(true);
    expect(setSetting("corePublish", false, "carl").ok).toBe(true);
    const calls: string[] = [];
    const exec = (cmd: string) => (calls.push(cmd), { status: 0, stdout: "c".repeat(40), stderr: "" });
    let started = 0;
    const deps = { stateDir: state, repo: join(home, "repo"), changes: () => sup.supervisorOf(A.path).changes(CORE_PART), exec, on: () => false, startJob: (() => (started++, { text: "" })) as never };
    expect(core.publishTick(deps)).toBe("off");
    expect(calls).toEqual([]);
    expect(started).toBe(0);
    const x = build("x", { "index.html": "<p>x</p>" });
    const keep = await post("/api/v2/supervisor", { plugin: CORE_PART, change: "keep", version: x.version, by: "carl" });
    expect(keep.status).toBe(409);
    expect(keep.json.error).toContain("corePublish");
    expect(await getJson("/api/v2/core")).toMatchObject({ publish: false, offer: null });
    expect((await getJson("/api/v2/changes?surface=laptop")).changes.some((c: { plugin: string }) => c.plugin === CORE_PART)).toBe(false);
    expect(setSetting("corePublish", true, "carl").ok).toBe(true);
    expect((await getJson("/api/v2/core")).publish).toBe(true);
  });

  it("the card says what a bundle changes: main's commit titles (git log of the box's repo), not just a hash", () => {
    const C = "6".repeat(40);
    // git log's records: \x1e, then hash, time, subject, Look trailers; then the paths each changed.
    const log = `\x1e${C}\t300\tInline pages play their video and audio: relative refs\t[data-el="chat-scroll"] :: a page's video plays\n\nsrc/InlineHtmlFrame.tsx\nserver/http.ts\n` + `\x1e${"7".repeat(40)}\t200\tFree local voice by default: Kokoro\t\n\nserver/voiceProvider.ts\n`;
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => (calls.push([cmd, ...args]), { status: 0, stdout: log, stderr: "" });
    const commits = core.coreCommits("/repo", C, 40, exec);
    expect(commits).toEqual([
      { commit: C, time: 300, title: "Inline pages play their video and audio: relative refs", frontend: true, visible: true, look: [{ selector: '[data-el="chat-scroll"]', text: "a page's video plays" }] },
      { commit: "7".repeat(40), time: 200, title: "Free local voice by default: Kokoro", frontend: false, visible: false },
    ]);
    expect(calls[0]).toEqual(["git", "-C", "/repo", "log", "--first-parent", "-n40", "--format=%x1e%H%x09%ct%x09%s%x09%(trailers:key=Look,valueonly=true,separator=%x1f)", "--name-only", C]);
    expect(core.coreCommits("/repo", C, 40, exec)).toBe(commits);
    expect(calls.length).toBe(1);
    expect(core.coreCommits("/repo", "not-a-commit", 40, exec)).toEqual([]);
    const y = build("why-words", { "index.html": "<p>words</p>" }, NEEDS, 100, "2099-01-01T00:00:00Z");
    const p = core.pendingCore(state, sup.supervisorOf(A.path).changes(CORE_PART), true, () => commits);
    expect(p?.version).toBe(y.version);
    // The box's own voice change is not the frontend's: the card names only what the bundle brings.
    expect(p?.what).toBe("new frontend: Inline pages play their video and audio");
    expect(p?.core?.commits).toEqual(commits);
    expect(core.pendingCore(state, sup.supervisorOf(A.path).changes(CORE_PART), true)?.core?.commits).toBeUndefined();
    rmSync(join(root, y.version), { recursive: true, force: true });
  });

  it("a finished build job no longer holds the one-job cap: the next main's build starts", () => {
    // The job registry kept a done build "running" (nothing reaped it), so every later main was refused.
    const work = join(state, "core-bundles", "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "jobs.json"), JSON.stringify([{ id: "core-old-1", name: "core-old", command: "true", startedAt: Date.now() - 60_000, timeoutS: 2700, state: "running" }]));
    writeFileSync(join(work, "core-old-1.log"), "stored core\n[exit 0]\n");
    const exec = () => ({ status: 0, stdout: "d".repeat(40), stderr: "" });
    let started = 0;
    const deps = { stateDir: state, repo: join(home, "repo"), changes: () => sup.supervisorOf(A.path).changes(CORE_PART), exec, on: () => true, startJob: (() => (started++, { text: "not started" })) as never };
    core.publishTick(deps);
    const jobs = JSON.parse(readFileSync(join(work, "jobs.json"), "utf8"));
    expect(jobs.find((j: { id: string }) => j.id === "core-old-1")).toMatchObject({ state: "finished", exit: 0 });
    expect(started).toBe(1);
    rmSync(join(work, "jobs.json"), { force: true });
    rmSync(join(state, "core-bundles", "publisher.json"), { force: true });
  });

  it("stores a bundle by its manifest's hash and serves it byte for byte; tampering and paths outside it are refused", async () => {
    const one = build("one", { "index.html": "<p>one</p>", "assets/app-1.js": "console.log(1)" });
    expect(one.sha256.startsWith(one.version)).toBe(true);
    // The same files built at the same time: the same version.
    expect(build("uno", { "index.html": "<p>one</p>", "assets/app-1.js": "console.log(1)" }).version).toBe(one.version);
    const m = await get(`/api/v2/core/${one.version}/manifest.json`);
    expect(m.status).toBe(200);
    expect(sha(m.bytes)).toBe(one.sha256);
    const f = await get(`/api/v2/core/${one.version}/files/assets/app-1.js`);
    expect(f.bytes.toString()).toBe("console.log(1)");
    expect(sha(f.bytes)).toBe(JSON.parse(m.bytes.toString()).files.find((x: { path: string }) => x.path === "assets/app-1.js").sha256);
    expect((await get(`/api/v2/core/${one.version}/files/missing.js`)).status).toBe(404);
    expect((await get(`/api/v2/core/${one.version}/files/..%2F..%2Fmanifest.json`)).status).toBe(404);
    expect((await get(`/api/v2/core/00000000/manifest.json`)).status).toBe(404);
    // Nothing landed yet: the installed app's own core.
    expect((await getJson("/api/v2/core")).offer).toBeNull();
    // A manifest changed on disk no longer hashes to its version: it is not served.
    const two = build("two", { "index.html": "<p>two</p>" });
    const mf = join(root, two.version, "manifest.json");
    writeFileSync(mf, readFileSync(mf, "utf8").replace('"boxApi": 1', '"boxApi": 2'));
    expect((await get(`/api/v2/core/${two.version}/manifest.json`)).status).toBe(404);
    expect(core.readCoreManifest(state, two.version)).toBeNull();
  });

  it("lands and switches with the plugin.change record for app/core; the offer follows; a bundle needing a newer box is refused", async () => {
    const a = build("aa", { "index.html": "<p>a</p>" });
    const b = build("bbb", { "index.html": "<p>b</p>" });
    expect((await post("/api/v2/supervisor", { plugin: CORE_PART, change: "keep", version: a.version, by: "gate", reason: "built" })).status).toBe(200);
    expect((await getJson("/api/v2/core")).offer).toMatchObject({ version: a.version, sha256: a.sha256, commit: COMMIT, needs: NEEDS });
    expect((await post("/api/v2/supervisor", { plugin: CORE_PART, change: "keep", version: b.version, by: "gate" })).status).toBe(200);
    expect((await getJson("/api/v2/core")).offer.version).toBe(b.version);
    // The laptop's loader fell back: a switch by "auto" to what it fell back to.
    const back = await post("/api/v2/supervisor", { plugin: CORE_PART, change: "switch", version: a.version, by: "auto", reason: "did not say ready within 30 s" });
    expect(back.status).toBe(200);
    const rec = sup.supervisorOf(A.path).changes(CORE_PART).at(-1)!;
    expect(rec).toMatchObject({ change: "switch", version: a.version, from: b.version, by: "auto" });
    expect((await getJson("/api/v2/core")).offer.version).toBe(a.version);
    // A switch with no version goes back to what the last landing replaced; to built-in when there is none.
    expect((await post("/api/v2/supervisor", { plugin: CORE_PART, change: "switch", version: "built-in" })).status).toBe(200);
    expect((await getJson("/api/v2/core")).offer).toBeNull();
    // Unknown bundles and bundles needing a newer box API never land.
    expect((await post("/api/v2/supervisor", { plugin: CORE_PART, change: "keep", version: "deadbeef" })).status).toBe(404);
    const future = build("future", { "index.html": "<p>f</p>" }, { ...NEEDS, boxApi: CORE_BOX_API + 1 });
    const r = await post("/api/v2/supervisor", { plugin: CORE_PART, change: "keep", version: future.version });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain(`box API ${CORE_BOX_API + 1}`);
  });

  it("the publisher builds a new main once, as a job outside the server; its result waits as Change ready; Keep, Switch back and Discard are the plugin.change records", async () => {
    const main = "c".repeat(40);
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === "git") return { status: 0, stdout: main + "\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const changes = () => sup.supervisorOf(A.path).changes(CORE_PART);
    const cards = async () => ((await getJson("/api/v2/changes?surface=laptop")).changes as { plugin: string; version: string; name: string; what: string; tryOn: string[]; core?: { sha256: string } }[]).filter((c) => c.plugin === CORE_PART);
    // The build goes through the existing StartJob path (startJobWith), never a systemd-run call of its own.
    const jobs: { cmd: string; logDir: string; memoryMax?: string }[] = [];
    let running = true;
    const startJob = ((env: { logDir: string; memoryMax?: string }, _cwd: string, a: { command: string }) => {
      jobs.push({ cmd: a.command, logDir: env.logDir, memoryMax: env.memoryMax });
      const job = { id: "core-job-1", name: "core", command: a.command, startedAt: Date.now(), timeoutS: 3000, state: "running" as const };
      writeFileSync(join(env.logDir, "jobs.json"), JSON.stringify([job]));
      return { text: "started", job };
    }) as never;
    const probe = (() => ({ state: running ? "running" : "finished", tail: "" })) as never;
    const deps = { stateDir: state, repo: join(home, "repo"), changes, exec, on: () => true, startJob, probe };
    expect(core.publishTick(deps)).toContain("building core from main cccccccccccc");
    expect(calls.some((c) => c[0] === "systemd-run")).toBe(false);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.memoryMax).toBe("6G");
    expect(jobs[0]!.cmd).toContain("scripts/core-publish.ts");
    expect(jobs[0]!.cmd).toContain(`archive ${main}`);
    // While it builds, nothing else starts.
    expect(core.publishTick(deps)).toContain("building");
    expect(jobs).toHaveLength(1);
    // Its result is stored, and waits for Carl: no record, the offer does not move, a Change ready card lists it.
    const before = changes().length;
    const offerBefore = (await getJson("/api/v2/core")).offer;
    const built = build("built-newest", { "index.html": "<p>main c</p>" }, NEEDS, 300, "2026-11-18T00:00:01Z");
    mkdirSync(join(root, "work", main.slice(0, 12)), { recursive: true }); // the job's shell makes it
    writeFileSync(join(root, "work", main.slice(0, 12), "result.json"), JSON.stringify({ ok: true, version: built.version, sha256: built.sha256, commit: main }));
    running = false;
    expect(core.publishTick(deps)).toBe(`built core ${built.version} (main cccccccccccc): offered on the laptop (applied quietly when nothing on screen changes, else "Try it?" in Main)`);
    expect(changes().length).toBe(before);
    expect((await getJson("/api/v2/core")).offer).toEqual(offerBefore);
    expect(core.publishTick(deps)).toBe("up to date");
    expect(changes().length).toBe(before);
    const [card] = await cards();
    expect(card).toMatchObject({ plugin: CORE_PART, name: "App core", version: built.version, tryOn: ["laptop"], core: { sha256: built.sha256, commit: COMMIT, commitTime: 300, needs: NEEDS, boxApi: CORE_BOX_API } });
    expect(card!.what).toContain(`main ${COMMIT.slice(0, 12)}`);
    // The phone lists it too (Keep / Discard there; Try only on the laptop).
    expect((await getJson("/api/v2/changes?surface=phone")).changes.some((c: { plugin: string }) => c.plugin === CORE_PART)).toBe(true);
    // Keep (Carl's word): the core every laptop runs; the card goes.
    const from = core.coreOffer(state, changes())?.version ?? "built-in";
    expect((await post("/api/v2/supervisor", { plugin: CORE_PART, change: "keep", version: built.version })).status).toBe(200);
    expect(changes().at(-1)).toMatchObject({ change: "keep", version: built.version, from, by: "carl" });
    expect((await getJson("/api/v2/core")).offer.version).toBe(built.version);
    expect(await cards()).toEqual([]);
    // Switch back: what the Keep replaced; the bundle switched away from is never offered again.
    expect((await post("/api/v2/supervisor", { plugin: CORE_PART, change: "switch" })).status).toBe(200);
    expect(changes().at(-1)).toMatchObject({ change: "switch", version: from, from: built.version });
    expect(core.coreOffer(state, changes())?.version ?? "built-in").toBe(from);
    expect(await cards()).toEqual([]);
    // A newer build: a card again; Discard drops it (nothing lands).
    const next = build("built-newest-2", { "index.html": "<p>main d</p>" }, NEEDS, 400, "2026-11-18T00:00:02Z");
    expect((await cards()).map((c) => c.version)).toEqual([next.version]);
    expect((await post("/api/v2/supervisor", { plugin: CORE_PART, change: "discard", version: next.version })).status).toBe(200);
    expect(await cards()).toEqual([]);
    expect(core.coreOffer(state, changes())?.version ?? "built-in").toBe(from);
    // One needing a newer box API is never a card.
    build("built-newest-3", { "index.html": "<p>future</p>" }, { ...NEEDS, boxApi: CORE_BOX_API + 1 }, 500, "2026-11-18T00:00:03Z");
    expect(await cards()).toEqual([]);
  });

  it("a failed build is given up after two tries", () => {
    const main = "d".repeat(40);
    let runs = 0;
    const exec = (cmd: string) => (cmd === "git" ? { status: 0, stdout: main, stderr: "" } : { status: 0, stdout: "", stderr: "" });
    const startJob = (() => (runs++, { text: "started", job: { id: `j${runs}`, name: "core", command: "", startedAt: 0, timeoutS: 1, state: "running" } })) as never;
    const deps = { stateDir: state, repo: join(home, "repo"), changes: () => sup.supervisorOf(A.path).changes(CORE_PART), exec, on: () => true, startJob, probe: (() => ({ state: "finished", tail: "" })) as never };
    for (let i = 0; i < 6; i++) {
      core.publishTick(deps);
      mkdirSync(join(root, "work", main.slice(0, 12)), { recursive: true });
      writeFileSync(join(root, "work", main.slice(0, 12), "result.json"), JSON.stringify({ ok: false, error: "vite build failed (exit 1)" }));
    }
    expect(runs).toBe(2);
    expect(core.readPublisher(state).attempts.filter((a) => a.commit === main).every((a) => a.state === "failed")).toBe(true);
  });
});

describe("what a bundle needs, and what the laptop takes", () => {
  it("scans invoke calls and plugin imports; guarded commands no shell has are not needs", () => {
    const n = scanNeeds([`invoke("read_text_file", {path}); invoke<string>( 'app_ready' ); x.invoke("plugin:updater|check"); invoke("phone_push_result")`, `import { open } from "@tauri-apps/plugin-dialog";`]);
    expect(n).toEqual({ commands: ["app_ready", "read_text_file"], plugins: ["dialog"] });
  });

  it("every command this source invokes is one the shell registers (else no bundle of it could ever run)", () => {
    const repo = join(__dirname, "..", "..");
    const needs = needsOf(repo);
    const lib = readFileSync(join(repo, "src-tauri", "src", "lib.rs"), "utf8");
    const list = lib.slice(lib.indexOf("shell_commands!["), lib.indexOf("];", lib.indexOf("shell_commands![")));
    const shell = [...list.matchAll(/(?:^|::)\s*([a-z_0-9]+),?\s*$/gm)].map((m) => m[1]!);
    expect(missingNeeds(needs, { commands: shell, plugins: ["autostart", "dialog", "opener", "process", "single-instance", "updater"] })).toEqual([]);
    expect(needs.commands).toContain("core_ready");
  });

  it("manifests and paths are checked", () => {
    expect(safeCorePath("assets/index-Ab_1.js")).toBe(true);
    for (const p of ["../x", "/x", "a\\b", "a//b", ".x", ""]) expect(safeCorePath(p)).toBe(false);
    expect(manifestProblem({ schema: 1, commit: COMMIT, commitTime: 1, builtAt: "x", needs: NEEDS, files: [{ path: "a.js", sha256: "0".repeat(64), size: 1 }] })).toBe("no index.html");
  });

  it("the laptop takes a newer, compatible offer; never one older than its installer's own, one that failed here, or one its shell or box cannot serve", () => {
    const offer = { version: "12345678", sha256: "12345678" + "0".repeat(56), commit: COMMIT, commitTime: 200, needs: NEEDS, seq: 9 };
    const shell = { commands: ["app_ready", "read_text_file"], plugins: ["dialog"] };
    const base = { offer, active: null, bad: [] as string[], bakedCommitTime: 100, shell, boxApi: CORE_BOX_API };
    expect(nextCoreStep(base).kind).toBe("install");
    expect(nextCoreStep({ ...base, active: "12345678" }).kind).toBe("stay");
    expect(nextCoreStep({ ...base, bad: ["12345678"] })).toMatchObject({ kind: "stay", why: expect.stringContaining("failed here") });
    expect(nextCoreStep({ ...base, bakedCommitTime: 200 }).kind).toBe("stay");
    expect(nextCoreStep({ ...base, bakedCommitTime: 300, active: "87654321" }).kind).toBe("baked");
    expect(nextCoreStep({ ...base, shell: { ...shell, commands: ["app_ready"] } })).toMatchObject({ kind: "stay", why: expect.stringContaining("read_text_file") });
    expect(nextCoreStep({ ...base, boxApi: null }).kind).toBe("stay");
    expect(nextCoreStep({ ...base, offer: null }).kind).toBe("stay");
    // Switched back to the installed app's own core (no box bundle in effect): the laptop runs its baked one.
    expect(nextCoreStep({ ...base, offer: null, active: "87654321" }).kind).toBe("baked");
  });
});

describe("LaptopBuild says which core runs, apart from the native shell", () => {
  it("keeps the laptop's core field and refuses a bad one", async () => {
    const { cleanHostBuild } = await import("../hostBuild");
    const b = cleanHostBuild({ host: "laptop", version: "0.7.25", revision: COMMIT, surface: "tauri-production", nativeVersion: "0.9.40", core: { version: "abcd1234", commit: COMMIT, fellBack: "x → built-in: threw" } });
    expect(b).toMatchObject({ nativeVersion: "0.9.40", core: { version: "abcd1234", commit: COMMIT, fellBack: "x → built-in: threw" } });
    expect(cleanHostBuild({ host: "laptop", version: "1", revision: "r", surface: "s", core: { version: "../x" } })).not.toHaveProperty("core");
  });
});

describe("a box-built core says which version it is", () => {
  it("the newest release whose code it contains, plus +core.<commit>; not package.json's never-bumped version", () => {
    const repo = mkdtempSync(join(tmpdir(), "vc-corever-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    const commit = (m: string) => (git("commit", "-q", "--allow-empty", "-m", m), git("rev-parse", "HEAD"));
    const a = commit("a");
    expect(coreAppVersion(repo, a)).toBe(`0.0.0+core.${a.slice(0, 8)}`);
    // CI's way: the release tag is on a version-only child of a main commit, never on main itself.
    const release = (v: string) => {
      const here = git("rev-parse", "HEAD");
      git("checkout", "-q", "--detach");
      commit(`v${v} [skip ci]`);
      git("tag", `v${v}`);
      git("checkout", "-q", "main");
      expect(git("rev-parse", "HEAD")).toBe(here);
    };
    release("0.9.48");
    const b = commit("b");
    release("0.9.49");
    const c = commit("c");
    expect(coreAppVersion(repo, c)).toBe(`0.9.49+core.${c.slice(0, 8)}`);
    // The main commit a release was cut from contains it; an older main only the older release.
    expect(coreAppVersion(repo, b)).toBe(`0.9.49+core.${b.slice(0, 8)}`);
    expect(coreAppVersion(repo, a)).toBe(`0.9.48+core.${a.slice(0, 8)}`);
    // The perf probe and the box accept it as a version.
    expect(/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(coreAppVersion(repo, c))).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });
});
