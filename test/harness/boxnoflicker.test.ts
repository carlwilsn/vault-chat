// Box mode: a reply, once shown, never disappears (Carl: "chat replies
// sometimes disappear and then pop back"). Every store update is recorded as
// the screen it makes (the messages shown and the live reply), and each check
// asserts that nothing on one screen is missing from the next — through the
// ways the box's sources disagree:
//  - the box's /conversation reads its FILE: its `status` says "idle" through
//    most of a run, and the file can lag the live events (the reply's `message`
//    event lands before the file has it);
//  - a snapshot answered slowly or from before the newest reply;
//  - the box's window (its last 200 messages) against the full history here;
//  - the git sync bringing an older copy of the file to this disk;
//  - the stream breaking (a box restart) in the middle of a turn.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

type Msg = { role: "user" | "assistant"; content: string; mid: string; hidden?: boolean; toolCalls?: any[] };
type Conv = { id: string; title: string; source: string; live: Msg[]; file: Msg[]; running: boolean; lastActivityAt: number };

let midN = 0;
const mid = () => `m${++midN}`;

/** A box like the real one: events from its live state, details from its file. */
class LaggingBox {
  url = "";
  boot = "boot-a";
  seq = 10;
  ring: { seq: number; ev: any }[] = [];
  convs = new Map<string, Conv>();
  /** What the file's `status` says (the real box's file: "idle" through a run). */
  fileStatus: "idle" | "live" = "idle";
  /** The next /conversation answers this older copy instead (then the file again). */
  staleOnce: Msg[] | null = null;
  /** How long after a sent turn's event the file has it. */
  userFileLagMs = 300;
  private waiters = new Set<() => void>();
  private server!: http.Server;

  emit(ev: any) {
    this.ring.push({ seq: ++this.seq, ev });
    for (const w of [...this.waiters]) w();
  }
  restart() {
    this.boot = `boot-${Math.random().toString(36).slice(2, 7)}`;
    this.ring = [];
    this.seq += 1000;
    for (const w of [...this.waiters]) w();
  }
  add(id: string, msgs: Msg[]) {
    this.convs.set(id, { id, title: id, source: "manual", live: [...msgs], file: [...msgs], running: false, lastActivityAt: Date.now() - 1000 });
  }
  c(id: string) {
    return this.convs.get(id)!;
  }
  startTurn(id: string, text: string) {
    const c = this.c(id);
    const m: Msg = { role: "user", content: text, mid: mid() };
    c.live.push(m);
    c.file.push(m);
    c.running = true;
    this.emit({ type: "status", convId: id, status: "running" });
    this.emit({ type: "message", convId: id, role: "user", content: text, mid: m.mid, tools: [] });
  }
  stream(id: string, text: string) {
    this.emit({ type: "runtime", convId: id, text, offset: 0, delta: text, len: text.length, tool: "", steps: [] });
  }
  /** The reply is stored: the event goes out at once, the file has it `fileLagMs` later. */
  finish(id: string, text: string, fileLagMs = 0) {
    const c = this.c(id);
    const m: Msg = { role: "assistant", content: text, mid: mid() };
    c.live.push(m);
    c.lastActivityAt = Date.now();
    const write = () => c.file.push(m);
    if (fileLagMs) setTimeout(write, fileLagMs);
    else write();
    this.emit({ type: "message", convId: id, role: "assistant", content: text, mid: m.mid, tools: [] });
    c.running = false;
    this.emit({ type: "status", convId: id, status: "idle" });
    return m;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const u = new URL(req.url!, "http://x");
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", async () => {
        switch (`${req.method} ${u.pathname}`) {
          case "GET /poll": {
            const a = u.searchParams.get("after");
            if (a === "latest") return send(200, { next: this.seq, events: [], boot: this.boot });
            const after = Number(a);
            const deadline = Date.now() + 1500;
            for (;;) {
              const evs = this.ring.filter((e) => e.seq > after);
              if (evs.length || Date.now() > deadline) return send(200, { next: evs.length ? evs.at(-1)!.seq : Math.min(after, this.seq), events: evs.map((e) => e.ev), boot: this.boot });
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
            return send(200, { conversations: [...this.convs.values()].map((c) => ({ id: c.id, title: c.title, source: c.source, lastActivityAt: c.lastActivityAt, msgCount: c.file.length })) });
          case "POST /message": {
            const body = JSON.parse(raw || "{}");
            let id = body.convId as string | undefined;
            if (!id) {
              id = `boxnew${this.convs.size}`;
              this.add(id, []);
            }
            const c = this.convs.get(id);
            if (!c) return send(404, { error: "no such conversation" });
            const m: Msg = { role: "user", content: String(body.text), mid: mid() };
            c.live.push(m);
            // The file has Carl's turn a beat after its event (a slow write).
            setTimeout(() => c.file.push(m), this.userFileLagMs);
            c.running = true;
            this.emit({ type: "status", convId: id, status: "running" });
            this.emit({ type: "message", convId: id, role: "user", content: m.content, mid: m.mid, tools: [] });
            return send(200, { ok: true, convId: id });
          }
          case "GET /status":
            return send(200, { runs: [...this.convs.values()].filter((c) => c.running).map((c) => ({ convId: c.id })) });
          case "GET /conversation": {
            const c = this.convs.get(u.searchParams.get("id")!);
            if (!c) return send(404, { error: "not found" });
            const n = Math.min(Number(u.searchParams.get("n")) || 60, 200);
            const msgs = this.staleOnce ?? c.file;
            this.staleOnce = null;
            const status = this.fileStatus === "live" && c.running ? "running" : "idle";
            return send(200, { id: c.id, title: c.title, source: c.source, status, full: true, meta: { title: c.title, lastActivityAt: c.lastActivityAt }, messages: JSON.parse(JSON.stringify(msgs.slice(-n))) });
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

const vault = makeTempVault("vc-noflicker-");
const fake = installFakeTauri(vault);
const box = new LaggingBox();
fake.setHandler("vault_box_config", () => ({ box: box.url, vault: "v" }));
const fetchVia = async (url: string, init: RequestInit, timeoutMs: number) => {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    throw String((e as Error)?.message ?? e);
  }
};
fake.setHandler("box_get_json", ({ url, timeoutMs }) => fetchVia(url, { method: "GET" }, timeoutMs ?? 20000));
fake.setHandler("box_post_json", ({ url, body }) => fetchVia(url, { method: "POST", body, headers: { "content-type": "application/json" } }, 20000));
fake.setHandler("conversation_delete", () => null);

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const chat = await import("../../src/chat-controller.ts");
const S = () => useStore.getState();

async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- the screen, every update ----------

type Screen = { blocks: string[]; busy: boolean };
const norm = (t: string) => t.replace(/^…/, "").trim();
function screen(): Screen {
  const s = S();
  const blocks = s.messages.filter((m) => !m.hidden).map((m) => norm(m.content ?? "")).filter(Boolean);
  const live = norm(s.streamingText);
  if (live) blocks.push(live);
  return { blocks, busy: s.busy };
}
let frames: Screen[] = [];
let recording: (() => void) | null = null;
function record(): void {
  frames = [screen()];
  recording = useStore.subscribe(() => frames.push(screen()));
}
function stop(): Screen[] {
  recording?.();
  recording = null;
  return frames;
}
/** Every text on one screen is on the next (a growing reply, or the same text as a message). */
function vanished(fs: Screen[]): string | null {
  for (let i = 1; i < fs.length; i++) {
    for (const b of fs[i - 1]!.blocks) {
      const probe = b.slice(-200);
      if (!fs[i]!.blocks.some((x) => x.includes(probe))) return `frame ${i}: "${b.slice(0, 60)}" disappeared (${fs[i - 1]!.blocks.length} → ${fs[i]!.blocks.length} blocks)`;
    }
  }
  return null;
}
function assertNothingVanished(label: string): void {
  const fs = stop();
  const v = vanished(fs);
  assert.equal(v, null, `${label}: ${v}`);
}
/** How often the running indicator went off and on again within a turn. */
function busyBlinks(fs: Screen[]): number {
  let n = 0;
  for (let i = 2; i < fs.length; i++) if (fs[i - 2]!.busy && !fs[i - 1]!.busy && fs[i]!.busy) n++;
  return n;
}

// ---------- setup: a long conversation (past the box's 200-message window) ----------

const LONG = "long1";
const SHORT = "short1";
const history: Msg[] = [];
for (let i = 0; i < 115; i++) {
  history.push({ role: "user", content: `question ${i}`, mid: mid() });
  history.push({ role: "assistant", content: `answer ${i}`, mid: mid() });
}

before(async () => {
  await box.start();
  box.add(LONG, history);
  box.add(SHORT, [{ role: "user", content: "hi", mid: mid() }, { role: "assistant", content: "hello", mid: mid() }]);
  box.add("short2", [{ role: "user", content: "hey", mid: mid() }, { role: "assistant", content: "hey there", mid: mid() }]);
  // Their files came through git: this disk has them as the box wrote them.
  for (const c of box.convs.values()) fake.conversations.set(c.id, { id: c.id, title: c.title, source: c.source, status: "idle", createdAt: 1, lastActivityAt: c.lastActivityAt, messages: c.file });
  localStorage.setItem(`vault_chat_active_conv:${vault}`, LONG);
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  if (S().activeConversationId !== LONG) S().selectConversation(LONG);
  await waitFor("long thread shown", () => S().messages.length >= 230);
});

after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("the box's window never cuts the history above it: all 230 messages stay shown", async () => {
  record();
  bc._boxChatSession()!.scheduleDetail(LONG, 0);
  await pause(600);
  assertNothingVanished("window");
  assert.equal(S().messages.filter((m) => !m.hidden).length, 230);
  assert.equal(S().messages[0]!.content, "question 0");
});

test("turn end with the final message not in the box's file yet: the streamed reply hands over in the same update", async () => {
  S().selectConversation(SHORT);
  await pause(400);
  record();
  box.startTurn(SHORT, "what is six times seven?");
  await waitFor("running", () => S().busy);
  box.stream(SHORT, "Six times seven is");
  await waitFor("streaming", () => S().streamingText === "Six times seven is");
  box.stream(SHORT, "Six times seven is 42.");
  await waitFor("streamed", () => S().streamingText === "Six times seven is 42.");
  // The reply is stored: its event now, the file 700 ms later (a slow write).
  box.finish(SHORT, "Six times seven is 42.", 700);
  await waitFor("over", () => !S().busy && S().streamingText === "");
  await pause(1500);
  assertNothingVanished("delayed final");
  assert.equal(S().messages.at(-1)!.content, "Six times seven is 42.");
  assert.ok(!S().messages.at(-1)!.boxPending, "the box's copy took the reply's place");
  assert.equal(S().messages.filter((m) => m.content === "Six times seven is 42.").length, 1, "shown once");
});

test("a re-read mid-turn (the file's status says idle) never blanks the live reply or the running state", async () => {
  record();
  box.startTurn(SHORT, "write the summary");
  await waitFor("running", () => S().busy);
  box.stream(SHORT, "Here is the summary so far, part one");
  await waitFor("streaming", () => S().streamingText.startsWith("Here is the summary"));
  // A meta change (to-dos, cost) re-reads the conversation: its file says idle.
  box.emit({ type: "meta", convId: SHORT });
  await pause(500);
  box.stream(SHORT, "Here is the summary so far, part one, and part two.");
  await pause(300);
  box.finish(SHORT, "Here is the summary so far, part one, and part two.");
  await waitFor("over", () => !S().busy && S().messages.at(-1)?.content === "Here is the summary so far, part one, and part two.");
  await pause(400);
  const fs = frames.slice();
  assertNothingVanished("re-read mid-turn");
  assert.equal(busyBlinks(fs), 0, "the running state never went off and on again");
});

test("a stale snapshot after the final (an older copy of the file) never takes the reply away", async () => {
  const older = box.c(SHORT).file.slice();
  box.startTurn(SHORT, "and one more");
  await waitFor("running", () => S().busy);
  box.stream(SHORT, "One more answer.");
  await waitFor("streaming", () => S().streamingText === "One more answer.");
  box.finish(SHORT, "One more answer.");
  await waitFor("final shown", () => !S().busy && S().messages.at(-1)?.content === "One more answer." && !S().messages.at(-1)?.boxPending);
  record();
  // The next read answers a copy from before this turn.
  box.staleOnce = older;
  bc._boxChatSession()!.scheduleDetail(SHORT, 0);
  await pause(1500);
  assertNothingVanished("stale snapshot");
  assert.equal(S().messages.at(-1)!.content, "One more answer.");
  assert.equal(S().messages.filter((m) => !m.hidden).length, box.c(SHORT).file.length);
});

test("the git sync brings an older copy of the file to this disk: during and after a turn, nothing on screen goes", async () => {
  // This disk's copy is from before the last two turns (the sync lags the box).
  const diskCopy = { id: LONG, title: LONG, source: "manual", status: "idle", createdAt: 1, lastActivityAt: Date.now() + 5, messages: history };
  fake.conversations.set(LONG, diskCopy);
  S().selectConversation(LONG);
  await pause(400);
  record();
  box.startTurn(LONG, "a question while the sync runs");
  await waitFor("running", () => S().busy);
  box.stream(LONG, "Answering while the merge lands");
  await waitFor("streaming", () => S().streamingText === "Answering while the merge lands");
  await S().refreshConversationsFromDisk(vault); // a merge during the turn
  box.finish(LONG, "Answering while the merge lands.");
  await waitFor("over", () => !S().busy && S().messages.at(-1)?.content === "Answering while the merge lands.");
  await S().refreshConversationsFromDisk(vault); // and right after it
  await pause(300);
  await S().refreshConversationsFromDisk(vault);
  await pause(300);
  assertNothingVanished("disk reload");
  assert.equal(S().messages.at(-1)!.content, "Answering while the merge lands.");
  assert.equal(S().messages.filter((m) => !m.hidden).length, history.length + 2);
  // The list's entry is the same newer copy.
  const entry = S().conversations.find((c) => c.id === LONG)!;
  assert.equal(entry.messages.at(-1)!.content, "Answering while the merge lands.");
});

test("a resync mid-turn (the box restarts): the live reply stays until the box's state replaces it in one update", async () => {
  // The file says running here (as the main vault's can): only the break is in play.
  box.fileStatus = "live";
  S().selectConversation("short2");
  await pause(400);
  record();
  box.startTurn("short2", "count to three");
  await waitFor("running", () => S().busy && S().activeConversationId === "short2");
  box.stream("short2", "One, two");
  await waitFor("streaming", () => S().streamingText === "One, two");
  // Restart: the new process's ring starts elsewhere; the turn goes on there.
  box.restart();
  await pause(2500); // the resync: list, /status, the thread re-read
  box.stream("short2", "One, two, three.");
  await waitFor("streams on", () => S().streamingText === "One, two, three.");
  box.finish("short2", "One, two, three.");
  await waitFor("converged", () => !S().busy && S().messages.at(-1)?.content === "One, two, three." && S().streamingText === "", 10000);
  await pause(300);
  assertNothingVanished("resync");
  assert.equal(S().messages.filter((x) => x.content === "One, two, three.").length, 1);
  box.fileStatus = "idle";
  S().selectConversation(LONG);
});

// ---------- Carl's own message ----------

const mine = (text: string) => S().messages.some((m) => m.role === "user" && m.content === text);

test("Carl's message in a long thread (past the window): through a turn with idle-status re-reads and the sync bringing the older file, it never goes", async () => {
  S().selectConversation(LONG);
  await pause(400);
  // This disk's copy is the history only (the sync lags the box by a few turns).
  fake.conversations.set(LONG, { id: LONG, title: LONG, source: "manual", status: "idle", createdAt: 1, lastActivityAt: Date.now() + 5, messages: history });
  record();
  await chat.sendMessage("why does the cache halve the memory?");
  assert.ok(mine("why does the cache halve the memory?"), "shown at once");
  await waitFor("running", () => S().busy);
  box.stream(LONG, "Because each entry");
  await waitFor("streaming", () => S().streamingText === "Because each entry");
  // Mid-turn: the agent edits files (the sync merges them, re-reading the
  // conversation files), and a meta change re-reads the thread (file: idle).
  for (let i = 0; i < 3; i++) {
    box.emit({ type: "meta", convId: LONG });
    await pause(250);
    await S().refreshConversationsFromDisk(vault);
    box.stream(LONG, "Because each entry is stored in 4 bits instead of 8.".slice(0, 30 + 7 * i));
    await pause(150);
  }
  box.finish(LONG, "Because each entry is stored in 4 bits instead of 8.");
  await waitFor("over", () => !S().busy && S().messages.at(-1)?.content === "Because each entry is stored in 4 bits instead of 8.");
  await S().refreshConversationsFromDisk(vault);
  await pause(500);
  assertNothingVanished("Carl's message, long thread");
  assert.ok(mine("why does the cache halve the memory?"));
  assert.equal(S().messages.filter((m) => m.content === "why does the cache halve the memory?").length, 1, "shown once");
});

test("Carl's message the box already has: a snapshot from before it was stored never takes it away", async () => {
  S().selectConversation(SHORT);
  await pause(400);
  const before = box.c(SHORT).file.slice();
  record();
  await chat.sendMessage("and in French?");
  await waitFor("running", () => S().busy);
  // The box's copy has landed (settled: no longer optimistic)…
  await waitFor("settled", () => S().messages.some((m) => m.content === "and in French?" && !m.boxPending), 4000);
  // …and then a read answers a copy from before it.
  box.staleOnce = before;
  bc._boxChatSession()!.scheduleDetail(SHORT, 0);
  await pause(600);
  box.stream(SHORT, "En français :");
  await pause(200);
  box.finish(SHORT, "En français : bonjour.");
  await waitFor("over", () => !S().busy && S().messages.at(-1)?.content === "En français : bonjour.");
  await pause(300);
  assertNothingVanished("Carl's message, stale snapshot");
  assert.equal(S().messages.filter((m) => m.content === "and in French?").length, 1);
});

test("a new chat: Carl's first message stays through the move to the box's id and the turn", async () => {
  S().newConversation();
  await pause(100);
  record();
  await chat.sendMessage("start something new");
  assert.ok(mine("start something new"));
  await waitFor("rekeyed", () => (S().activeConversationId ?? "").startsWith("boxnew"));
  const id = S().activeConversationId!;
  box.stream(id, "Starting");
  await waitFor("streaming", () => S().streamingText === "Starting");
  box.emit({ type: "meta", convId: id });
  await pause(400);
  box.finish(id, "Starting now.");
  await waitFor("over", () => !S().busy && S().messages.at(-1)?.content === "Starting now.");
  await pause(300);
  assertNothingVanished("new chat");
  assert.deepEqual(S().messages.map((m) => [m.role, m.content]), [["user", "start something new"], ["assistant", "Starting now."]]);
});
