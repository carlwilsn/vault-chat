import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateReleaseHealth, observeReleaseVoiceHealth } from "../releaseHealth";
const script = readFileSync(new URL("../deploy/vault-chat-update.sh", import.meta.url), "utf8");
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const helpers = script.slice(script.indexOf("json_field()"), script.indexOf("# refresh_self"));
function readiness(h: Record<string, unknown>, revision = "a".repeat(40), legacy = "") {
  return spawnSync("bash", ["-c", 'PATH="$TEST_PATH";\n' + helpers + '\nhealth() { printf "%s" "$TEST_HEALTH"; }; HEALTH_POLL_S=0; wait_for_version 1.0.1 0 "$TEST_REV" "$TEST_LEGACY"'], { env: { PATH: process.env.PATH, TEST_PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, TEST_HEALTH: JSON.stringify(h), TEST_REV: revision, TEST_LEGACY: legacy }, encoding: "utf8" });
}

describe("actual updater readiness contract (real bash helper, no network or listeners)", () => {
  it("requires matching release version AND revision AND readiness", () => {
    expect(readiness({ version: "1.0.1", rev: "a".repeat(40), releaseReadiness: { status: "healthy" } }).status).toBe(0);
    expect(readiness({ version: "1.0.1", rev: "b".repeat(40), releaseReadiness: { status: "healthy" } }).status).toBe(1);
    expect(readiness({ version: "1.0.0", rev: "a".repeat(40), releaseReadiness: { status: "healthy" } }).status).toBe(1);
    expect(readiness({ version: "1.0.1", rev: "a".repeat(40) }).status).toBe(1);
  });
  it("distinguishes unknown/pending from a fresh negative; pending does not select binary fallback", () => {
    expect(readiness({ version: "1.0.1", rev: "a".repeat(40), releaseReadiness: { status: "pending" } }).status).toBe(2);
    expect(readiness({ version: "1.0.1", rev: "a".repeat(40), releaseReadiness: { status: "failed" } }).status).toBe(1);
    expect(script).toContain('elif [ "$status" = 2 ]; then');
  });
  it("allows an old readiness-less server ONLY when verifying the retained fallback", () => {
    const legacy = { version: "1.0.1", rev: "a".repeat(40) };
    expect(readiness(legacy).status).toBe(1);
    expect(readiness(legacy, "a".repeat(40), "legacy-fallback").status).toBe(0);
    expect(readiness({ ...legacy, releaseReadiness: { status: "failed" } }, "a".repeat(40), "legacy-fallback").status).toBe(1);
  });
  it("writes a source-pinned durable failure BEFORE fallback and retains its first observation on retry", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-updater-delivery-")); roots.push(root);
    const result = spawnSync("bash", ["-c", 'PATH="$TEST_PATH"; set -eu; STATE="$TEST_ROOT"; ver=1.0.1; expected_rev="$TEST_REV"; mkdir -p "$STATE/failed"; cd "$STATE";\n' + helpers + '\nrecord_failure; record_failure'], { env: { PATH: process.env.PATH, TEST_PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, TEST_ROOT: root, TEST_REV: "a".repeat(40) }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const file = join(root, "release-failures", createHash("sha256").update("1.0.1").digest("hex") + ".json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: "1.0.1", revision: "a".repeat(40), observedAt: expect.any(Number) });
    expect(existsSync(join(root, "failed", "1.0.1"))).toBe(true);
    expect(script.indexOf("  record_failure\n")).toBeLessThan(script.indexOf('    point_current "$prev"'));
  });
});

describe("retained published source recovery after binary fallback", () => {
  it("invokes the retained recovery CLI only after fallback readiness, without provider credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-updater-recovery-")); roots.push(root);
    const bin = join(root, "bin"), previous = join(root, "versions", "1.0.0");
    mkdirSync(bin); mkdirSync(previous, { recursive: true }); mkdirSync(join(root, "failed"));
    writeFileSync(join(previous, "server-version.json"), JSON.stringify({ version: "1.0.0", rev: "b".repeat(40) }));
    const invocation = join(root, "invocation.json"), order = join(root, "order");
    const capture = `require("fs").appendFileSync(${JSON.stringify(order)}, "recovery\\n"); require("fs").writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({args:process.argv.slice(1), providerPresent:Object.hasOwn(process.env,"OPENAI_API_KEY"), state:process.env.VC_STATE_DIR, master:process.env.VC_MASTER, recovery:process.env.VC_UPDATER_RECOVERY}));`;
    writeFileSync(join(bin, "node"), `#!/bin/sh\nif [ "$2" = "recover-published-release" ]; then\nexec '${process.execPath}' -e '${capture.replaceAll("'", "'\\''")}' "$@"\nfi\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    const result = spawnSync("bash", ["-c", `set -eu; PATH="$TEST_PATH"; STATE="$TEST_ROOT"; ver=1.0.1; expected_rev="$TEST_REV"; prev=versions/1.0.0; META=server-version.json; BUNDLE=vault-chat-server.mjs; UNIT=test-only; HEALTH_WAIT_S=0; cd "$STATE";\n${helpers}\nlog() { :; }; alert() { :; }; health() { printf '%s' '{"releaseReadiness":{"status":"healthy"}}'; }; point_current() { printf 'fallback\\n' >> "$STATE/order"; }; systemctl() { :; }; wait_for_version() { printf 'ready\\n' >> "$STATE/order"; return 0; }; recover_failed_release;`], { env: { PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, TEST_PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: root, TEST_ROOT: root, TEST_REV: "a".repeat(40), VC_MASTER: join(root, "master"), OPENAI_API_KEY: "fixture-not-a-secret" }, encoding: "utf8" });
    // The update itself remains a failed release, even though recovery was submitted.
    expect(result.status, result.stderr).toBe(1);
    expect(readFileSync(order, "utf8")).toBe("fallback\nready\nrecovery\n");
    expect(JSON.parse(readFileSync(invocation, "utf8"))).toEqual({ args: [join(root, "versions", "1.0.1", "vault-chat-server.mjs"), "recover-published-release"], providerPresent: false, state: root, master: join(root, "master"), recovery: "1" });
  });
});

describe("voice runtime readiness is owned and schema-checked, not a process-running green", () => {
  it("keeps unsupported readiness pending even beyond box deadline", () => {
    const result = evaluateReleaseHealth({ target: { id: "r", version: "1.0.1", revision: "a".repeat(40), installedAt: 1, previousVersion: "1.0.0" }, now: 10_000, boxDeadline: 500, maxReportAgeMs: 100_000, laptopClientId: "device", challenge: "challenge", box: { version: "1.0.1", revision: "a".repeat(40), observedAt: 10_000, ready: true, voice: { required: true, state: "unverified", owned: true, startupDeadline: 500 } } });
    expect(result).toMatchObject({ status: "pending", action: "wait", box: "pending" });
  });
  it("observes a real managed Python fixture listener and validates its HTTP schema (not physical voice proof)", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-owned-runtime-")); roots.push(root);
    const voice = join(root, "voice"); mkdirSync(voice);
    writeFileSync(join(voice, "health.json"), JSON.stringify({ ok: true, brain: "pi", stt: "elevenlabs", tts: "elevenlabs" }));
    writeFileSync(join(voice, "bot.py"), `from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200); self.end_headers()
  with open("health.json", "rb") as f: self.wfile.write(f.read())
 def log_message(self, *_args): pass
server = HTTPServer(("127.0.0.1", 19147), Handler)
print("fixture-ready", flush=True)
server.serve_forever()
`);
    const child = spawn("python3", ["bot.py"], { cwd: voice, env: { PATH: process.env.PATH, VC_VOICE_PIPELINE: "off", VC_PORT: "19047", VC_VOICE_PIPELINE_PORT: "19147" }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => reject(new Error("Owned listener fixture did not start")), 5000);
        child.once("error", e => { clearTimeout(timer); reject(e); });
        child.once("exit", code => { clearTimeout(timer); reject(new Error(`Owned listener fixture exited ${code}`)); });
        child.stdout.once("data", () => { clearTimeout(timer); accept(); });
      });
      const options = { required: true, stateDir: root, port: 19147, startupDeadline: Date.now() + 10000, pipeline: { running: true, settingUp: false, error: null } };
      expect(await observeReleaseVoiceHealth(options)).toMatchObject({ state: "ready", owned: true });
      writeFileSync(join(voice, "health.json"), JSON.stringify({ ok: true, brain: "pi", stt: "unsupported", tts: "elevenlabs" }));
      expect(await observeReleaseVoiceHealth(options)).toMatchObject({ state: "failed", owned: false });
    } finally {
      child.kill("SIGTERM");
      if (child.exitCode === null) await new Promise<void>(done => child.once("exit", () => done()));
    }
  });
  it("distinguishes disabled voice and an actual child setup failure without starting any process", async () => {
    const base = { stateDir: "/not-a-real-pipeline", port: 19149, startupDeadline: Date.now() + 1000, pipeline: { running: false, settingUp: false, error: "failed setup" } };
    expect(await observeReleaseVoiceHealth({ ...base, required: false })).toMatchObject({ required: false, state: "disabled" });
    expect(await observeReleaseVoiceHealth({ ...base, required: true })).toMatchObject({ required: true, state: "failed", owned: false });
  });
});
