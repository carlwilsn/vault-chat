// Real pinned pi, native MCP and a local deterministic provider. No model spend,
// production credentials, handoff attempts, or UI proof. Old snapshots are fixtures.
import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PiBackend, type HostLoadout, type ToolSpec } from "../engine/pi/backend";
import { piPaths } from "../engine/pi/config";
import type { PiProc } from "../engine/pi/proc";
import { fakeChat, chatText } from "./fakeChat";

const spec = (name: string, field = "title", readOnly = false): ToolSpec => ({ type: "function", name, description: `${name} current definition`, readOnly, inputSchema: { type: "object", properties: { [field]: { type: "string" } }, required: [field] } });
const old = [spec("ReadyForReview"), spec("Removed"), spec("WebSearch", "old", true)];
const current = [spec("ReadyForReview", "proofId"), spec("Added"), spec("WebSearch", "query", true), spec("AddedRead", "path", true)];
const names = (body: any) => body.tools.map((t: any) => t.function.name);
const fields = (body: any, name: string) => body.tools.find((t: any) => t.function.name === `mcp__vault_chat__${name}`).function.parameters;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-tool-rebind-"));
  const paths = piPaths(root);
  for (const dir of [paths.agentDir, paths.extDir, paths.instrDir, paths.sessionsDir]) mkdirSync(dir, { recursive: true });
  for (const file of ["vc.mjs", "policy.mjs", "filesystem.mjs", "pdf.mjs"]) copyFileSync(resolve("server/engine/pi/ext", file), join(paths.extDir, file));
  const provider = await fakeChat();
  writeFileSync(join(paths.agentDir, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: provider.url + "/v1", apiKey: "fixture-not-a-key", api: "openai-completions", models: [{ id: "test/fake-model", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] } } }));
  const procs: PiProc[] = [];
  const backends: PiBackend[] = [];
  const prefix = process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0");
  const cli = join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const make = (catalog: () => ToolSpec[]) => {
    const b = new PiBackend({ paths, install: { cli, node: process.execPath, version: "1.1.0", dir: prefix, installed: false }, catalog: new Map(), sandbox: { outer: null, shell: null, denyRead: [], denyWrite: [] }, apiKey: () => null, thinking: "off", idleMs: 60000, maxProcs: 10, subagents: { agentsDirs: [], concurrency: 2, maxTasks: 4, hostMax: 4, timeoutMs: 30000, graceMs: 1000, defaultModel: null }, log: () => {} });
    b.setHandlers({ toolCatalog: async (loadout: HostLoadout) => loadout === "readOnly" ? catalog().filter((t) => t.readOnly) : catalog(), toolCall: async () => ({ ok: true, text: "fixture" }), userInput: async () => "", fileWrite: async () => false });
    const spawn = b.spawn.bind(b);
    b.spawn = async (o) => { const result = await spawn(o); procs.push(result.proc); return result; };
    backends.push(b);
    return b;
  };
  cleanups.push(async () => {
    for (const proc of procs) await proc.close();
    for (const b of backends) { clearInterval((b.side as any).timer); await (b as any).mcp.close(); }
    await provider.close(); rmSync(root, { recursive: true, force: true });
  });
  return { root, paths, provider, procs, make };
}
const model = "test/fake-model";
async function turn(b: PiBackend, threadId: string, text: string) {
  const done = new Promise<any>((resolve) => {
    const listener = (e: any) => { if (e.kind === "turnCompleted" && e.threadId === threadId) { b.off("event", listener); resolve(e); } };
    b.on("event", listener);
  });
  await b.startTurn(threadId, { texts: [text], images: [], model });
  expect(await done).toMatchObject({ status: "completed", error: null });
}
async function sideDone(b: PiBackend, id: string) { return b.side.wait(id); }

describe("existing pi sessions rebind to current host catalog", () => {
  it("resumes the SAME native session after a server replacement: current proofId schema, additions/removals, history and IDs retained", async () => {
    const f = await fixture();
    const previous = f.make(() => old);
    const session = await previous.startThread({ cwd: f.root, model, instructions: "Remember all history.", tools: old, subagents: false });
    await turn(previous, session.threadId, "original-context-marker");
    const before = readFileSync(session.ref!, "utf8");
    expect(fields(f.provider.calls.at(-1), "ReadyForReview").required).toEqual(["title"]);
    await f.procs.at(-1)!.close();
    const resumed = f.make(() => current);
    await resumed.resumeThread(session.threadId, { model, subagents: true });
    expect(readFileSync(session.ref!, "utf8")).toBe(before);
    await turn(resumed, session.threadId, "continue-existing-session");
    const body = f.provider.calls.at(-1)!;
    expect(fields(body, "ReadyForReview").required).toEqual(["proofId"]);
    expect(names(body)).toContain("mcp__vault_chat__Added");
    expect(names(body)).not.toContain("mcp__vault_chat__Removed");
    expect(names(body)).not.toContain("mcp__vault_chat__subagent"); // never upgrade saved capability
    expect(chatText(body)).toContain("original-context-marker");
    expect(readFileSync(session.ref!, "utf8").startsWith(before)).toBe(true);
    expect(JSON.parse(readFileSync(session.ref!, "utf8").split("\n")[0]).id).toBe(session.threadId);
    expect(resumed.threadSource(session.threadId)!.file).toBe(session.ref);
  });

  it("pins an in-flight turn and background child, then replaces only the idle process (not the session)", async () => {
    const f = await fixture(); let catalog = old;
    const b = f.make(() => catalog);
    const session = await b.startThread({ cwd: f.root, model, instructions: "fixture", tools: old, subagents: true });
    f.provider.respond = () => ({ text: "settled", delayMs: 500 });
    const first = turn(b, session.threadId, "inflight-marker");
    const proc = f.procs.at(-1)!;
    catalog = current;
    await b.resumeThread(session.threadId, { model, subagents: true });
    expect(f.procs.at(-1)).toBe(proc);
    await first;
    expect(fields(f.provider.calls[0], "ReadyForReview").required).toEqual(["title"]);
    const child = b.background(session.threadId, { task: "child-marker", agent: { name: "worker", tools: ["read", "WebSearch", "ReadyForReview", "Added"] } });
    // Child is registered before background returns its promise; wait until spawned.
    while (f.procs.length < 2) await new Promise((r) => setTimeout(r, 10));
    await b.resumeThread(session.threadId, { model, subagents: true });
    expect(proc.isAlive()).toBe(true);
    await child;
    await b.resumeThread(session.threadId, { model, subagents: true });
    expect(proc.isAlive()).toBe(false);
    await turn(b, session.threadId, "idle-rebound-marker");
    expect(fields(f.provider.calls.at(-1), "ReadyForReview").required).toEqual(["proofId"]);
    const worker = f.provider.calls.find((c) => chatText(c).includes("child-marker"))!;
    expect(names(worker)).toContain("mcp__vault_chat__WebSearch");
    expect(names(worker)).not.toContain("mcp__vault_chat__ReadyForReview");
    expect(names(worker)).not.toContain("mcp__vault_chat__Added");
    // Worker pinned to parent's in-use snapshot until parent can rebind.
    expect(fields(worker, "WebSearch").required).toEqual(["old"]);
    await b.background(session.threadId, { task: "current-worker-marker", agent: { name: "worker", tools: ["read", "WebSearch", "ReadyForReview"] } });
    const currentWorker = f.provider.calls.find((c) => chatText(c).includes("current-worker-marker"))!;
    expect(fields(currentWorker, "WebSearch").required).toEqual(["query"]);
    expect(names(currentWorker)).not.toContain("mcp__vault_chat__ReadyForReview");
  });

  it("rebinds saved read-only sides with their host loadout, never a refinement's requested authority", async () => {
    const f = await fixture();
    const oldBackend = f.make(() => old);
    const start = { kind: "ask", cwd: f.root, model, tools: ["read", "grep", "find", "ls"], hostLoadout: "readOnly" as const, hostTools: old.filter((t) => t.readOnly), sessionDir: join(f.paths.sessionsDir, "side"), text: "side-context-marker" };
    const side = await oldBackend.side.start(start); await sideDone(oldBackend, side.id);
    await f.procs.at(-1)!.close();
    const b = f.make(() => current);
    const result = await b.side.start({ ...start, side: side.id, hostLoadout: "voiceAct", text: "side-refinement" }); await sideDone(b, side.id);
    expect(result.id).toBe(side.id);
    const body = f.provider.calls.at(-1)!;
    expect(fields(body, "WebSearch").required).toEqual(["query"]);
    expect(names(body)).toContain("mcp__vault_chat__AddedRead");
    expect(names(body)).not.toContain("mcp__vault_chat__ReadyForReview");
    expect(names(body)).not.toContain("mcp__vault_chat__write");
    expect(names(body)).not.toContain("mcp__vault_chat__bash");
    expect(chatText(body)).toContain("side-context-marker");
  });

  it("legacy explicit side allowlists refresh definitions and remove withdrawn tools without granting new ones; one-shots stay tool-less", async () => {
    const f = await fixture();
    const previous = f.make(() => old);
    const start = { kind: "ask", cwd: f.root, model, tools: ["read"], hostTools: [old[1], old[2]], sessionDir: join(f.paths.sessionsDir, "side"), text: "legacy-side" };
    const side = await previous.side.start(start); await sideDone(previous, side.id);
    await f.procs.at(-1)!.close();
    // Recreate pre-fix metadata: full schemas, no semantic loadout/names field.
    const path = join(f.paths.instrDir, `side-${side.id}.json`);
    const meta = JSON.parse(readFileSync(path, "utf8")); delete meta.meta.hostToolNames; writeFileSync(path, JSON.stringify(meta));
    const b = f.make(() => current);
    await b.side.start({ ...start, side: side.id, text: "legacy-refinement" }); await sideDone(b, side.id);
    const body = f.provider.calls.at(-1)!;
    expect(fields(body, "WebSearch").required).toEqual(["query"]);
    expect(names(body)).not.toContain("mcp__vault_chat__Removed");
    expect(names(body)).not.toContain("mcp__vault_chat__AddedRead");
    expect(names(body)).not.toContain("mcp__vault_chat__ReadyForReview");
    const once = await b.side.start({ ...start, kind: "once", tools: [], hostTools: [], ephemeral: true, text: "tool-less" }); await sideDone(b, once.id);
    expect(f.provider.calls.at(-1)!.tools ?? []).toEqual([]);
  });
});
