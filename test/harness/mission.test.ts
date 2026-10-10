// The mission harness, end to end under node against a scripted fake
// OpenRouter: cost recording, loud missing-key failures, the advisory
// completion gate, durable queued wakes, and resume after a restart.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeTauri, makeTempVault, startFakeOpenRouter, type FakeOpenRouter } from "./fakes.ts";

const vault = makeTempVault();
const tauri = installFakeTauri(vault);
const providers = await import("../../src/providers.ts");
const { useStore } = await import("../../src/store.ts");
const ovr = await import("../../src/offVaultRun.ts");
const { computeMissionCost, readConversations } = await import("../../src/conversations.ts");
const { buildTools } = await import("../../src/tools.ts");

const MAIN = "openai/gpt-6.1-sol";
const BG = "anthropic/claude-haiku-5.5";
let auditorVerdict = { pass: false, reason: "report.md does not exist on disk" };
let backgroundDown = false; // the background model (auditor) returns 503

const lastUserText = (body: any): string => {
  const m = [...(body.messages ?? [])].reverse().find((x: any) => x.role === "user");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : (m.content ?? []).map((p: any) => p.text ?? "").join("");
};

let or: FakeOpenRouter;
before(async () => {
  or = await startFakeOpenRouter((body) => {
    if (body.model === BG) {
      // Background jobs (auditor, timeline/status summaries) share one cheap model.
      if (backgroundDown) return { status: 503, errorBody: { error: { message: "upstream down" } } };
      return { text: JSON.stringify(auditorVerdict), cost: 0.0001 };
    }
    if (lastUserText(body).includes("FAIL-WITH-BARE-OBJECT")) {
      // A provider error whose body has no message at all.
      return { status: 400, errorBody: { error: { code: 400, metadata: { provider_name: "Fake" } } } };
    }
    return { text: `ack: ${lastUserText(body).slice(-40)}`, cost: 0.02 };
  });
  providers.setOpenRouterBaseURL(or.url);
  useStore.setState({
    vaultPath: vault,
    apiKeys: { openrouter: "sk-canary" },
    modelId: providers.DEFAULT_MODEL_ID,
    supervisorModelId: providers.DEFAULT_MISSION_MODEL_ID,
    workerModelId: providers.DEFAULT_WORKER_MODEL_ID,
  } as any);
});
after(async () => {
  // Let fire-and-forget background work (timeline cleaning, summaries) finish
  // before the fake server goes away.
  let n = -1;
  while (n !== or.requests.length) {
    n = or.requests.length;
    await new Promise((r) => setTimeout(r, 800));
  }
  providers.setOpenRouterBaseURL(null);
  await or.close();
});

async function waitFor<T>(fn: () => Promise<T> | T, what: string, ms = 15000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

let seq = 0;
function seedConv(c: Record<string, any>): string {
  const id = c.id ?? `t${++seq}${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  tauri.conversations.set(id, {
    id,
    title: c.title ?? id,
    messages: c.messages ?? [],
    status: "idle",
    createdAt: c.createdAt ?? now,
    lastActivityAt: c.lastActivityAt ?? now,
    source: c.source ?? "manual",
    unread: false,
    ...c,
  });
  return id;
}
function seedMission(title: string, extra: Record<string, any> = {}): string {
  return seedConv({
    source: "mission",
    role: "supervisor",
    title,
    mission: title,
    missionState: "RUNNING",
    messages: [
      {
        role: "user",
        content: `MISSION BRIEF\n\nMission: ${title}\n\nDone when:\n- report.md exists with three sections\n- numbers.csv has the totals\n\nStart now.`,
      },
    ],
    ...extra,
  });
}
// A schedule targeting a mission = a pending wake, so the parked-turn check
// (enforceMissionLoopInvariant) is satisfied and doesn't fire nudge turns.
function giveWake(id: string) {
  tauri.schedules.push({
    id: `s-${id}`,
    name: "wake",
    prompt: "check",
    recurrence: { kind: "daily" },
    time: "09:00",
    timezone: "UTC",
    target: { kind: "existing", conversationId: id },
    modelId: MAIN,
    enabled: true,
    markUnreadOnFinish: false,
    createdAt: Date.now(),
  });
}
const conv = (id: string) => tauri.conversations.get(id);
const mainRequests = () => or.requests.filter((b) => b.model !== BG);

test("a mission turn records its cost on the message and the thread; MissionCost sums mission + workers + asks", async () => {
  const m = seedMission("Cost mission");
  giveWake(m);
  const r1 = await ovr.runWorkerTurn(vault, m, "first steer", { modelId: MAIN, direct: true });
  assert.equal(r1.error, undefined);
  const r2 = await ovr.runWorkerTurn(vault, m, "second steer", { modelId: MAIN, direct: true });
  assert.equal(r2.error, undefined);
  const c = conv(m);
  const assistants = c.messages.filter((x: any) => x.role === "assistant");
  assert.equal(assistants.length, 2);
  assert.equal(assistants[0].costUsd, 0.02);
  assert.equal(c.costUsd, 0.04);

  const w = seedConv({ source: "worker", title: "w1", mission: "Cost mission" });
  giveWake(w);
  await ovr.runWorkerTurn(vault, w, "do the work", { modelId: MAIN });
  const a = seedConv({ source: "ask", title: "ask1", askOf: m, costUsd: 0.005 });
  seedConv({ source: "worker", title: "other", mission: "Another mission", costUsd: 9 });

  const b = computeMissionCost(await readConversations(vault), m)!;
  assert.equal(b.totalUsd, 0.065);
  assert.deepEqual(
    b.parts.map((p) => [p.kind, p.id]).sort(),
    [["ask", a], ["mission", m], ["worker", w]].sort(),
  );

  const tools = buildTools(vault, { conversationId: w, tier: "worker" }) as any;
  const out: string = await tools.MissionCost.execute({}, { toolCallId: "x", messages: [] });
  assert.match(out, /total \$0\.07/);
  assert.match(out, /worker "w1"/);
  // The request asked OpenRouter for usage accounting.
  assert.deepEqual(mainRequests().at(-1).usage, { include: true });
});

test("no key: the turn fails loudly — a readable failed message in the thread and a notification", async () => {
  const m = seedMission("Keyless mission");
  useStore.setState({ apiKeys: {} } as any);
  const before = mainRequests().length;
  try {
    const r = await ovr.runWorkerTurn(vault, m, "go", { modelId: MAIN });
    assert.ok(r.error, "returns an error");
  } finally {
    useStore.setState({ apiKeys: { openrouter: "sk-canary" } } as any);
  }
  assert.equal(mainRequests().length, before, "no model call was made");
  const msgs = conv(m).messages;
  const last = msgs.at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(last.failed, true);
  assert.match(last.content, /No OpenRouter API key/);
  assert.match(last.content, /api\.openrouter/);
  assert.equal(msgs.at(-2).content, "go", "the message that could not run is kept");
  const n = tauri.notifications.find((x) => /missing API key/i.test(x.title ?? ""));
  assert.ok(n, `a notification was raised: ${JSON.stringify(tauri.notifications.map((x) => x.title))}`);
});

test("a saved direct-provider pick runs through OpenRouter when only the OpenRouter key exists", async () => {
  const m = seedMission("Rerouted mission");
  giveWake(m);
  const r = await ovr.runWorkerTurn(vault, m, "hello", { modelId: "claude-opus-4-8", direct: true });
  assert.equal(r.error, undefined);
  assert.equal(mainRequests().at(-1).model, "anthropic/claude-opus-4.8");
});

test("completion: CompleteMission needs evidence, then completes even when the auditor disagrees; the verdict is recorded", async () => {
  const m = seedMission("Gate mission");
  auditorVerdict = { pass: false, reason: "report.md does not exist on disk" };
  const tools = buildTools(vault, { conversationId: m, tier: "mission" }) as any;

  const noEv = await ovr.completeMission(vault, m, "");
  assert.equal(noEv.ok, false);
  assert.equal(noEv.needEvidence, true);
  assert.equal(conv(m).completedAt, undefined);

  // MarkDoneWhen: checked off regardless of the auditor; its doubt is recorded + reported.
  const md: string = await tools.MarkDoneWhen.execute(
    { criterion: "report.md exists with three sections", evidence: "wrote report.md" },
    { toolCallId: "a", messages: [] },
  );
  assert.match(md, /Checked off/);
  assert.match(md, /DOUBTS/);
  assert.deepEqual(conv(m).doneWhenDone, ["report.md exists with three sections"]);
  assert.equal(conv(m).audits.length, 1);
  assert.equal(conv(m).audits[0].by, "MarkDoneWhen");
  assert.equal(conv(m).audits[0].pass, false);

  const out: string = await tools.CompleteMission.execute(
    { summary: "Report written.", evidence: "report.md (3 sections), numbers.csv totals row" },
    { toolCallId: "b", messages: [] },
  );
  assert.match(out, /Mission marked complete/);
  assert.match(out, /Auditor flagged/);
  const c = conv(m);
  assert.equal(c.missionState, "DONE");
  assert.ok(c.completedAt);
  const fin = c.audits.at(-1);
  assert.equal(fin.by, "CompleteMission");
  assert.equal(fin.pass, false);
  assert.match(fin.criterion, /numbers\.csv/, "audits the criteria not yet checked off");
  assert.match(fin.evidence, /numbers\.csv totals/);
  const note = tauri.notifications.find((x) => x.title === "Mission complete" && x.convId === m);
  assert.ok(note, "user notified");
  assert.match(note.body, /Auditor flagged/);

  // A second call is idempotent.
  const again: string = await tools.CompleteMission.execute({ summary: "x", evidence: "y" }, { toolCallId: "c", messages: [] });
  assert.match(again, /already complete/);
});

test("completion with an agreeing auditor; an unreachable auditor is recorded as unaudited, never blocking", async () => {
  const m = seedMission("Happy mission");
  auditorVerdict = { pass: true, reason: "both files present" };
  const r = await ovr.completeMission(vault, m, "report.md and numbers.csv written");
  assert.equal(r.ok, true);
  assert.equal(r.audit!.pass, true);

  const m2 = seedMission("Unaudited mission");
  backgroundDown = true; // the auditor call fails → verdict null
  try {
    const r2 = await ovr.completeMission(vault, m2, "done, see report.md");
    assert.equal(r2.ok, true);
    assert.equal(r2.audit!.pass, null);
    assert.match(r2.audit!.reason!, /unaudited/);
  } finally {
    backgroundDown = false;
  }
});

test("queued wakes are durable: a user message first (direct), then the worker wakes as one batch", async () => {
  const m = seedMission("Queue mission");
  giveWake(m);
  await ovr.queueMissionWake(vault, m, 'Your worker "w" (id w1) just finished its turn. Last output: ok');
  await ovr.queueMissionWake(vault, m, "please also add a chart");
  await ovr.queueMissionWake(vault, m, "please also add a chart"); // duplicate ignored
  const file = path.join(vault, ".vault-chat", "pending-wakes.json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).wakes.length, 2);

  const started = await ovr.flushQueuedWakes(vault, m);
  assert.equal(started, true);
  await waitFor(() => conv(m).messages.filter((x: any) => x.role === "assistant").length >= 2, "both queued turns");
  const users = conv(m).messages.filter((x: any) => x.role === "user").map((x: any) => x.content);
  assert.equal(users[1], "please also add a chart", "user message delivered first");
  assert.match(users[2], /^Your worker "w"/, "worker wake delivered after");
  assert.equal(conv(m).messages.find((x: any) => x.content === "please also add a chart").direct, true);
  await waitFor(async () => (await ovr.readQueuedWakes(vault)).filter((w) => w.conv === m).length === 0, "queue drained");
});

test("restart: every active mission (no 72h cutoff), interrupted workers, and persisted wakes are resumed", async () => {
  const old = Date.now() - 10 * 24 * 3600 * 1000;
  // A mission interrupted mid-turn ten days ago.
  const m1 = seedMission("Old interrupted mission", { lastActivityAt: old, createdAt: old });
  giveWake(m1);
  // A parked mission with a worker interrupted mid-turn.
  const m2 = seedMission("Parked mission");
  conv(m2).messages.push({ role: "assistant", content: "spawned a worker" });
  giveWake(m2);
  const w2 = seedConv({
    source: "worker",
    title: "interrupted worker",
    mission: "Parked mission",
    messages: [{ role: "user", content: "build the chart" }],
  });
  giveWake(w2);
  // A parked mission with a wake that was queued before the restart.
  const m3 = seedMission("Queued mission");
  conv(m3).messages.push({ role: "assistant", content: "waiting" });
  giveWake(m3);
  await ovr.queueMissionWake(vault, m3, "the user says: ship it");
  // Finished and killed missions are left alone.
  const done = seedMission("Done mission", { missionState: "DONE", completedAt: Date.now() });
  const killed = seedMission("Killed mission", { missionState: "KILLED", completedAt: Date.now() });

  const res = await ovr.resumeInterruptedMissions(vault);
  assert.ok(res.missions.includes(m1), "old interrupted mission resumed");
  assert.ok(res.workers.includes(w2), "interrupted worker resumed");
  assert.ok(res.flushed.includes(m3), "queued wake delivered");
  for (const id of [done, killed]) {
    assert.ok(![...res.missions, ...res.flushed, ...res.reviewed].includes(id), "terminal missions untouched");
  }
  await waitFor(() => conv(m1).messages.at(-1).role === "assistant", "m1 answered");
  await waitFor(() => conv(w2).messages.at(-1).role === "assistant", "worker answered");
  await waitFor(() => conv(m3).messages.some((x: any) => x.content === "the user says: ship it"), "m3 got the wake");
  // Resume does not duplicate the interrupted user turn.
  assert.equal(conv(m1).messages.filter((x: any) => x.role === "user").length, 1);
  assert.equal(conv(w2).messages.filter((x: any) => x.role === "user").length, 1);
});

test("restart: a parked mission whose worker finished without a delivered wake gets a review wake", async () => {
  const m = seedMission("Lost wake mission");
  conv(m).messages.push({ role: "assistant", content: "spawned worker" });
  seedConv({
    source: "worker",
    title: "finished worker",
    mission: "Lost wake mission",
    messages: [
      { role: "user", content: "task" },
      { role: "assistant", content: "done: wrote out.md" },
    ],
  });
  const res = await ovr.resumeInterruptedMissions(vault);
  assert.ok(res.reviewed.includes(m));
  await waitFor(() => conv(m).messages.some((x: any) => /finished while the app was restarting/.test(x.content)), "review wake");
});

test("a worker whose provider fails with a message-less error object: readable, flagged failed, never [object Object]", async () => {
  const m = seedMission("Crash mission");
  giveWake(m);
  const w = seedConv({ source: "worker", title: "crashy", mission: "Crash mission" });
  giveWake(w);
  const r = await ovr.runWorkerTurn(vault, w, "FAIL-WITH-BARE-OBJECT", { modelId: MAIN });
  assert.ok(r.error);
  assert.ok(!r.error!.includes("[object Object]"), r.error);
  const last = conv(w).messages.at(-1);
  assert.equal(last.failed, true);
  assert.ok(!last.content.includes("[object Object]"), last.content);
  assert.match(last.content, /400/);
});

test("no unknown Tauri commands were needed", () => {
  // Anything here is a command the harness calls that the fake doesn't model.
  const unexpected = [...new Set(tauri.unknown)].filter((c) => !["bash_shell_kind"].includes(c));
  assert.deepEqual(unexpected, []);
});
