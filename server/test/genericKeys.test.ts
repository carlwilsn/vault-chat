// A key is a name and a secret, stored alike (user.<name>); the box hands each to the
// agent's commands as an environment variable of that name and to anything that asks
// for it by name. No provider is special. Fake values only.
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveKeys, loadKeyStore, agentKeyEnv, keyValue } from "../keys";
import { voiceProvider, ELEVENLABS_VOICE_KEY } from "../voiceProvider";
import { ELEVENLABS_VOICE_PLUGIN } from "../../src/appPlugins";

const dir = () => mkdtempSync(join(tmpdir(), "vc-generic-keys-"));
const provider = () => voiceProvider({ elevenlabsPluginOn: true, elKey: keyValue(ELEVENLABS_VOICE_KEY) });

describe("keys are keys", () => {
  it("a key added generically is in the agent's env by name and given to the plugin asking for it", async () => {
    const d = dir();
    await saveKeys(d, { "user.ELEVENLABS_API_KEY": "fake-el-1", "user.lambda_api_key": "fake-lambda-2", "service.claude-code": "fake-signin" });
    await loadKeyStore(d);
    expect(agentKeyEnv()).toEqual({ ELEVENLABS_API_KEY: "fake-el-1", LAMBDA_API_KEY: "fake-lambda-2" });
    expect(ELEVENLABS_VOICE_PLUGIN.keys).toEqual([ELEVENLABS_VOICE_KEY]);
    expect(keyValue(ELEVENLABS_VOICE_KEY)).toBe("fake-el-1");
    expect(keyValue("LAMBDA_API_KEY")).toBe("fake-lambda-2");
    expect(provider()).toBe("elevenlabs");
  });

  it("removed, it is gone from the env and the plugin falls back to the local voice; the old store is kept", async () => {
    const d = dir();
    await saveKeys(d, { "user.ELEVENLABS_API_KEY": "fake-el-1" });
    await saveKeys(d, { "user.lambda_api_key": "fake-lambda-2" });
    await loadKeyStore(d);
    expect(agentKeyEnv().ELEVENLABS_API_KEY).toBeUndefined();
    expect(keyValue(ELEVENLABS_VOICE_KEY)).toBeNull();
    expect(provider()).toBe("local");
    expect(existsSync(join(d, "secrets.age.prev"))).toBe(true);
  });

  it("a store written by an older laptop (service.elevenlabs) still answers by name until the laptop pushes again", async () => {
    const d = dir();
    await saveKeys(d, { "service.elevenlabs": "fake-old", "api.openai": "fake-oa" });
    await loadKeyStore(d);
    expect(keyValue("ELEVENLABS_API_KEY")).toBe("fake-old");
    expect(agentKeyEnv()).toEqual({ ELEVENLABS_API_KEY: "fake-old", OPENAI_API_KEY: "fake-oa" });
    // Both forms at once (mid-migration): the current one wins.
    await saveKeys(d, { "service.elevenlabs": "fake-old", "user.ELEVENLABS_API_KEY": "fake-new" });
    await loadKeyStore(d);
    expect(keyValue("ELEVENLABS_API_KEY")).toBe("fake-new");
  });
});
