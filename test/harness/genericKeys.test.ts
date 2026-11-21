// A key is a name and a secret: every key is stored, listed, added, replaced and
// removed the same way, and anything that needs one asks for it by name. Carl: "all
// keys should just be keys, not an ElevenLabs edge case." Fake values only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-generic-keys-");
const fake = installFakeTauri(vault);
const chain = new Map<string, string>();
fake.setHandler("keychain_get", ({ key }: any) => chain.get(key) ?? null);
fake.setHandler("keychain_set", ({ key, value }: any) => void chain.set(key, value));
fake.setHandler("keychain_delete", ({ key }: any) => void chain.delete(key));

const { useStore, hydrateKeychain, keyNamed } = await import("../../src/store.ts");
const { laptopKeys } = await import("../../src/boxKeys.ts");
const { listKeyNames } = await import("../../src/keychain.ts");

test("keys an older build kept under fixed entries become ordinary keys in place, no re-entry, old entry backed up", async () => {
  chain.set("service.elevenlabs", "fake-el-1");
  chain.set("api.openai", "fake-oa-2");
  chain.set("user.lambda_api_key", "fake-lambda-3");
  chain.set("service.claude-code", "fake-signin-4");
  localStorage.setItem("vault_chat_user_keys", JSON.stringify(["lambda_api_key"]));
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.map(String).join(" "));
  try {
    await hydrateKeychain();
  } finally {
    console.warn = warn;
  }
  const s = useStore.getState();
  assert.deepEqual(s.keys, { ELEVENLABS_API_KEY: "fake-el-1", OPENAI_API_KEY: "fake-oa-2", lambda_api_key: "fake-lambda-3" });
  assert.equal(s.serviceKeys.claudeCode, "fake-signin-4", "the sign-in is not a key and stays where it was");
  assert.deepEqual(listKeyNames(), ["ELEVENLABS_API_KEY", "OPENAI_API_KEY", "lambda_api_key"]);
  assert.equal(chain.get("user.ELEVENLABS_API_KEY"), "fake-el-1");
  assert.equal(chain.has("service.elevenlabs"), false);
  assert.equal(chain.get("backup.service.elevenlabs"), "fake-el-1", "backed up before the old entry goes");
  assert.equal(warned.join("\n").includes("fake-"), false, "no value is ever logged");
  // Again: nothing moves twice.
  const before = new Map(chain);
  await hydrateKeychain();
  assert.deepEqual([...chain], [...before]);
});

test("a key added the generic way reaches the box (and so the agent's env) and a plugin asking by name; removed, it is gone", async () => {
  const st = useStore.getState();
  await st.removeKey("ELEVENLABS_API_KEY");
  assert.equal(keyNamed("ELEVENLABS_API_KEY"), null);
  await st.setKey("elevenlabs_api_key", "fake-el-5");
  assert.equal(keyNamed("ELEVENLABS_API_KEY"), "fake-el-5", "asked for by name, any spelling of it");
  assert.equal(chain.get("user.elevenlabs_api_key"), "fake-el-5", "stored like every key");
  let pushed = await laptopKeys();
  assert.equal(pushed["user.elevenlabs_api_key"], "fake-el-5");
  assert.equal(pushed["service.claude-code"], "fake-signin-4");
  // Replace = add under the same name.
  await useStore.getState().setKey("elevenlabs_api_key", "fake-el-6");
  assert.equal(keyNamed("ELEVENLABS_API_KEY"), "fake-el-6");
  await useStore.getState().removeKey("elevenlabs_api_key");
  assert.equal(keyNamed("ELEVENLABS_API_KEY"), null);
  assert.equal(chain.has("user.elevenlabs_api_key"), false);
  pushed = await laptopKeys();
  assert.equal(Object.keys(pushed).some((k) => /eleven/i.test(k)), false, "removed here, removed from the box");
  assert.equal(listKeyNames().includes("elevenlabs_api_key"), false);
});
