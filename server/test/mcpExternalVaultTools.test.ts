// The external /mcp binding never offers Carl's vault tools (each runs his code with every
// command key) and never lets an external write/edit land in .vault-chat/tools.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { withPiSessions } from "./fakeSession";

const root = tmp("vcx-");
const vault = join(root, "vault");
const marker = join(root, "ran");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
const toolDir = join(vault, ".vault-chat", "tools", "leaky");
mkdirSync(toolDir, { recursive: true });
writeFileSync(join(toolDir, "TOOL.md"), "---\nname: Leaky\ndescription: test tool\ninput_schema:\n  type: object\n  properties: {}\n---\n");
writeFileSync(join(toolDir, "run.sh"), `touch ${JSON.stringify(marker)}\necho ran\n`);
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

const fsCalls: { name: string; args: any }[] = [];
class FakeBackend extends EventEmitter {
  readonly name = "pi";
  setHandlers() {}
  async ready() { return true; }
  health() { return {}; }
  usageCalls() { return []; }
  childUsageCalls() { return []; }
  async externalPath() { return null; }
  async filesystem(_v: string, names: string[]) {
    return {
      specs: names.map((name) => ({ type: "function", name, description: name, inputSchema: { type: "object", properties: {} } })),
      call: async (name: string, args: any) => { fsCalls.push({ name, args }); return { ok: true, text: "done" }; },
    };
  }
}

let engine: any;
beforeAll(async () => {
  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  const { conversationCommands } = await import("../commands/conversations");
  const { fsCommands } = await import("../commands/fs");
  registerAll(fsCommands);
  registerAll(conversationCommands);
  (await import("../../src/store")).useStore.setState({ vaultPath: vault, conversationsLoaded: true });
  const { configureContext } = await import("../context");
  configureContext({ vault, agentModel: "openai/gpt-6.1-sol" });
  const { Engine } = await import("../engine/engine");
  engine = new Engine({
    vault,
    backend: withPiSessions(new FakeBackend(), join(root, "pi")) as any,
    ledger: { settle: async () => ({ calls: 0, usd: 0, missing: 0, byId: {} }), has: () => false } as any,
    jobEnv: { logDir: join(root, "jobs"), wrap: null, env: {} } as any,
    model: () => "openai/gpt-6.1-sol",
    webSearchModel: "x",
    apiKey: () => null,
    notify: async () => "sent",
    broadcast: () => {},
    log: () => {},
    shell: () => null,
  } as any);
});
afterAll(() => cleanup(root));

describe("external MCP and vault tools", () => {
  it("the vault tool exists for native turns (so the refusal below is meaningful)", async () => {
    const { vaultToolSpecsFor } = await import("../vaultTools");
    expect((await vaultToolSpecsFor(vault)).map((t) => t.name)).toContain("Leaky");
  });

  it("does not list vault tools and refuses calling one or any unlisted name", async () => {
    const b = await engine.mcpBinding({ conversation: null, device: "laptop" });
    const names = b.specs.map((t: any) => t.name);
    expect(names).not.toContain("Leaky");
    expect(names).not.toContain("bash");
    expect(names).toContain("write");
    const signal = new AbortController().signal;
    expect(await b.call("Leaky", {}, { signal })).toMatchObject({ ok: false });
    expect(await b.call("bash", { command: "true" }, { signal })).toMatchObject({ ok: false });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses external write/edit into .vault-chat/tools but passes other writes through", async () => {
    const b = await engine.mcpBinding({ conversation: null, device: "laptop" });
    const signal = new AbortController().signal;
    for (const path of [".vault-chat/tools/new/run.sh", join(vault, ".vault-chat", "tools", "leaky", "run.sh"), ".vault-chat/tools", "notes/../.vault-chat/tools/x/TOOL.md"]) {
      expect(await b.call("write", { path, content: "x" }, { signal })).toMatchObject({ ok: false });
      expect(await b.call("edit", { path, edits: [] }, { signal })).toMatchObject({ ok: false });
    }
    expect(fsCalls).toEqual([]);
    expect(await b.call("write", { path: "notes/ok.md", content: "x" }, { signal })).toMatchObject({ ok: true });
    expect(await b.call("write", { path: ".vault-chat/toolsx/a.md", content: "x" }, { signal })).toMatchObject({ ok: true });
    expect(fsCalls.map((c) => c.args.path)).toEqual(["notes/ok.md", ".vault-chat/toolsx/a.md"]);
  });
});
