// Box plugins reach the agent (server/boxPlugins.ts box.tool / box.prompt / box.hideTool): what reaches the agent's
// catalog, its instructions and its calls, through the same functions the engine uses (server/engine/engine.ts
// hostToolCatalog, changedSections, onToolCall). The end-to-end run with the real Claude Code CLI is in
// claudeBackend.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConvLogs, setFeedVaults } from "../convlog/log";
import { versionOf } from "../../src/pluginDrafts";

const DIR = ".vault-chat/box-plugins";

describe("box plugins reach the agent", () => {
  const home = mkdtempSync(join(tmpdir(), "vc-boxt-"));
  const vault = join(home, "v");
  const f = (n: string) => join(vault, DIR, n);
  let bp: typeof import("../boxPlugins");
  let sup: typeof import("../supervisor");
  const agent = (word: string, extra = "") => `// @vc-change agent ${word}
export function activate(box) {
  box.tool({ name: "Echo${word}", description: "Say a word back", inputSchema: { type: "object", properties: { w: { type: "string" } }, required: ["w"] },
    handler: (args, ctx) => ({ said: args.w + "-${word}", tried: ctx.tried, conv: ctx.conv }) });
  box.prompt("When Carl says ping, answer pong-${word}.");
  box.hideTool("Delegate");
  ${extra}
}
`;
  beforeAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("VC_")) delete process.env[k];
    mkdirSync(join(vault, DIR), { recursive: true });
    vi.stubEnv("VC_STATE_DIR", join(home, "state"));
    _resetConvLogs();
    setFeedVaults(vault, () => [vault]);
    bp = await import("../boxPlugins");
    sup = await import("../supervisor");
  });
  afterAll(() => {
    bp?._resetBoxPlugins();
    bp?._setBoxToolMs(10_000);
    _resetConvLogs();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  const changes = () => sup.supervisorOf(vault).changes("box/agent");

  it("a live plugin's tool joins the catalog and runs; its prompt is said under its id; a tool it hides leaves", async () => {
    expect(await bp.boxAgentTools(vault, null)).toEqual([]);
    expect(await bp.boxAgentPrompt(vault, null)).toBe("");
    writeFileSync(f("agent.js"), agent("one"));
    const tools = await bp.boxAgentTools(vault, null);
    expect(tools).toEqual([{ type: "function", name: "Echoone", description: "Say a word back (box plugin box/agent.)", inputSchema: { type: "object", properties: { w: { type: "string" } }, required: ["w"] } }]);
    // A name another tool already has is left out (vault-chat's own, Carl's vault tools win).
    expect(await bp.boxAgentTools(vault, null, ["Echoone"])).toEqual([]);
    expect(await bp.boxAgentPrompt(vault, null)).toBe("<box-plugins>\nFrom Carl's box plugins (.vault-chat/box-plugins/), in force while each runs:\n\n## box/agent\nWhen Carl says ping, answer pong-one.\n</box-plugins>");
    expect([...(await bp.boxHiddenTools(vault, null))]).toEqual(["Delegate"]);
    expect(await bp.boxAgentCall(vault, "Echoone", { w: "hi" }, { conv: "c1" })).toEqual({ ok: true, text: JSON.stringify({ said: "hi-one", tried: false, conv: "c1" }, null, 2) });
    expect(await bp.boxAgentCall(vault, "Nope", {}, {})).toBeNull();
    expect(bp.boxPluginLine(vault, "agent")).toMatch(/tools Echoone, a prompt, hides Delegate/);
  });

  it("a draft's tools and prompt reach only a conversation that tries it; unload takes them away", async () => {
    writeFileSync(f("agent.draft.js"), agent("two"));
    const v = versionOf(agent("two"));
    // Everyone else: the live copy.
    expect((await bp.boxAgentTools(vault, null)).map((t) => t.name)).toEqual(["Echoone"]);
    expect(await bp.boxAgentCall(vault, "Echotwo", { w: "x" }, {})).toBeNull();
    // A chat started while trying: the draft in its place.
    const tries = { "box/agent": v };
    expect((await bp.boxAgentTools(vault, tries)).map((t) => t.name)).toEqual(["Echotwo"]);
    expect(await bp.boxAgentPrompt(vault, tries)).toContain("## box/agent (draft Carl is trying)\nWhen Carl says ping, answer pong-two.");
    expect((await bp.boxAgentCall(vault, "Echotwo", { w: "x" }, { tries }))?.text).toContain('"tried": true');
    // A stale version tries nothing.
    expect((await bp.boxAgentTools(vault, { "box/agent": "deadbeef" })).map((t) => t.name)).toEqual(["Echoone"]);
    // Turned off: nothing reaches the agent.
    sup.setPluginDesired(vault, { plugin: "box/agent", state: "stopped" }, "agent");
    await bp.reconcileBoxPlugins(vault);
    expect(await bp.boxAgentTools(vault, null)).toEqual([]);
    expect(await bp.boxAgentPrompt(vault, tries)).toBe("");
    expect((await bp.boxHiddenTools(vault, null)).size).toBe(0);
    sup.setPluginDesired(vault, { plugin: "box/agent", state: "running" }, "agent");
    expect((await bp.boxAgentTools(vault, null)).map((t) => t.name)).toEqual(["Echoone"]);
  });

  it("a tried draft's tool that throws is an error result and discards the draft by itself", async () => {
    const bad = agent("three", 'box.tool({ name: "Breaks", description: "always throws", handler: () => { throw new Error("tool broke"); } });');
    writeFileSync(f("agent.draft.js"), bad);
    const v = versionOf(bad);
    const r = await bp.boxAgentCall(vault, "Breaks", {}, { tries: { "box/agent": v } });
    expect(r).toMatchObject({ ok: false });
    expect(r!.text).toMatch(/^Error: box\/agent's tool Breaks threw: tool broke \(the draft discarded itself\)/);
    expect(changes().at(-1)).toMatchObject({ change: "discard", version: v, by: "auto" });
    expect(existsSync(f("agent.draft.js"))).toBe(false);
    // The live copy was never touched.
    expect((await bp.boxAgentTools(vault, null)).map((t) => t.name)).toEqual(["Echoone"]);
  });

  it("a tried draft's tool slower than the limit is an error result and discards the draft", async () => {
    bp._setBoxToolMs(300);
    const slow = agent("four", 'box.tool({ name: "Slow", description: "never answers", handler: () => new Promise(() => {}) });');
    writeFileSync(f("agent.draft.js"), slow);
    const v = versionOf(slow);
    const r = await bp.boxAgentCall(vault, "Slow", {}, { tries: { "box/agent": v } });
    expect(r).toMatchObject({ ok: false });
    expect(r!.text).toMatch(/tool Slow took over 300 ms/);
    expect(changes().at(-1)).toMatchObject({ change: "discard", version: v, by: "auto" });
    bp._setBoxToolMs(10_000);
  });

  it("an over-long prompt or Plugins hidden does not load; a draft that does so discards itself when tried", async () => {
    const long = agent("five", `box.prompt("${"x".repeat(1600)}");`);
    writeFileSync(f("agent.draft.js"), long);
    expect(await bp.boxAgentTools(vault, { "box/agent": versionOf(long) })).toEqual([]);
    expect(changes().at(-1)).toMatchObject({ change: "discard", version: versionOf(long), by: "auto" });
    expect(changes().at(-1).reason).toMatch(/box\.prompt: at most 1500 characters/);
    const hides = agent("six", 'box.hideTool("Plugins");');
    writeFileSync(f("agent.draft.js"), hides);
    await bp.boxAgentTools(vault, { "box/agent": versionOf(hides) });
    expect(changes().at(-1).reason).toMatch(/Plugins cannot be hidden/);
  });

  it("a conversation's tries keep only box plugins", () => {
    expect(bp.cleanTries({ "box/agent": "1a2b3c4d", "app/chat": "1a2b3c4d", "box/Bad": "x", "box/ok": 5 })).toEqual({ "box/agent": "1a2b3c4d" });
    expect(bp.cleanTries("nope")).toBeNull();
    expect(bp.cleanTries({})).toBeNull();
  });
});
