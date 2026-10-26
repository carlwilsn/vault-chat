// A fake box for the laptop's tests: the REAL feed (server/convlog/log.ts, on a
// temp dir) behind the box's real routes (/poll, /api/v2/*), and a scripted
// engine that writes what pi would: pi's session file per conversation (in
// pi's format, on disk), a pointer record for each entry, pi's live events for
// the message in flight, and the conversation's fields. Intents are recorded
// and answered like the engine answers them. `restart()` is a new process on
// the same directory (what survives is what is on disk: the feed and pi's
// files); `down` drops every connection.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConvLog } from "../../server/convlog/log.ts";
import { appendEntries, newSessionFile, vcNote } from "../../server/convlog/piSession.ts";
import type { EventBody, LogRecord, PendingInput, PiEntry } from "../../src/convlog/protocol.ts";
import { fold, pendingOf, shown } from "../../src/convlog/reduce.ts";
import { ackShow, feedOpened } from "../../server/show.ts";

export class FakeBox {
  url = "";
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-fakebox-"));
  log = new ConvLog(this.dir, null, path.join(this.dir, "events"));
  intents: any[] = [];
  /** Every request's route and the vault it named (`?vault=`). */
  seen: { route: string; vault: string | null }[] = [];
  down = false;
  /** The vault Show (server/show.ts) counts this feed's clients for (the laptop test's vault). */
  showVault = this.dir;
  /** The box's own copies of vault files (GET /api/v1/vault/file, vault-relative path → bytes); others 404. */
  files = new Map<string, Buffer>();
  /** Answer /poll this many ms late (the tailnet). */
  pollDelay = 0;
  private server!: http.Server;
  private n = 0;
  private clock = Date.now();
  /** What a send does: by default a turn starts (the reply is the test's to script). */
  onSend: (conv: string, b: any) => void = () => {};

  emit(conv: string | null, body: EventBody): LogRecord {
    return this.log.emit(conv, body);
  }

  /** The box restarts: a new process on the same directory (only what is on disk survives). */
  restart(): void {
    this.log = new ConvLog(this.dir, null, path.join(this.dir, "events"));
  }

  records(conv?: string): LogRecord[] {
    const out: LogRecord[] = [];
    let after = 0;
    for (;;) {
      const r = this.log.after(after, 100_000);
      out.push(...r.events);
      if (!r.more) break;
      after = r.next;
    }
    return conv ? out.filter((r) => r.conv === conv) : out;
  }

  picture(conv: string) {
    return fold(this.records(conv), conv);
  }

  // ---------- pi, scripted ----------

  private stamp(): number {
    return (this.clock = Math.max(Date.now(), this.clock + 1));
  }

  private file(conv: string): string {
    const f = path.join(this.dir, "pi", `${conv}.jsonl`);
    if (!fs.existsSync(f)) newSessionFile(f, this.dir);
    return f;
  }

  /** pi writes an entry; the feed points to it. */
  private entry(conv: string, e: Omit<PiEntry, "id" | "parentId" | "timestamp">, extra: { clientId?: string; shown?: string; via?: string } = {}): PiEntry {
    const file = this.file(conv);
    const [entry] = appendEntries(file, [e]);
    this.emit(conv, { type: "entry", file, entry: entry!, ...extra });
    return entry!;
  }

  private live(conv: string, ev: any): void {
    this.emit(conv, { type: "live", ev });
  }

  private meta(conv: string, patch: Record<string, unknown>): void {
    this.emit(conv, { type: "meta", patch });
  }

  create(conv: string, title = "New chat", at?: number): void {
    const t = at ?? Date.now();
    this.meta(conv, { title, source: "manual", createdAt: t, lastActivityAt: t });
  }

  turnOf(conv: string): string {
    return this.picture(conv).meta.running!.turn;
  }

  startTurn(conv: string): string {
    const turn = `t${++this.n}`;
    this.meta(conv, { running: { turn, kind: "user", startedAt: Date.now() } });
    return turn;
  }

  /** Carl's message as pi's user entry, under his client's id. */
  user(conv: string, clientId: string, text: string, via = "chat"): void {
    this.entry(conv, { type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: this.stamp() } }, { clientId, shown: text, via });
  }

  /** A content block streamed in `chunks` deltas (pi's live events), then pi's entry for it. */
  stream(conv: string, kind: "assistant" | "thinking", text: string, chunks = 3): string {
    const b = this.open(conv, kind);
    const size = Math.max(1, Math.ceil(text.length / chunks));
    for (let i = 0; i < text.length; i += size) b.delta(text.slice(i, i + size));
    b.end();
    return b.id;
  }

  /** Start streaming a block, and hand back a function that adds a delta (and one that ends it). */
  open(conv: string, kind: "assistant" | "thinking"): { id: string; delta: (s: string) => void; end: () => void } {
    const ts = this.stamp();
    const t = kind === "assistant" ? "text" : "thinking";
    this.live(conv, { type: "message_start", message: { role: "assistant", timestamp: ts } });
    this.live(conv, { type: "message_update", assistantMessageEvent: { type: `${t}_start`, contentIndex: 0 } });
    let text = "";
    return {
      id: `${ts}:0`,
      delta: (s) => {
        text += s;
        this.live(conv, { type: "message_update", assistantMessageEvent: { type: `${t}_delta`, contentIndex: 0, delta: s } });
      },
      end: () => {
        this.live(conv, { type: "message_update", assistantMessageEvent: { type: `${t}_end`, contentIndex: 0, content: text } });
        this.entry(conv, { type: "message", message: { role: "assistant", content: [kind === "assistant" ? { type: "text", text } : { type: "thinking", thinking: text }], stopReason: "stop", timestamp: ts } });
      },
    };
  }

  /** The model calls a tool: its arguments stream, pi writes the call, the tool runs. */
  tool(conv: string, id: string, name: string, args: unknown): void {
    const ts = this.stamp();
    this.live(conv, { type: "message_start", message: { role: "assistant", timestamp: ts } });
    this.live(conv, { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id, toolName: name } });
    this.live(conv, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args) } });
    this.live(conv, { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id, name, arguments: args } } });
    this.entry(conv, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: ts } });
    this.live(conv, { type: "tool_execution_start", toolCallId: id, toolName: name, args });
  }

  toolDone(conv: string, id: string, result: string, clientId?: string): void {
    const call = shown(this.picture(conv)).find((x) => x.id === id);
    this.live(conv, { type: "tool_execution_end", toolCallId: id, toolName: call?.name, isError: false, result: { content: [{ type: "text", text: result }] } });
    this.entry(conv, { type: "message", message: { role: "toolResult", toolCallId: id, toolName: call?.name ?? "tool", content: [{ type: "text", text: result }], isError: false, timestamp: this.stamp() } }, clientId ? { clientId } : {});
  }

  private setPending(conv: string, add?: PendingInput, remove?: string): void {
    const cur = pendingOf(this.picture(conv)).filter((x) => x.id !== remove);
    const next = add ? [...cur, add] : cur;
    this.meta(conv, { pending: next.length ? next : null });
  }

  /** pi delivered Carl's steer / queued message: his message where pi put it. */
  deliver(conv: string, id: string): void {
    const p = pendingOf(this.picture(conv)).find((x) => x.id === id)!;
    this.setPending(conv, undefined, id);
    this.user(conv, id, p.text, p.kind);
  }

  /** AskUser: pi's call, running; the question waits for Carl. */
  ask(conv: string, question: string, options: string[]): string {
    const id = `${this.turnOf(conv)}:ask:1`;
    this.tool(conv, id, "AskUser", { question, options });
    this.meta(conv, { asking: { question, options, toolCallId: id, at: Date.now() } });
    return id;
  }

  endTurn(conv: string, _status: "completed" | "stopped" | "cut" = "completed"): void {
    this.meta(conv, { running: null, pending: null });
  }

  private note(conv: string, clientId: string, data: { kind: "line" | "notice" | "divider"; [k: string]: unknown }): void {
    this.entry(conv, vcNote({ ...data, clientId }), { clientId });
  }

  // ---------- the routes ----------

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (this.down) {
        req.socket.destroy();
        return;
      }
      const u = new URL(req.url!, "http://x");
      const send = (code: number, body: unknown) => {
        if (this.down) return void req.socket.destroy();
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        const route = `${req.method} ${u.pathname}`;
        this.seen.push({ route, vault: u.searchParams.get("vault") });
        if (route === "GET /poll") {
          // Who follows the feed, as the box's /poll records it (server/show.ts: Show sends only to a live app).
          const leave = feedOpened(this.showVault, u.searchParams.get("client"));
          res.on("close", leave);
          if (this.pollDelay) await new Promise((r) => setTimeout(r, this.pollDelay));
          const a = u.searchParams.get("after") ?? "latest";
          const epoch = u.searchParams.get("epoch");
          if (a === "latest") return send(200, { next: this.log.latest(), events: [], epoch: this.log.epoch });
          if (epoch && epoch !== this.log.epoch) return send(200, { next: this.log.latest(), events: [], epoch: this.log.epoch, reset: true });
          const after = Number(a);
          const deadline = Date.now() + 1500;
          for (;;) {
            const got = this.log.after(after);
            if (got.reset || got.events.length || Date.now() > deadline || this.down) return send(200, { ...got, epoch: this.log.epoch });
            await this.log.wait(100);
          }
        }
        if (route === "GET /api/v2/conversations") return send(200, { rows: this.log.rows(), seq: this.log.latest(), epoch: this.log.epoch });
        const m = /^\/api\/v2\/conversations\/([^/]+)\/checkpoint$/.exec(u.pathname);
        if (m && req.method === "GET") {
          const p = this.log.picture(decodeURIComponent(m[1]!));
          if (!p) return send(404, { error: "conversation not found" });
          return send(200, { seq: p.seq, picture: JSON.parse(JSON.stringify(p)), next: this.log.latest(), epoch: this.log.epoch });
        }
        if (route === "POST /api/v2/intent") {
          const b = raw ? JSON.parse(raw) : {};
          this.intents.push(b);
          return send(200, this.intent(b));
        }
        if (route === "GET /api/v1/vault/file") {
          const f = this.files.get(u.searchParams.get("path") ?? "");
          return f ? send(200, { path: u.searchParams.get("path"), size: f.length, base64: f.toString("base64") }) : send(404, { error: "no" });
        }
        const ack = /^\/api\/v1\/show\/([^/]+)\/ack$/.exec(u.pathname);
        if (ack && req.method === "POST") return send(200, { ok: true, waiting: ackShow(decodeURIComponent(ack[1]!), raw ? JSON.parse(raw) : {}) });
        return send(404, { error: "not found" });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as any).port}`;
  }

  /** The engine's answers to intents (server/engine/engine.ts intent()). */
  private intent(b: any): Record<string, unknown> {
    const conv = String(b.convId ?? "") || `box${++this.n}`;
    const p = this.log.picture(conv);
    const exists = !!p?.exists;
    switch (b.type) {
      case "send": {
        if (exists && shown(p!).some((x) => x.id === b.clientId)) return { ok: true, convId: conv, duplicate: true };
        if (!exists) this.create(conv);
        this.startTurn(conv);
        this.user(conv, b.clientId, String(b.text ?? "") || "(image)");
        this.onSend(conv, b);
        return { ok: true, convId: conv };
      }
      case "steer":
      case "queue":
        if (!p?.meta.running) return { ok: false, error: "nothing running" };
        this.setPending(conv, { id: b.clientId, kind: b.type, text: String(b.text ?? ""), at: Date.now() });
        return { ok: true, convId: conv, ...(b.type === "queue" ? { queued: true, qid: b.clientId } : { steered: true }) };
      case "unqueue":
        if (!p || !pendingOf(p).some((x) => x.id === b.id)) return { ok: false, error: "already delivered" };
        this.setPending(conv, undefined, b.id);
        return { ok: true };
      case "stop":
        if (p?.meta.running) {
          const turn = p.meta.running.turn;
          this.endTurn(conv, "stopped");
          this.note(conv, `${turn}:stopped`, { kind: "notice", text: "Stopped." });
        }
        return { ok: true };
      case "answer": {
        const ask = p?.meta.asking;
        if (ask?.toolCallId) this.toolDone(conv, ask.toolCallId, `Carl answered: ${String(b.text ?? "")}`, b.clientId);
        else this.user(conv, b.clientId, String(b.text ?? ""), "answer");
        if (ask) this.meta(conv, { asking: null });
        return { ok: true, convId: conv, answered: true };
      }
      case "lines":
        if (!exists) this.create(conv);
        (b.lines ?? []).forEach((l: any, i: number) => {
          if (!l.hidden) this.note(conv, `${b.clientId}:${i}`, { kind: "line", role: l.role === "assistant" ? "assistant" : "user", text: l.text });
        });
        return { ok: true, convId: conv };
      case "delete":
        this.meta(conv, { deleted: true });
        return { ok: true };
      case "deleteProject": {
        // Engine.deleteProject: the thread gone (every surface on it lands on Main), the clients told.
        const id = `project-${String(b.slug ?? "")}`;
        if (!b.slug || b.slug === "main" || !this.log.picture(id)?.exists) return { ok: false, error: `no project ${b.slug}` };
        this.meta(id, { deleted: true });
        this.emit(null, { type: "signal", signal: { type: "project", slug: b.slug, deleted: true, convId: id, to: "main" } });
        return { ok: true, slug: b.slug, convId: id, to: "main", movedTo: `agent-projects/.deleted/${b.slug}-20261025-120000` };
      }
      case "restoreProject": {
        // Engine.restoreProject: the thread back as it was (its transcript), the clients told.
        const id = `project-${String(b.slug ?? "")}`;
        if (!this.log.picture(id)?.meta.deleted) return { ok: false, error: `nothing deleted under "${b.slug}"` };
        this.meta(id, { deleted: null, deletedProject: null });
        this.emit(null, { type: "signal", signal: { type: "project", slug: b.slug, restored: true, convId: id } });
        return { ok: true, slug: b.slug, convId: id };
      }
      case "renameProject": {
        const id = `project-${String(b.slug ?? "")}`;
        const name = String(b.name ?? "").trim();
        if (!name) return { ok: false, error: "a project needs a name" };
        this.meta(id, { title: name });
        this.emit(null, { type: "signal", signal: { type: "project", slug: b.slug, renamed: name } });
        return { ok: true, slug: b.slug, name };
      }
      default:
        return { error: "unknown intent" };
    }
  }

  async close(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
