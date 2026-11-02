// Real HTTP -> engine -> genuine Pi SDK -> loopback provider. No paid models.
import { it, expect } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { makeVault, startServer, tmp, waitFor, type Running } from "./helpers";
import { fakeChat, chatText } from "./fakeChat";

it("project Ctrl+K keeps its native owner/cwd with another vault open, including completed polls, refinements and stop", async () => {
  const root = tmp("vc-side-native-owner-"), master = join(root, "master");
  const owner = makeVault(join(master, "vaults/vault-chat"));
  const viewer = makeVault(join(master, "vaults/school2"));
  const project = makeVault(join(master, "projects/side-project"));
  const processHome = join(root, "process");
  mkdirSync(processHome);
  writeFileSync(join(project, "AGENTS.md"), "SIDE-OWNER-PROJECT-INSTRUCTIONS");
  const file = join(viewer, "notes/ideas.md"), originalFile = readFileSync(file, "utf8");
  for (const name of ["vault-chat", "school2"]) {
    const bare = join(master, ".hub/vaults", name + ".git");
    mkdirSync(bare, { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", bare]);
  }
  const provider = await fakeChat();
  // Custom vc-context/history messages also have role=user. Match the actual
  // tagged turn, not the last custom user message appended by the extension.
  const turn = (body: any) => (body.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join("\n")).filter((t: string) => /^\[Carl, on /m.test(t)).at(-1) ?? "";
  provider.respond = body => ({ text: turn(body).includes("SIDE-STOP") ? "Stopped replacement" : "# Edited School2 note", delayMs: turn(body).includes("SIDE-STOP") ? 2000 : 0 });
  const network = join(root, "loopback-only.mjs");
  writeFileSync(network, `const actual=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(u.href==='https://openrouter.ai/api/v1/models')return actual(${JSON.stringify(provider.url + "/models")},init);if(['127.0.0.1','localhost','[::1]'].includes(u.hostname))return actual(input,init);throw Error('External fetch refused');};`);
  let srv: Running | undefined;
  try {
    srv = await startServer({ home: processHome, vault: owner, secrets: join(processHome, "empty-credentials"), openrouter: provider.url, extra: { VC_MASTER: master, VC_PI_DIR: process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0"), VC_ENGINE_MODEL: "test/fake-model", VC_PI_UNSAFE: "1", VC_VOICE_PIPELINE: "off", NODE_OPTIONS: "--import " + network } });
    const agent = join(processHome, "state/pi/agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
    writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: provider.url, apiKey: "synthetic-local-only", api: "openai-completions", models: [{ id: "test/fake-model", name: "local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] } } }));
    const get = async (path: string) => { const r = await fetch(srv!.base + path); return { status: r.status, body: await r.json() }; };
    const post = async (path: string, b: any) => { const r = await fetch(srv!.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); expect(r.status).toBe(200); return r.json(); };
    const made = await post("/projects?vault=school2", { folder: project });
    expect(made.ok).toBe(true);
    const convId = made.convId;
    expect((await post("/api/v2/intent?vault=school2", { type: "send", convId, clientId: "owner-context", text: "SIDE-PARENT-ORIGINAL-CONTEXT" })).ok).toBe(true);
    const parent = await waitFor(async () => { const c = (await get(`/conversation?vault=school2&id=${convId}&full=1`)).body; return c.meta?.threadPath && !c.running && !c.meta.running && provider.calls.length ? c : null; }, 30000);
    const parentBytes = readFileSync(parent.meta.threadPath);
    const health = (await get("/api/v1/health")).body;
    const parentProc = health.engine.pi.procs.find((p: any) => p.threadId === parent.meta.threadId);
    expect(parentProc?.busy).toBe(false);
    expect(parentProc.pid).toBeGreaterThan(0);
    const started = await post("/api/v1/side?vault=school2", { kind: "edit", convId, text: `# Ctrl+K: an inline edit\nINSTRUCTION: SIDE-EDIT shorten\nFILE: ${file}\nSELECTION: ${originalFile}`, root: "/untrusted/body/root" });
    expect(started.id).toBeTruthy();
    // Let Pi finish BEFORE the first client poll, as in Carl's six-second run.
    await waitFor(() => /side edit/.test(srv!.logs()) && provider.calls.some(c => turn(c).includes("SIDE-EDIT")), 30000);
    const final = await waitFor(async () => { const r = await get(`/api/v1/side/${started.id}?vault=school2&convId=${convId}&wait=100`); expect(r.status).toBe(200); return r.body.done ? r.body : null; }, 30000);
    expect(final).toMatchObject({ error: null, text: "# Edited School2 note", done: true });
    // The 0.7.26 client omitted convId on poll and stop. No owner cache needed.
    expect((await get(`/api/v1/side/${started.id}?vault=school2&wait=0`)).body).toMatchObject({ text: final.text, done: true });
    const nativeHeader = JSON.parse(readFileSync(final.file, "utf8").split("\n")[0]!);
    expect(nativeHeader.parentSession).toBe(parent.meta.threadPath);
    expect(nativeHeader.cwd).toBe(project);
    expect(final.file).toContain(`/sessions/side/${convId}/`);
    expect(readFileSync(parent.meta.threadPath).equals(parentBytes)).toBe(true);
    const request = provider.calls.find(c => turn(c).includes("SIDE-EDIT"));
    expect(chatText(request)).toContain("SIDE-PARENT-ORIGINAL-CONTEXT");
    expect(chatText(request)).toContain("SIDE-OWNER-PROJECT-INSTRUCTIONS");
    expect(chatText(request)).toContain(file);
    expect(readFileSync(file, "utf8")).toBe(originalFile);
    const refined = await post("/api/v1/side?vault=school2", { kind: "edit", side: started.id, text: "SIDE-REFINE" });
    expect(refined.id).toBe(started.id);
    await waitFor(async () => (await get(`/api/v1/side/${started.id}?vault=school2&wait=100`)).body.done, 30000);
    const stopping = await post("/api/v1/side?vault=school2", { kind: "edit", convId, text: "SIDE-STOP" });
    await waitFor(() => provider.calls.some(c => turn(c).includes("SIDE-STOP")), 30000);
    expect(await post(`/api/v1/side/${stopping.id}/stop?vault=school2`, {})).toEqual({ ok: true });
    const stopped = await waitFor(async () => { const r = await get(`/api/v1/side/${stopping.id}?vault=school2&convId=${convId}&wait=100`); expect(r.status).toBe(200); return r.body.done ? r.body : null; }, 30000);
    expect(stopped.error).toBe("stopped");
    const after = (await get("/api/v1/health")).body.engine.pi.procs.find((p: any) => p.threadId === parent.meta.threadId);
    expect(after).toMatchObject({ pid: parentProc.pid, busy: false });
    expect(readFileSync(parent.meta.threadPath).equals(parentBytes)).toBe(true);
  } finally {
    if (srv) { writeFileSync(join(root, "server.log"), srv.logs()); await srv.stop(); }
    writeFileSync(join(root, "provider-calls.json"), JSON.stringify(provider.calls, null, 2));
    await provider.close();
  }
}, 120000);
