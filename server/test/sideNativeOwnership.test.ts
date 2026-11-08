// Real HTTP -> engine -> genuine Pi SDK -> loopback provider. No paid models.
import { it, expect } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { makeVault, startServer, tmp, waitFor, type Running } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { chatText, lastToolResult } from "./fakeChat";

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
  const provider = await fakeAnthropic();
  // Custom vc-context/history messages also have role=user. Match the actual
  // literal turn, not the last custom user message appended by the extension.
  const turn = (body: any) => (body.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join("\n")).filter((t: string) => /^(?:SIDE-PARENT-|OWNER-(?:BUSY|QUESTION|KILL)|# Ctrl\+K:|SIDE-(?:STOP|REFINE))/m.test(t)).at(-1) ?? "";
  provider.respond = body => {
    if (turn(body).includes("OWNER-BUSY") && lastToolResult(body) === null) return { call: { name: "AskUser", args: { question: "Busy parent tool stays open?", options: ["Continue", "Wait"] } } };
    if (turn(body).includes("OWNER-QUESTION") && lastToolResult(body) === null) return { call: { name: "AskUser", args: { question: "Which local label?", options: ["Alpha", "Beta"] } } };
    if (turn(body).includes("OWNER-KILL")) return { text: "late parent", delayMs: 2000 };
    return ({ text: turn(body).includes("SIDE-STOP") ? "Stopped replacement" : "# Edited School2 note", delayMs: turn(body).includes("SIDE-STOP") ? 2000 : 0 });
  };
  const network = join(root, "loopback-only.mjs");
  writeFileSync(network, `const actual=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(u.href==='https://openrouter.ai/api/v1/models')return actual(${JSON.stringify(provider.url + "/models")},init);if(['127.0.0.1','localhost','[::1]'].includes(u.hostname))return actual(input,init);throw Error('External fetch refused');};`);
  let srv: Running | undefined;
  try {
    srv = await startServer({ home: processHome, vault: owner, secrets: join(processHome, "empty-credentials"), anthropic: provider.url, extra: { VC_MASTER: master,  ".local/state/vault-chat-server/pi/1.1.0"), VC_VOICE_PIPELINE: "off", NODE_OPTIONS: "--import " + network } });
    mkdirSync(agent, { recursive: true });
    const get = async (path: string) => { const r = await fetch(srv!.base + path); return { status: r.status, body: await r.json() }; };
    const post = async (path: string, b: any) => { const r = await fetch(srv!.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); expect(r.status).toBe(200); return r.json(); };
    const made = await post("/projects?vault=school2", { folder: project });
    expect(made.ok).toBe(true);
    const convId = made.convId;
    expect((await post("/api/v2/intent?vault=vault-chat", { type: "send", convId, client: "laptop", clientId: "owner-context", text: "SIDE-PARENT-ORIGINAL-CONTEXT" })).ok).toBe(true);
    const parent = await waitFor(async () => { const c = (await get(`/conversation?vault=school2&id=${convId}&full=1`)).body; return c.meta?.threadPath && c.status !== "running" && provider.calls.length ? c : null; }, 30000);
    const parentBytes = readFileSync(parent.meta.threadPath);
    const health = (await get("/api/v1/health")).body;
    const parentProc = health.engine.claude.sessions.find((p: any) => p.threadId === parent.meta.threadId);
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
    expect(chatText(request)).toContain(`Viewer/file-context vault root: ${viewer}/`);
    expect(chatText(request)).toContain(`Conversation owner: ${owner}/`);
    expect(chatText(request)).not.toContain("/untrusted/body/root");
    expect(readFileSync(file, "utf8")).toBe(originalFile);
    const refined = await post("/api/v1/side?vault=school2", { kind: "edit", side: started.id, text: "SIDE-REFINE" });
    expect(refined.id).toBe(started.id);
    await waitFor(async () => (await get(`/api/v1/side/${started.id}?vault=school2&wait=100`)).body.done, 30000);
    expect((await post("/api/v2/intent?vault=school2", { type: "send", convId, client: "laptop", clientId: "busy-parent", text: "OWNER-BUSY" })).ok).toBe(true);
    const busyParent = await waitFor(async () => { const c = (await get(`/conversation?id=${convId}&vault=school2&full=1`)).body; return c.meta?.pendingAsk ? c : null; }, 30000);
    const busyBytes = readFileSync(parent.meta.threadPath);
    const stopping = await post("/api/v1/side?vault=school2", { kind: "edit", convId, text: "SIDE-STOP" });
    await waitFor(() => provider.calls.some(c => turn(c).includes("SIDE-STOP")), 30000);
    expect(await post(`/api/v1/side/${stopping.id}/stop?vault=school2`, {})).toEqual({ ok: true });
    const stopped = await waitFor(async () => { const r = await get(`/api/v1/side/${stopping.id}?vault=school2&convId=${convId}&wait=100`); expect(r.status).toBe(200); return r.body.done ? r.body : null; }, 30000);
    expect(stopped.error).toBe("stopped");
    const after = (await get("/api/v1/health")).body.engine.claude.sessions.find((p: any) => p.threadId === parent.meta.threadId);
    expect(after).toMatchObject({ pid: parentProc.pid, busy: true });
    expect(readFileSync(parent.meta.threadPath).equals(busyBytes)).toBe(true);
    expect(JSON.parse(readFileSync(parent.meta.threadPath, "utf8").split("\n")[0]!).cwd).toBe(project);
    expect((await get(`/conversation?id=${convId}&vault=school2&full=1`)).body.meta.pendingAsk).toEqual(busyParent.meta.pendingAsk);
    expect(await post("/answer?vault=school2", { convId, text: "Continue", clientMsgId: "busy-tool-answer" })).toMatchObject({ answered: true });
    await waitFor(async () => (await get(`/conversation?id=${convId}&vault=school2&full=1`)).body.status !== "running", 30000);
    // Audit the existing owner-aware controls without changing their lifecycle.
    // An unknown worker on a known parent must reach that parent's engine, not
    // report the conversation absent in the viewer engine.
    for (const op of ["steer", "stop"]) {
      const r = await fetch(srv.base + `/api/v1/conversations/${convId}/subagents/no-such-worker/${op}?vault=school2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "local steer" }) });
      expect(r.status).toBe(409);
      expect((await r.json()).error).toBe("no subagent no-such-worker on this conversation");
    }
    expect((await post("/api/v2/intent?vault=school2", { type: "send", convId, client: "laptop", clientId: "question", text: "OWNER-QUESTION" })).ok).toBe(true);
    await waitFor(async () => (await get(`/conversation?id=${convId}&vault=school2&full=1`)).body.meta.pendingAsk, 30000);
    expect(await post("/answer?vault=school2", { convId, text: "Alpha", clientMsgId: "owner-answer" })).toMatchObject({ ok: true, convId, answered: true });
    await waitFor(async () => (await get(`/conversation?id=${convId}&vault=school2&full=1`)).body.status !== "running", 30000);
    expect((await post("/api/v2/intent?vault=school2", { type: "send", convId, client: "laptop", clientId: "kill", text: "OWNER-KILL" })).ok).toBe(true);
    await waitFor(() => provider.calls.some(c => turn(c).includes("OWNER-KILL")), 30000);
    expect(await post("/kill?vault=school2", { convId })).toMatchObject({ ok: true });
    await waitFor(async () => (await get(`/conversation?id=${convId}&vault=school2&full=1`)).body.status !== "running", 30000);
  } finally {
    if (srv) { writeFileSync(join(root, "server.log"), srv.logs()); await srv.stop(); }
    writeFileSync(join(root, "provider-calls.json"), JSON.stringify(provider.calls, null, 2));
    await provider.close();
  }
}, 120000);
