// A fake box for the laptop's tests: the REAL event log (server/convlog/log.ts,
// on a temp dir) behind the box's real routes (/poll, /api/v2/*), and a
// scripted engine that writes what pi would make of a turn — the same records
// the box writes (server/engine/piMap.ts shapes). Intents are recorded and
// answered like the engine answers them. `restart()` is a new process on the
// same log directory (what survives is what is on disk); `down` drops every
// connection.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConvLog } from "../../server/convlog/log.ts";
import type { EventBody, Item, LogRecord } from "../../src/convlog/protocol.ts";
import { fold } from "../../src/convlog/reduce.ts";

export class FakeBox {
  url = "";
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-fakebox-"));
  log = new ConvLog(this.dir, null, path.join(this.dir, "events"));
  intents: any[] = [];
  /** Every request's route and the vault it named (`?vault=`). */
  seen: { route: string; vault: string | null }[] = [];
  down = false;
  /** Answer /poll this many ms late (the tailnet). */
  pollDelay = 0;
  private server!: http.Server;
  private turns = new Map<string, { turn: string; msg: number }>();
  private n = 0;
  /** What a send does: by default a turn starts (the reply is the test's to script). */
  onSend: (conv: string, b: any) => void = () => {};

  emit(conv: string | null, body: EventBody): LogRecord {
    return this.log.emit(conv, body);
  }

  /** The box restarts: a new process on the same log (only what is on disk survives). */
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

  // ---------- the scripted engine ----------

  create(conv: string, title = "New chat", at?: number): void {
    this.emit(conv, { type: "conv.created", meta: { title, source: "manual", ...(at ? { createdAt: at, lastActivityAt: at } : {}) } });
  }

  turnOf(conv: string): string {
    return this.turns.get(conv)!.turn;
  }

  startTurn(conv: string): string {
    const turn = `t${++this.n}`;
    this.turns.set(conv, { turn, msg: 0 });
    this.emit(conv, { type: "turn.started", turn, kind: "user" });
    return turn;
  }

  private item(conv: string, item: Omit<Item, "at" | "turn">): void {
    const turn = this.turns.get(conv)?.turn;
    this.emit(conv, { type: "item.started", item: { ...item, ...(turn ? { turn } : {}), at: 0 } as Item });
  }

  /** A content block streamed in `chunks` deltas, then completed with pi's final text. */
  stream(conv: string, kind: "assistant" | "thinking", text: string, chunks = 3): string {
    const t = this.turns.get(conv)!;
    t.msg++;
    const id = `${t.turn}:${t.msg}:0`;
    this.item(conv, { id, kind, status: "streaming", text: "" });
    const size = Math.max(1, Math.ceil(text.length / chunks));
    for (let i = 0; i < text.length; i += size) this.emit(conv, { type: "item.delta", id, field: "text", delta: text.slice(i, i + size) });
    this.emit(conv, { type: "item.completed", id, patch: { text } });
    return id;
  }

  /** Start streaming a block, and hand back a function that adds a delta (and one that ends it). */
  open(conv: string, kind: "assistant" | "thinking"): { id: string; delta: (s: string) => void; end: () => void } {
    const t = this.turns.get(conv)!;
    t.msg++;
    const id = `${t.turn}:${t.msg}:0`;
    this.item(conv, { id, kind, status: "streaming", text: "" });
    let text = "";
    return {
      id,
      delta: (s) => {
        text += s;
        this.emit(conv, { type: "item.delta", id, field: "text", delta: s });
      },
      end: () => this.emit(conv, { type: "item.completed", id, patch: { text } }),
    };
  }

  tool(conv: string, id: string, name: string, args: unknown): void {
    this.item(conv, { id, kind: "tool", status: "streaming", name, argsText: "" });
    this.emit(conv, { type: "item.delta", id, field: "argsText", delta: JSON.stringify(args) });
    this.emit(conv, { type: "item.updated", id, patch: { status: "running", args } });
  }

  toolDone(conv: string, id: string, result: string): void {
    this.emit(conv, { type: "item.completed", id, patch: { result } });
  }

  /** pi delivered Carl's steer / queued message: his item where pi put it. */
  deliver(conv: string, id: string): void {
    const p = this.picture(conv).pending.find((x) => x.id === id)!;
    this.emit(conv, { type: "pending.removed", id, reason: "delivered" });
    this.item(conv, { id, kind: "user", status: "done", text: p.text, via: p.kind });
  }

  ask(conv: string, question: string, options: string[]): string {
    const id = `${this.turnOf(conv)}:ask:1`;
    this.item(conv, { id, kind: "ask", status: "pending", question, options });
    return id;
  }

  endTurn(conv: string, status: "completed" | "stopped" | "cut" = "completed"): void {
    this.emit(conv, { type: "turn.ended", turn: this.turnOf(conv), status });
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
        if (route === "GET /api/v1/vault/file") return send(404, { error: "no" });
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
    switch (b.type) {
      case "send": {
        if (p?.items.some((x) => x.id === b.clientId)) return { ok: true, convId: conv, duplicate: true };
        if (!p) this.create(conv);
        this.startTurn(conv);
        this.item(conv, { id: b.clientId, kind: "user", status: "done", text: String(b.text ?? "") || "(image)", via: "chat" });
        this.onSend(conv, b);
        return { ok: true, convId: conv };
      }
      case "steer":
      case "queue":
        if (!p?.turn) return { ok: false, error: "nothing running" };
        this.emit(conv, { type: "pending.added", pending: { id: b.clientId, kind: b.type, text: String(b.text ?? ""), at: 0 } });
        return { ok: true, convId: conv, ...(b.type === "queue" ? { queued: true, qid: b.clientId } : { steered: true }) };
      case "unqueue":
        if (!p?.pending.some((x) => x.id === b.id)) return { ok: false, error: "already delivered" };
        this.emit(conv, { type: "pending.removed", id: b.id, reason: "taken-back" });
        return { ok: true };
      case "stop":
        if (p?.turn) {
          for (const x of p.pending) this.emit(conv, { type: "pending.removed", id: x.id, reason: "stopped" });
          this.item(conv, { id: `${p.turn.id}:stopped`, kind: "notice", status: "done", text: "Stopped." });
          this.endTurn(conv, "stopped");
        }
        return { ok: true };
      case "answer": {
        const ask = [...(p?.items ?? [])].reverse().find((x) => x.kind === "ask" && x.status === "pending");
        this.item(conv, { id: b.clientId, kind: "user", status: "done", text: String(b.text ?? ""), via: "answer" });
        if (ask) this.emit(conv, { type: "item.completed", id: ask.id, patch: { answer: String(b.text ?? "") } });
        return { ok: true, convId: conv, answered: true };
      }
      case "lines":
        if (!p) this.create(conv);
        (b.lines ?? []).forEach((l: any, i: number) =>
          this.emit(conv, { type: "item.started", item: { id: `${b.clientId}:${i}`, kind: l.role === "assistant" ? "assistant" : "user", status: "done", text: l.text, ...(l.hidden ? { hidden: true } : {}), at: 0 } }),
        );
        return { ok: true, convId: conv };
      case "delete":
        this.emit(conv, { type: "conv.updated", patch: { deleted: true } });
        return { ok: true };
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
