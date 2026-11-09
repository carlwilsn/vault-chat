// Carl's saved keys must reach every shell the agent runs. Claude Code's Bash
// tool, workers and subagents inherit the CLI's environment, so that env is
// built from the key store at each session start. Fake values only.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { saveKeys, loadKeyStore, agentKeyEnv, agentKeyEnvNames } from "../keys";
import { claudeCliEnv } from "../engine/claude/cliEnv";

const FAKE = {
  "api.anthropic": "fake-anthropic-0001",
  "api.openai": "fake-openai-0002",
  "api.google": "fake-google-0003",
  "service.tavily": "fake-tavily-0004",
  "service.elevenlabs": "fake-eleven-0005",
  "user.lambda_api_key": "fake-lambda-0006",
  "service.claude-code": "fake-signin-0007",
};
const NAMES = ["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "GOOGLE_API_KEY", "LAMBDA_API_KEY", "OPENAI_API_KEY", "TAVILY_API_KEY"];

async function store() {
  const dir = mkdtempSync(join(tmpdir(), "vc-keys-"));
  await saveKeys(dir, FAKE);
  await loadKeyStore(dir);
  return dir;
}
const build = (token: string | null) =>
  claudeCliEnv({ processEnv: { PATH: "/bin" }, configDir: "/tmp/cfg", token, keys: agentKeyEnv() });

describe("saved keys reach the agent's shell", () => {
  it("every saved key is in the CLI env under its documented name", async () => {
    await store();
    const env = build(null);
    for (const n of NAMES) expect(env[n], n).toBeTruthy();
    expect(env.ELEVENLABS_API_KEY).toBe(FAKE["service.elevenlabs"]);
    expect(agentKeyEnvNames()).toEqual(NAMES);
  });

  it("a real shell started with that env sees the names; the sign-in stays CLI-only", async () => {
    await store();
    const env = { ...build("fake-signin-0007") } as Record<string, string>;
    const r = spawnSync("/bin/sh", ["-c", 'for n in ELEVENLABS_API_KEY TAVILY_API_KEY OPENAI_API_KEY GOOGLE_API_KEY LAMBDA_API_KEY; do eval "v=\\${$n}"; [ -n "$v" ] && echo "$n"; done'], { env, encoding: "utf8" });
    expect(r.stdout.trim().split("\n")).toEqual(["ELEVENLABS_API_KEY", "TAVILY_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "LAMBDA_API_KEY"]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fake-signin-0007");
    expect(Object.values(env)).not.toContain(undefined);
    // The sign-in is not exported under a key-style name.
    expect(Object.keys(agentKeyEnv())).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("with a Claude sign-in the saved Anthropic key stays out of the CLI (it would override the subscription)", async () => {
    await store();
    expect(build("fake-signin-0007").ANTHROPIC_API_KEY).toBeUndefined();
    expect(build(null).ANTHROPIC_API_KEY).toBe(FAKE["api.anthropic"]);
  });

  it("re-reading the store picks up a key saved later (next session start)", async () => {
    const dir = await store();
    await saveKeys(dir, { ...FAKE, "service.newthing": "fake-new-0008" });
    await loadKeyStore(dir);
    expect(build(null).NEWTHING_API_KEY).toBe("fake-new-0008");
  });

  it("values never reach the console while the env is built and the store is read/written", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const w = vi.spyOn(process.stdout, "write");
    const e = vi.spyOn(process.stderr, "write");
    const dir = await store();
    build(null);
    agentKeyEnvNames();
    const seen = JSON.stringify([...spies.map((s) => s.mock.calls), w.mock.calls, e.mock.calls]);
    for (const v of Object.values(FAKE)) expect(seen).not.toContain(v);
    // The names list (all that goes in prompts) holds no values either.
    for (const v of Object.values(FAKE)) expect(JSON.stringify(agentKeyEnvNames())).not.toContain(v);
    // Nothing but the store's own two files was written, and neither holds a plain value.
    for (const f of readdirSync(dir)) for (const v of Object.values(FAKE)) expect(readFileSync(join(dir, f), "utf8")).not.toContain(v);
    vi.restoreAllMocks();
  });
});
