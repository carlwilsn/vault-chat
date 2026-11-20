import { describe, expect, it } from "vitest";
import { evaluateReleaseHealth, type BoxReleaseHealth, type LaptopReleaseHealth, type ReleaseTarget } from "../releaseHealth";
const target: ReleaseTarget = { id: "release-1", version: "0.7.19", revision: "a".repeat(40), installedAt: 1000, previousVersion: "0.7.18" };
const box: BoxReleaseHealth = { version: target.version, revision: target.revision, observedAt: 2000, ready: true };
const laptop: LaptopReleaseHealth = { clientId: "paired-laptop", version: target.version, revision: target.revision, observedAt: 2000, challenge: "fresh-release-challenge", tauri: true, frontendMounted: true, boxConnected: true, syncReady: true, updaterReady: true };
const opts = { target, now: 3000, boxDeadline: 4000, maxReportAgeMs: 5000, laptopClientId: laptop.clientId, challenge: laptop.challenge, box, laptop };

describe("post-release health is actual box AND actual laptop", () => {
  it("confirms only fresh matching source/version readiness from both devices", () => {
    expect(evaluateReleaseHealth(opts)).toMatchObject({ status: "healthy", action: "confirm", box: "healthy", laptop: "healthy" });
  });
  it("never treats box reachability as laptop health; offline laptop stays pending without autorevert", () => {
    expect(evaluateReleaseHealth({ ...opts, laptop: undefined })).toMatchObject({ status: "pending", action: "wait", laptop: "pending" });
    expect(evaluateReleaseHealth({ ...opts, now: 100_000, box: { ...box, observedAt: 99_999 }, laptop: undefined })).toMatchObject({ status: "pending", action: "wait", laptop: "pending" });
  });
  it.each([
    { challenge: "old-challenge" }, { clientId: "other-client" }, { revision: "old-source" },
    { version: "0.7.18" }, { observedAt: 999 }, { observedAt: 9999 }, { observedAt: NaN },
  ])("cannot confirm from a stale/replayed/mismatching laptop report %j", (patch) => {
    expect(evaluateReleaseHealth({ ...opts, laptop: { ...laptop, ...patch } })).toMatchObject({ status: "pending", laptop: "pending" });
  });
  it.each(["tauri", "frontendMounted", "boxConnected", "syncReady", "updaterReady"] as const)("a fresh explicit negative laptop %s is telemetry, not source recovery", (field) => {
    expect(evaluateReleaseHealth({ ...opts, laptop: { ...laptop, [field]: false } })).toMatchObject({ status: "failed", action: "needs-attention" });
  });
  it("a reported laptop failure is not replaced by a later box-only ping", () => {
    expect(evaluateReleaseHealth({ ...opts, laptop: { ...laptop, error: "Tauri sync startup failed" } })).toMatchObject({ status: "failed", action: "needs-attention", reason: "Tauri sync startup failed" });
  });
  it("waits for the box before deadline; times out independently of the laptop", () => {
    expect(evaluateReleaseHealth({ ...opts, box: undefined })).toMatchObject({ status: "pending", box: "pending" });
    expect(evaluateReleaseHealth({ ...opts, now: 4000, box: undefined })).toMatchObject({ status: "failed", action: "needs-attention", box: "failed" });
  });
  it("box version alone is not proof: matching revision AND readiness are required", () => {
    expect(evaluateReleaseHealth({ ...opts, box: { ...box, revision: "other" } })).toMatchObject({ status: "pending" });
    expect(evaluateReleaseHealth({ ...opts, box: { ...box, ready: false } })).toMatchObject({ status: "pending" });
  });
  it("failure exposes no source-recovery action or binary-selection policy", () => {
    const result = evaluateReleaseHealth({ ...opts, box: { ...box, error: "startup failed" } });
    expect(result).toMatchObject({ status: "failed", action: "needs-attention" });
    expect(result).not.toHaveProperty("binaryFallback");
  });
});

describe("B's instance-owned voice health extension", () => {
  it("ignores disabled/not-selected voice; does not require a universal live port", () => {
    expect(evaluateReleaseHealth({ ...opts, box: { ...box, voice: { required: false, state: "disabled", owned: false, startupDeadline: 0 } } })).toMatchObject({ status: "healthy" });
  });
  it("requires readiness and exclusive identity, never a foreign health 200", () => {
    expect(evaluateReleaseHealth({ ...opts, box: { ...box, voice: { required: true, state: "ready", owned: true, startupDeadline: 0 } } })).toMatchObject({ status: "healthy" });
    expect(evaluateReleaseHealth({ ...opts, box: { ...box, voice: { required: true, state: "ready", owned: false, startupDeadline: 5000 } } })).toMatchObject({ status: "failed", action: "needs-attention" });
  });
  it("allows an explicit dependency/setup deadline rather than prematurely failing the box", () => {
    const voice = { required: true, state: "starting" as const, owned: false, startupDeadline: 20_000 };
    expect(evaluateReleaseHealth({ ...opts, now: 4500, box: { ...box, voice } })).toMatchObject({ status: "pending", box: "pending" });
    expect(evaluateReleaseHealth({ ...opts, now: 20_000, box: { ...box, observedAt: 19_999, voice } })).toMatchObject({ status: "failed", box: "failed" });
  });
  it("an explicit bind failure is immediately visible with its real cause", () => {
    const voice = { required: true, state: "failed" as const, owned: false, startupDeadline: 20_000, error: "voice pipeline can't start: port in use by other-instance" };
    expect(evaluateReleaseHealth({ ...opts, box: { ...box, voice } })).toMatchObject({ status: "failed", reason: voice.error });
  });
});

describe("voice readiness owns the pipeline run from a version folder", () => {
  // 2026-11-20: the pipeline moved to <state>/voice/versions/<v>/ (95d79d51) while this check still required the
  // child's cwd to be <state>/voice itself, so every new box build failed readiness and was switched back.
  it.skipIf(process.platform !== "linux")("finds a bot.py child under voice/versions/<v> as this server's own", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawn } = await import("node:child_process");
    const { createServer } = await import("node:net");
    const { observeReleaseVoiceHealth } = await import("../releaseHealth");
    const port = await new Promise<number>((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
    const state = mkdtempSync(join(tmpdir(), "vc-voice-health-"));
    const vdir = join(state, "voice", "versions", "abcd1234");
    mkdirSync(vdir, { recursive: true });
    writeFileSync(join(vdir, "bot.py"), [
      "import http.server, json, sys",
      "class H(http.server.BaseHTTPRequestHandler):",
      "    def do_GET(self):",
      "        b = json.dumps({'ok': True, 'brain': 'pi', 'stt': 'auto', 'tts': 'auto'}).encode()",
      "        self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(b)",
      "    def log_message(self, *a): pass",
      `s = http.server.HTTPServer(('127.0.0.1', ${port}), H)`,
      "print('[voice ready]', flush=True)",
      "s.serve_forever()",
    ].join("\n"));
    const child = spawn("python3", ["bot.py"], { cwd: vdir, stdio: ["ignore", "pipe", "inherit"] });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout!.on("data", (b) => String(b).includes("[voice ready]") && resolve()); child.once("exit", () => reject(new Error("bot exited"))); });
      const h = await observeReleaseVoiceHealth({ required: true, stateDir: state, port, startupDeadline: Date.now() + 60_000, pipeline: { running: true, settingUp: false, error: null } });
      expect(h).toMatchObject({ state: "ready", owned: true });
    } finally { child.kill("SIGKILL"); }
  }, 20_000);
});
