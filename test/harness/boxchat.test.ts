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
  posts: { path: string; body: any }[] = [];
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
        if (req.method === "POST") this.posts.push({ path: u.pathname, body });
        switch (route) {
          case "GET /poll": {
            const a = u.searchParams.get("after");
            if (a === "latest") return send(200, { next: this.seq, events: [] });
            const after = Number(a);
            const deadline = Date.now() + 1500;
            for (;;) {
              const evs = this.ring.filter((e) => e.seq > after);
              if (evs.length || Date.now() > deadline || this.down) {
                return send(200, { next: evs.length ? evs[evs.length - 1]!.seq : after, events: evs.map((e) => e.ev) });
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
              return send(200, { ...base, full: true, meta, messages });
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
            c.messages.push({ role: "user", content: body.text });
            c.lastActivityAt = Date.now();
            if (c.status !== "running") {
              c.status = "running";
              c.runStartedAt = Date.now();
              this.emit({ type: "status", convId: id, status: "running" });
            }
            this.emit({ type: "message", convId: id, role: "user", content: body.text, tools: [] });
            this.emit({ type: "runtime", convId: id, text: "Working on it", tool: "Read", steps: [], startedAt: c.runStartedAt });
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
