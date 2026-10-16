// Local mode: the laptop agent's Bash gets every key as an environment
// variable (src/keyEnv.ts names) — read at each command, never in a prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-keyenv-");
const fake = installFakeTauri(vault);
let seen: any = null;
fake.setHandler("bash_exec", (a) => {
  seen = a;
  return { stdout: "ok", stderr: "", code: 0, timed_out: false };
});
fake.setHandler("read_deny_lines", () => []);
fake.setHandler("read_humanized", () => []);
fake.setHandler("keychain_get", ({ key }) => (key === "user.lambda_api_key" ? "lambda-canary" : null));

const { useStore } = await import("../../src/store.ts");
const { buildTools } = await import("../../src/tools.ts");

test("Bash runs with the keys as environment variables", async () => {
  localStorage.setItem("vault_chat_user_keys", JSON.stringify(["lambda_api_key"]));
  useStore.setState({ vaultPath: vault, apiKeys: { openrouter: "or-canary", anthropic: "ant-canary" }, serviceKeys: { tavily: "tv-canary" } } as any);
  const tools: any = buildTools(vault);
  const out = await tools.Bash.execute({ command: "echo hi" }, { toolCallId: "t1", messages: [] });
  assert.match(String(out), /ok/);
  assert.deepEqual(seen.env, {
    OPENROUTER_API_KEY: "or-canary",
    ANTHROPIC_API_KEY: "ant-canary",
    TAVILY_API_KEY: "tv-canary",
    LAMBDA_API_KEY: "lambda-canary",
  });
  // Never in what the model sees.
  assert.ok(!String(out).includes("canary"));
});
