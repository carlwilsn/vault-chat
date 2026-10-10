// The pi engine's dollar ledger. Never pi's own price (its catalog price was
// 53% high for DeepSeek, and Claude's responseId is not a generation id): the
// extension records, per model call, OpenRouter's generation id
// (x-generation-id) and the cost OpenRouter reported in the stream. A call
// with an id but no streamed cost is looked up with GET /generation?id=
// (404 for a few seconds after the call — retried for ~30 s). Counted ids are
// kept in $VC_STATE_DIR/pi-ledger.json so nothing is billed twice (a session
// replayed after a restart carries its old entries again).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { renameRetry } from "../../atomic";

export type CallCost = { genId: string | null; cost: number | null };

export class PiLedger {
  private seen: Record<string, number | null> = {};
  constructor(
    private path: string,
    private apiKey: () => string | null,
    private base = "https://openrouter.ai/api/v1",
    private lookupMs = 30_000,
  ) {
    try {
      this.seen = JSON.parse(readFileSync(path, "utf8")) ?? {};
    } catch {
      this.seen = {};
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path + ".tmp", JSON.stringify(this.seen));
      renameRetry(this.path + ".tmp", this.path);
    } catch {
      /* best effort */
    }
  }

  async generationCost(id: string): Promise<number | null> {
    const end = Date.now() + this.lookupMs;
    for (let wait = 1000; ; wait = Math.min(wait * 1.5, 5000)) {
      try {
        const key = this.apiKey();
        const r = await fetch(`${this.base}/generation?id=${encodeURIComponent(id)}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
        if (r.ok) {
          const j: any = await r.json();
          const c = Number(j?.data?.total_cost ?? j?.total_cost);
          return Number.isFinite(c) ? c : null;
        }
        if (r.status !== 404 && r.status < 500 && r.status !== 429) return null;
      } catch {
        /* network: retry */
      }
      if (Date.now() + wait > end) return null;
      await new Promise((res) => setTimeout(res, wait));
    }
  }

  /** Cost the calls not counted yet: {usd, calls, missing, lookedUp}. */
  async settle(calls: CallCost[]): Promise<{ usd: number; calls: number; missing: number; lookedUp: number }> {
    let usd = 0;
    let missing = 0;
    let lookedUp = 0;
    let n = 0;
    const lookups: Promise<void>[] = [];
    for (const c of calls) {
      if (c.genId) {
        if (c.genId in this.seen) continue;
        this.seen[c.genId] = c.cost; // claim first: a concurrent settle cannot double-count
      }
      n++;
      if (c.cost !== null && Number.isFinite(c.cost)) {
        usd += c.cost;
        continue;
      }
      if (!c.genId) {
        missing++;
        continue;
      }
      const id = c.genId;
      lookups.push(
        this.generationCost(id).then((v) => {
          this.seen[id] = v;
          if (v === null) missing++;
          else {
            usd += v;
            lookedUp++;
          }
        }),
      );
    }
    await Promise.all(lookups);
    if (n) this.save();
    return { usd: Math.round(usd * 1e7) / 1e7, calls: n, missing, lookedUp };
  }
}
