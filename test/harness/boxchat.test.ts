// [phase 2] Box-mode chat against a fake box: the laptop sends to /message,
// streams over /poll, stops with /kill, answers with /answer, and goes
// read-only (with the reason) when the box is unreachable. The laptop never
// runs a model turn and never writes a conversation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

// ---------- the fake box ----------

type Msg = Record<string, any>;
type Conv = { id: string; title: string; source: string; status: string; state?: string; runStartedAt?: number; messages: Msg[]; lastActivityAt: number };

class FakeBox {
  url = "";
  convs = new Map<string, Conv>();
  ring: { seq: number; ev: any }[] = [];
  seq = 100;
  /** The process id /poll answers carry (server/ring.ts `boot`). */
  boot = "boot-1";
  /** The next /conversation answer is the state at its request, sent this many ms later. */
  delayNextDetail = 0;
  /** Store a steer as the engine does: the reply so far, then the message. */
  splitSteer = false;
  posts: { path: string; body: any }[] = [];
  /** Every request's route and the vault it named (`?vault=`). */
  seen: { route: string; vault: string | null }[] = [];
  down = false;
  full = true; // honours /conversation?full=1
  autoReply = true;
  private waiters = new Set<() => void>();
  private server!: http.Server;
  private n = 0;

  emit(ev: any) {
    this.ring.push({ seq: ++this.seq, ev });
    for (const w of [...this.waiters]) w();
  }

  /** The box process restarts: a new boot id, its ring starts over at `seq`
   *  (lower = the sequence reset; higher = the persisted floor), and the
   *  old process's events are gone. */
  restart(seq: number) {
    this.boot = `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.ring = [];
    this.seq = seq;
    for (const w of [...this.waiters]) w();
  }

  conv(id: string): Conv {
    return this.convs.get(id)!;
  }

  finish(id: string, text: string, tools: Msg[] = []) {
    const c = this.conv(id);
    const m: Msg = { role: "assistant", content: text };
    if (tools.length) m.toolCalls = tools;
    c.messages.push(m);
    c.lastActivityAt = Date.now();
    this.emit({ type: "message", convId: id, role: "assistant", content: text, tools: tools.map((t) => t.name) });
    c.status = "idle";
    c.runStartedAt = undefined;
    this.emit({ type: "status", convId: id, status: "idle" });
  }

  async start() {
    this.server = http.createServer((req, res) => {
      if (this.down) {
        req.socket.destroy();
        return;
      }
      const u = new URL(req.url!, "http://x");
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        const body = raw ? JSON.parse(raw) : {};
        const route = `${req.method} ${u.pathname}`;
        this.seen.push({ route, vault: u.searchParams.get("vault") });
        if (req.method === "POST") this.posts.push({ path: u.pathname, body });
        switch (route) {
          case "GET /poll": {
            const a = u.searchParams.get("after");
            if (a === "latest") return send(200, { next: this.seq, events: [], boot: this.boot });
            const after = Number(a);
            if (after > this.seq) return send(200, { next: this.seq, events: [], boot: this.boot });
            const deadline = Date.now() + 1500;
            for (;;) {
              const evs = this.ring.filter((e) => e.seq > after);
              if (evs.length || Date.now() > deadline || this.down) {
                return send(200, { next: evs.length ? evs[evs.length - 1]!.seq : after, events: evs.map((e) => e.ev), boot: this.boot });
              }
              await new Promise<void>((r) => {
                const t = setTimeout(r, 100);
                this.waiters.add(() => {
                  clearTimeout(t);
                  r();
                });
              });
            }
          }
          case "GET /conversations":
            return send(200, {
              vault: "v",
              conversations: [...this.convs.values()].map((c) => ({
                id: c.id,
                title: c.title,
                lastActivityAt: c.lastActivityAt,
                source: c.source,
                msgCount: c.messages.length,
              })),
            });
          case "GET /conversation": {
            const c = this.convs.get(u.searchParams.get("id")!);
            if (!c) return send(404, { error: "conversation not found" });
            const base = { id: c.id, title: c.title, source: c.source, status: c.status, runStartedAt: c.runStartedAt ?? null };
            if (this.full && u.searchParams.get("full") === "1") {
              const { messages, ...meta } = c;
              const body = JSON.parse(JSON.stringify({ ...base, full: true, meta, messages }));
              const delay = this.delayNextDetail;
              this.delayNextDetail = 0;
              if (delay) await new Promise((r) => setTimeout(r, delay));
              return send(200, body);
            }
            return send(200, {
              ...base,
              messages: c.messages
                .filter((m) => !m.hidden)
                .map((m) => ({ role: m.role, content: m.content, system: !!m.system, tools: (m.toolCalls ?? []).map((t: Msg) => t.name), timeline: null, direct: false, decision: !!m.decision, askOptions: null })),
            });
          }
          case "GET /status":
            return send(200, { runs: [...this.convs.values()].filter((c) => c.status === "running").map((c) => ({ convId: c.id })) });
          case "POST /message": {
            let id = body.convId as string | undefined;
            if (!id) {
              id = `box${++this.n}`;
              this.convs.set(id, { id, title: String(body.text).slice(0, 40), source: "manual", status: "idle", messages: [], lastActivityAt: Date.now() });
            }
            const c = this.convs.get(id);
            if (!c) return send(404, { error: "no such conversation" });
            // Like the engine: an image alone is recorded as "(image)".
            const shown = String(body.text ?? "").trim() || (body.images?.length ? "(image)" : "");
            // Like the engine: a steer closes the reply so far as its own message first.
            const steered = this.splitSteer && c.status === "running";
            if (steered) {
              c.messages.push({ role: "assistant", content: "Working on it", toolCalls: [{ id: "r1", name: "Read", input: { path: "a.md" }, result: "x" }] });
              this.emit({ type: "message", convId: id, role: "assistant", content: "Working on it", tools: ["Read"] });
            }
            c.messages.push({ role: "user", content: shown });
            c.lastActivityAt = Date.now();
            if (c.status !== "running") {
              c.status = "running";
              c.runStartedAt = Date.now();
              this.emit({ type: "status", convId: id, status: "running" });
            }
            this.emit({ type: "message", convId: id, role: "user", content: shown, tools: [] });
            if (!steered) this.emit({ type: "runtime", convId: id, text: "Working on it", tool: "Read", steps: [], startedAt: c.runStartedAt });
            return send(200, { ok: true, convId: id });
          }
          case "POST /kill": {
            const c = this.convs.get(body.convId);
            if (c && c.status === "running") setTimeout(() => this.finish(c.id, "_(stopped)_"), 50);
            return send(200, { ok: true, result: "Stopped" });
          }
          case "POST /answer": {
            const c = this.convs.get(body.convId);
            if (!c) return send(404, { error: "no such conversation" });
            c.messages.push({ role: "user", content: body.text, decision: true });
            c.state = "running";
            c.status = "running";
            this.emit({ type: "status", convId: c.id, status: "running" });
            return send(200, { ok: true });
          }
          default:
            return send(404, { error: "not found" });
        }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as any).port}`;
  }

  async close() {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

// ---------- the laptop ----------

const vault = makeTempVault("vc-boxchat-");
const fake = installFakeTauri(vault);
const box = new FakeBox();

async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function fetchVia(url: string, init: RequestInit, timeoutMs: number) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    throw String((e as Error)?.message ?? e);
  }
}

fake.setHandler("vault_box_config", () => ({ box: box.url, vault: "v" }));
fake.setHandler("box_get_json", ({ url, timeoutMs }) => fetchVia(url, { method: "GET" }, timeoutMs ?? 20000));
fake.setHandler("box_post_json", ({ url, body }) =>
  fetchVia(url, { method: "POST", body, headers: { "content-type": "application/json" } }, 20000),
);
fake.setHandler("conversation_delete", () => null);

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const chat = await import("../../src/chat-controller.ts");

const S = () => useStore.getState();
const active = () => S().conversations.find((c) => c.id === S().activeConversationId)!;

before(async () => {
  await box.start();
  // An older chat the box already has (its file came through git).
  box.convs.set("old1", {
    id: "old1",
    title: "earlier",
    source: "manual",
    status: "idle",
    lastActivityAt: Date.now() - 60_000,
    messages: [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer", toolCalls: [{ id: "t1", name: "Read", input: { path: "a.md" }, result: "x" }] },
    ],
  });
  fake.conversations.set("old1", { ...box.conv("old1"), status: "idle", createdAt: 1 });
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
});

after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("a new chat is created on the box: sent without an id, re-keyed to the box's", async () => {
  const localId = S().newConversation();
  assert.ok(!box.convs.has(localId));
  await chat.sendMessage("hello box");
  const post = box.posts.at(-1)!;
  assert.equal(post.path, "/message");
  assert.equal(post.body.text, "hello box");
  assert.equal(post.body.convId, undefined, "a conversation the box has never seen is created there");
  assert.equal(typeof post.body.clientMsgId, "string");
  await waitFor("rekey", () => S().activeConversationId === "box1");
  assert.ok(!S().conversations.some((c) => c.id === localId));
  // Live: the run shows as running with the streamed text and tool.
  await waitFor("streaming", () => S().busy && S().streamingText === "Working on it");
  assert.equal(S().liveTools[0]?.name, "Read");
  assert.equal(active().status, "running");
  assert.deepEqual(
    S().messages.map((m) => [m.role, m.content]),
    [["user", "hello box"]],
  );
  // The box finishes: full-fidelity messages, run over.
  box.finish("box1", "Hi Carl", [{ id: "c1", name: "Read", input: { path: "notes.md" }, result: "ok" }]);
  await waitFor("reply", () => !S().busy && S().messages.length === 2);
  assert.equal(S().messages[1]!.content, "Hi Carl");
  assert.deepEqual(S().messages[1]!.toolCalls?.[0]?.input, { path: "notes.md" });
  assert.equal(S().streamingText, "");
  assert.equal(active().status, "idle");
  assert.ok(!S().messages.some((m) => m.boxPending || m.boxPartial));
});

test("a message into a running thread steers it on the box (no local interrupt)", async () => {
  S().selectConversation("box1");
  await chat.sendMessage("first");
  await waitFor("running", () => S().busy);
  await chat.interruptAndSend("and also this");
  const msgs = box.posts.filter((p) => p.path === "/message").slice(-2);
  assert.deepEqual(msgs.map((p) => [p.body.convId, p.body.text]), [["box1", "first"], ["box1", "and also this"]]);
  assert.ok(!S().messages.some((m) => /interrupted/.test(m.content)), "nothing is cut short locally");
  box.finish("box1", "done both");
  await waitFor("idle", () => !S().busy && S().messages.at(-1)?.content === "done both");
});

test("a steer shows after what the turn already showed — at once, and as the box stores it", async () => {
  box.splitSteer = true;
  try {
    S().selectConversation("box1");
    await chat.sendMessage("go through the chapters");
    await waitFor("streaming", () => S().busy && S().streamingText === "Working on it");
    const n = S().messages.length;
    await chat.sendMidTurn("steer", "still working?");
    // At once: the reply so far closed above Carl's message, the live stream empty after it.
    assert.deepEqual(S().messages.slice(n).map((m) => [m.role, m.content]), [["assistant", "Working on it"], ["user", "still working?"]]);
    assert.equal(S().streamingText, "");
    // The box's copy lands: the same order, its full-fidelity message in place of the local one.
    await waitFor("box copy", () => S().messages.slice(n).every((m) => !m.boxPending) && S().messages[n]?.toolCalls?.length === 1);
    assert.deepEqual(S().messages.slice(n).map((m) => [m.role, m.content]), [["assistant", "Working on it"], ["user", "still working?"]]);
    assert.ok(S().busy, "the turn still runs");
    box.emit({ type: "runtime", convId: "box1", text: "Yes — chapter three now.", tool: "", steps: [] });
    await waitFor("rest streams after it", () => S().streamingText === "Yes — chapter three now.");
    box.finish("box1", "Yes — chapter three now.");
    await waitFor("done", () => !S().busy && S().messages.at(-1)?.content === "Yes — chapter three now.");
    assert.deepEqual(S().messages.slice(n).map((m) => m.role), ["assistant", "user", "assistant"]);
  } finally {
    box.splitSteer = false;
  }
});

test("Stop is the box's /kill; the thread reads running until the box ends it", async () => {
  await chat.sendMessage("long job");
  await waitFor("running", () => S().busy);
  chat.stopAgent();
  await waitFor("kill posted", () => box.posts.at(-1)?.path === "/kill");
  assert.deepEqual(box.posts.at(-1)!.body, { convId: "box1" });
  await waitFor("stopped", () => !S().busy && S().messages.at(-1)?.content === "_(stopped)_");
});

test("a reply to a question the agent asked goes to /answer", async () => {
  const c = box.conv("box1");
  c.state = "waiting_user";
  c.messages.push({ role: "assistant", content: "Which file?" });
  box.emit({ type: "message", convId: "box1", role: "assistant", content: "Which file?", tools: [] });
  await waitFor("question shown", () => S().messages.at(-1)?.content === "Which file?" && active().state === "waiting_user");
  await chat.sendMessage("notes.md");
  const p = box.posts.at(-1)!;
  assert.equal(p.path, "/answer");
  assert.deepEqual([p.body.convId, p.body.text], ["box1", "notes.md"]);
  box.finish("box1", "Read notes.md");
  await waitFor("answered", () => !S().busy && S().messages.at(-1)?.content === "Read notes.md");
});

test("the list comes from the box: a conversation started on the phone appears, live", async () => {
  box.convs.set("phone7", {
    id: "phone7",
    title: "from the phone",
    source: "phone",
    status: "running",
    runStartedAt: Date.now(),
    lastActivityAt: Date.now(),
    messages: [{ role: "user", content: "phone asks" }],
  });
  box.emit({ type: "status", convId: "phone7", status: "running" });
  await waitFor("phone conv listed", () => S().conversations.some((c) => c.id === "phone7" && c.status === "running"));
  box.emit({ type: "runtime", convId: "phone7", text: "thinking on the phone's turn", tool: "", steps: [] });
  await waitFor("background runtime", () => S().convRuntime.phone7?.streamingText === "thinking on the phone's turn");
  box.finish("phone7", "phone answered");
  await waitFor("phone conv done", () => {
    const c = S().conversations.find((x) => x.id === "phone7");
    return !!c && c.status === "idle" && c.messages.at(-1)?.content === "phone answered";
  });
  assert.equal(S().conversations.find((x) => x.id === "phone7")!.title, "from the phone");
});

test("a server without full=1: the phone shape merges onto the local full copy", async () => {
  box.full = false;
  try {
    S().selectConversation("old1");
    const c = box.conv("old1");
    c.messages.push({ role: "user", content: "follow-up" }, { role: "assistant", content: "follow-up answer", toolCalls: [{ name: "Grep", input: { q: "x" } }] });
    box.emit({ type: "message", convId: "old1", role: "assistant", content: "follow-up answer", tools: ["Grep"] });
    await waitFor("merged", () => S().messages.at(-1)?.content === "follow-up answer");
    const ms = S().messages;
    assert.equal(ms.length, 4);
    // The local full-fidelity prefix is kept…
    assert.deepEqual(ms[1]!.toolCalls?.[0]?.input, { path: "a.md" });
    assert.ok(!ms[1]!.boxPartial);
    // …and the new tail is marked partial until the git-synced copy lands.
    assert.equal(ms[3]!.boxPartial, true);
    assert.equal(ms[3]!.toolCalls?.[0]?.name, "Grep");
    // The git sync brings the full file: it replaces the partial messages.
    fake.conversations.set("old1", { ...c, status: "idle", createdAt: 1 });
    await S().refreshConversationsFromDisk(vault);
    assert.deepEqual(S().messages[3]!.toolCalls?.[0]?.input, { q: "x" });
    assert.ok(!S().messages.some((m) => m.boxPartial));
  } finally {
    box.full = true;
  }
});

test("a long reply streams whole, with its thinking and the box's context; meta re-reads; images go to the box", async () => {
  S().selectConversation("box1");
  const c = box.conv("box1");
  c.status = "running";
  c.runStartedAt = Date.now();
  box.emit({ type: "status", convId: "box1", status: "running" });
  // 9,000 characters in three pieces (offset + delta): the old 6,000 tail lost the start.
  const full = Array.from({ length: 150 }, (_, i) => `line ${i} of the reply.`).join("\n").padEnd(9000, ".");
  for (const [a, b] of [[0, 2000], [2000, 6500], [6500, 9000]] as const) {
    box.emit({ type: "runtime", convId: "box1", text: full.slice(0, b).slice(-6000), offset: a, delta: full.slice(a, b), len: b, tool: "", reasoning: "weighing the two bounds", context: 182_000, window: 200_000 });
  }
  await waitFor("the whole text", () => S().streamingText === full);
  assert.equal(S().streamingReasoning, "weighing the two bounds");
  assert.equal(S().lastContext, 182_000);
  assert.equal(active().contextWindow, 200_000);
  // The plan and the subagents change on the box: one meta event, the laptop re-reads.
  (c as any).todos = [{ content: "Read", status: "completed" }, { content: "Write", status: "in_progress" }];
  (c as any).subagents = [{ threadId: "sa1", task: "read pp. 40-80", state: "completed", costUsd: 0.09, summary: "six methods", toolCallId: "call_s" }];
  box.emit({ type: "meta", convId: "box1" });
  await waitFor("meta", () => active().todos?.length === 2 && active().subagents?.[0]?.summary === "six methods");
  box.finish("box1", "done long");
  await waitFor("idle", () => !S().busy && S().messages.at(-1)?.content === "done long");

  // An image with text, then an image alone: images[] in /message, nothing refused.
  const png = "data:image/png;base64,iVBORw0KGgo=";
  await bc.boxSend({ text: "what is this?", attachments: [{ imageDataUrl: png, capturedFilePath: ".vault-chat/captures/c1.png" }], convId: "box1" });
  let p = box.posts.at(-1)!;
  assert.equal(p.path, "/message");
  assert.deepEqual(p.body.images, [{ name: "c1.png", mime: "image/png", dataBase64: "iVBORw0KGgo=" }]);
  assert.ok(S().messages.some((m) => m.role === "user" && m.content === "what is this?" && m.attachments?.length === 1));
  box.finish("box1", "a chart");
  await waitFor("answered", () => !S().busy && S().messages.at(-1)?.content === "a chart");
  await bc.boxSend({ text: "", attachments: [{ imageDataUrl: png }], convId: "box1" });
  p = box.posts.at(-1)!;
  assert.equal(p.body.text, "");
  assert.equal(p.body.images.length, 1);
  box.finish("box1", "another chart");
  await waitFor("answered alone", () => !S().busy && S().messages.at(-1)?.content === "another chart");
  assert.ok(!S().messages.some((m) => /can't be sent to the box/.test(m.content)));
});

/** A turn on box1 with a three-step plan, running and streaming on the laptop. */
async function planTurn(text: string) {
  S().selectConversation("box1");
  await chat.sendMessage(text);
  await waitFor("running", () => S().busy && S().streamingText === "Working on it");
  const c = box.conv("box1") as any;
  c.state = "running";
  c.todos = [
    { content: "one", status: "in_progress" },
    { content: "two", status: "pending" },
    { content: "three", status: "pending" },
  ];
  box.emit({ type: "meta", convId: "box1" });
  await waitFor("plan 1/3", () => active().todos?.length === 3 && active().todos?.[0]?.status === "in_progress");
  return c;
}

/** The turn ends on the box with no event this laptop will ever see. */
function finishUnseen(c: any, text: string) {
  c.messages.push({ role: "assistant", content: text });
  c.todos = c.todos.map((t: any) => ({ ...t, status: "completed" }));
  c.state = "done";
  c.verdict = "pass";
  c.status = "idle";
  c.runStartedAt = undefined;
  c.lastActivityAt = Date.now();
}

const converged = (text: string) => () =>
  !S().busy &&
  active().status === "idle" &&
  S().messages.at(-1)?.content === text &&
  active().state === "done" &&
  !!active().todos?.every((t) => t.status === "completed") &&
  S().streamingText === "" &&
  S().liveTools.length === 0 &&
  !S().convRuntime.box1;

test("the box restarts between two polls (no error seen, a new process): the laptop resyncs whole", async () => {
  const c = await planTurn("job across a quick restart");
  // The self-update: SIGTERM, a new process at once. Its ring starts above the
  // old floor, and the turn resumed and finished there — the old process's
  // stream (and its end) never reached this laptop.
  finishUnseen(c, "all three done after the restart");
  box.restart(box.seq + 1000);
  await waitFor("converged", converged("all three done after the restart"), 10000);
});

test("the box restarts while unreachable and its sequence resets: the laptop converges on the final state", async () => {
  const c = await planTurn("job across a long restart");
  box.down = true;
  await waitFor("unreachable", () => S().boxChat?.reachable === false, 15000);
  finishUnseen(c, "finished while you were away");
  box.restart(3);
  box.down = false;
  await waitFor("converged", converged("finished while you were away"), 20000);
  assert.equal(S().boxChat?.reachable, true);
});

test("a slow re-read from before the end lands after the end: the older answer is dropped", async () => {
  const c = await planTurn("job with a slow read");
  // The meta re-read is slow (a box just back up) and carries the running state…
  box.delayNextDetail = 1200;
  c.todos = [{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }, { content: "three", status: "pending" }];
  box.emit({ type: "meta", convId: "box1" });
  await new Promise((r) => setTimeout(r, 200));
  // …and the turn ends before it lands.
  finishUnseen(c, "ended before the slow read");
  box.emit({ type: "message", convId: "box1", role: "assistant", content: "ended before the slow read", tools: [] });
  box.emit({ type: "status", convId: "box1", status: "idle" });
  await waitFor("converged", converged("ended before the slow read"), 5000);
  await new Promise((r) => setTimeout(r, 1500)); // the slow, stale answer has landed by now
  assert.ok(converged("ended before the slow read")(), "the stale running snapshot did not win");
});

test("box unreachable: composer state says why, a send is refused honestly, it recovers", async () => {
  box.down = true;
  await waitFor("unreachable", () => S().boxChat?.reachable === false, 15000);
  assert.equal(bc.BOX_UNREACHABLE, "Box unreachable — agent runs on the box");
  const before = box.posts.length;
  await chat.sendMessage("while offline");
  assert.equal(box.posts.length, before, "nothing posted");
  assert.match(S().messages.at(-1)!.content, /Box unreachable — agent runs on the box\. The message was NOT sent/);
  assert.equal(S().messages.at(-1)!.system, true);
  assert.ok(!S().busy);
  // History stays readable offline.
  assert.ok(S().messages.length > 2);
  box.down = false;
  await waitFor("back online", () => S().boxChat?.reachable === true, 20000);
});

test("offline snapshot: what the box served last is cached for the next start", async () => {
  await new Promise((r) => setTimeout(r, 1700)); // the cache write is debounced
  const cache = bc.readBoxCache(vault);
  assert.ok(cache, "cache written");
  const ids = cache!.conversations.map((c) => c.id);
  for (const id of ["box1", "phone7", "old1"]) assert.ok(ids.includes(id), `${id} cached`);
  assert.ok(cache!.conversations.find((c) => c.id === "box1")!.messages.some((m) => m.content === "Hi Carl"));
});

test("the laptop never wrote a conversation and never called a model", () => {
  const cmds = fake.calls.map((c) => c.cmd);
  assert.ok(!cmds.includes("conversations_write_all"), "no conversation write in box mode");
  assert.deepEqual(fake.unknown.filter((c) => !/^plugin:/.test(c)), [], `unexpected commands: ${fake.unknown}`);
  // No fetch went anywhere but the fake box (the harness guard refuses
  // non-loopback; a model call would also have needed a key, and there is none).
  assert.deepEqual(S().apiKeys, {});
});

test("every request to the box names this vault (sync.json's), so the box runs it in that vault's engine", () => {
  const routes = new Set(box.seen.map((r) => r.route));
  for (const r of ["GET /poll", "GET /conversations", "GET /conversation", "POST /message", "POST /kill", "POST /answer"]) assert.ok(routes.has(r), `saw ${r}`);
  const unscoped = box.seen.filter((r) => r.vault !== "v");
  assert.deepEqual(unscoped, [], "a request without the vault would run in the box's main vault");
});
