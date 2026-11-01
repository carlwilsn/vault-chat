// Launched by viewerRootNative.test.ts under the ordinary frontend harness loader.
// Only Tauri IPC is adapted: actual store, picker handler, boxChat, HTTP and pi.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, openSync, writeSync, closeSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { installFakeTauri } from "../fakes.ts";

const [base, owner, viewer, other, project, convId, entered, gate, evidence] = process.argv.slice(2);
assert.ok(base && owner && viewer && other && project && convId && entered && gate && evidence);
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const fake = installFakeTauri(owner);
const requests: { route: string; vault: string | null; body?: unknown }[] = [];
fake.setHandler("vault_box_config", ({ vault }) => ({ box: base, vault: vault === owner ? "owner" : vault === viewer ? "viewer" : "other" }));
fake.setHandler("list_markdown_files", ({ vault }) => [{ path: vault + "/README.md", name: "README.md", is_dir: false }]);
fake.setHandler("git_init_if_needed", () => false);
async function via(url: string, init: RequestInit, ms: number) {
  const parsed = new URL(url);
  requests.push({ route: `${init.method} ${parsed.pathname}`, vault: parsed.searchParams.get("vault"), ...(init.body ? {body:JSON.parse(String(init.body))} : {}) });
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  return { status: response.status, body: await response.text() };
}
fake.setHandler("box_get_json", ({ url, timeoutMs }) => via(url, {method:"GET"}, timeoutMs ?? 20000));
fake.setHandler("box_post_json", ({ url, body }) => via(url, {method:"POST", body, headers:{"content-type":"application/json"}}, 20000));
const { useStore } = await import("../../../src/store.ts");
const bc = await import("../../../src/boxChat.ts");
const { openVaultAt } = await import("../../../src/openVault.ts");
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < end, "native lifecycle deadline"); await new Promise(r => setTimeout(r, 20)); }
}
const json = async (route: string) => (await fetch(base + route)).json();
const snapshots: unknown[] = [];
try {
  useStore.setState({vaultPath:owner});
  await useStore.getState().loadConversations();
  await until(() => useStore.getState().conversations.some(c => c.id === convId));
  useStore.getState().selectConversation(convId);
  await until(() => useStore.getState().activeConversationId === convId && !!bc._boxChatSession());
  await bc.boxSend({convId, text:"WORKSPACE-LIFECYCLE-NATIVE"});
  await until(() => existsSync(entered) && useStore.getState().busy);
  const session = bc._boxChatSession();
  const before = await json(`/conversation?id=${convId}&full=1&n=200`);
  const threadPath = before.meta.threadPath;
  const prefix = readFileSync(threadPath);
  const header = JSON.parse(prefix.toString().split("\n")[0]!);
  assert.equal(header.cwd, project);
  assert.equal(header.id, before.meta.threadId);
  const entries = (bytes: string) => bytes.trim().split("\n").map(line => JSON.parse(line));
  const blockedCall = entries(prefix.toString()).flatMap(e => e.message?.content ?? []).reverse().find(block => block.type === "toolCall");
  assert.ok(blockedCall, "native tool call was persisted before switching");
  const initialHealth = await json("/api/v1/health");
  const nativeProcess = initialHealth.engine.pi.procs.find((p: any) => p.threadId === header.id);
  assert.ok(nativeProcess?.busy);
  const prefixSha256 = createHash("sha256").update(prefix).digest("hex");
  const assertPending = async (phase: string) => {
    const detail = await json(`/conversation?id=${convId}&full=1&n=200`);
    const health = await json("/api/v1/health");
    assert.ok(health.engine.liveTurns.some((t: any) => t.convId === convId), `${phase}: native turn still live`);
    const proc = health.engine.pi.procs.find((p: any) => p.threadId === header.id);
    assert.ok(proc?.busy, `${phase}: native process still busy`);
    assert.equal(proc.pid, nativeProcess.pid, `${phase}: same native process`);
    assert.equal(detail.meta.threadPath, threadPath);
    assert.equal(detail.meta.threadId, before.meta.threadId);
    assert.deepEqual(readFileSync(threadPath).subarray(0, prefix.length), prefix);
    assert.ok(!entries(readFileSync(threadPath,"utf8")).some(e => e.message?.toolCallId === blockedCall.id), "blocked tool has no result yet");
    assert.equal(useStore.getState().activeConversationId, convId);
    assert.equal(useStore.getState().busy, true);
    assert.strictEqual(bc._boxChatSession(), session);
    assert.ok(!requests.some(r => (r.body as any)?.type === "stop"), `${phase}: picker must not send Stop`);
    snapshots.push({phase, threadId:detail.meta.threadId, nativeId:header.id, cwd:header.cwd, prefixSha256, blockedToolCallId:blockedCall.id, liveTurns:health.engine.liveTurns, procs:health.engine.pi.procs});
  };
  await assertPending("owner");
  for (const [root, name] of [[viewer,"viewer"],[other,"other"],[owner,"owner-return"]]) {
    useStore.getState().setCurrentFile(useStore.getState().vaultPath + "/README.md", "old viewer file");
    await openVaultAt(root!); // THE titlebar/Settings handler; never direct setVault.
    await bc.startBoxChat(root!);
    assert.equal(useStore.getState().vaultPath, root);
    assert.equal(useStore.getState().currentFile, null);
    assert.equal(useStore.getState().files[0]?.path, root + "/README.md");
    // Give dynamically imported stopAgent and its HTTP ack time to become visible.
    await new Promise(r => setTimeout(r, 150));
    await assertPending(name!);
  }
  // Nonblocking open fails rather than hanging if cancellation killed the FIFO reader.
  const fd = openSync(gate, constants.O_WRONLY | constants.O_NONBLOCK);
  try { writeSync(fd, "explicit lifecycle release\n"); } finally { closeSync(fd); }
  await until(async () => (await json("/api/v1/health")).engine.liveTurns.length === 0 && !useStore.getState().busy);
  const completed = readFileSync(threadPath, "utf8");
  const result = entries(completed).find(e => e.message?.toolCallId === blockedCall.id);
  assert.ok(result && !result.message.isError, "explicit release completes the real tool successfully");
  assert.ok(JSON.stringify(result.message.content).includes("explicit lifecycle release"));
  assert.ok(!completed.includes('"errorMessage":"This operation was aborted"'));
  assert.ok(!completed.includes('"text":"Stopped."'));
  snapshots.push({phase:"explicit-release-completed", threadId:before.meta.threadId, nativeId:header.id, cwd:header.cwd});
} finally {
  writeFileSync(evidence, JSON.stringify({requests,snapshots},null,2));
  bc.stopBoxChat();
}
// The read-only long-poll may still be awaiting a response. No backend stop is sent.
process.exit(0);
