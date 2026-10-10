// The dollar ledger. Codex's live usage events carry tokens, not dollars, and
// the raw cost events stop after a resume; the rollout JSONL writes a
// `token_usage_record` with the OpenRouter response id for every model call,
// resumed or not. For each new id: GET /generation?id= (404 for a few seconds
// after the call — retried for ~30 s) → total_cost. Counted ids are kept in
// $VC_STATE_DIR/ledger.json so nothing is billed twice.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { renameRetry } from "../atomic";

export type CallRecord = { responseId: string; turnId: string };

/** Every token_usage_record in a rollout (optionally for one turn). */
export function rolloutCalls(rolloutPath: string, turnId?: string): CallRecord[] {
  let raw = "";
  try {
    raw = readFileSync(rolloutPath, "utf8");
  } catch {
    return [];
  }
  const out: CallRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes("token_usage_record")) continue;
    try {
      const v = JSON.parse(line);
      const p = v?.payload;
      if (v?.type !== "token_usage_record" || typeof p?.response_id !== "string") continue;
      if (turnId && p.turn_id !== turnId && p.root_turn_id !== turnId) continue;
      out.push({ responseId: p.response_id, turnId: String(p.turn_id ?? "") });
    } catch {
      /* partial line */
    }
  }
  return out;
}

export class Ledger {
  private seen: Record<string, number | null> = {};
  constructor(
    private path: string,
    private apiKey: () => string | null,
    private base = "https://openrouter.ai/api/v1",
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

  has(id: string): boolean {
    return id in this.seen;
  }

  /** OpenRouter's total_cost for one generation, retrying 404s for up to `ms`. */
  async generationCost(id: string, ms = 30_000): Promise<number | null> {
    const end = Date.now() + ms;
    for (let wait = 1000; ; wait = Math.min(wait * 1.5, 5000)) {
      try {
        const key = this.apiKey();
        const r = await fetch(`${this.base}/generation?id=${encodeURIComponent(id)}`, {
          headers: key ? { authorization: `Bearer ${key}` } : {},
        });
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

  /** Cost the calls not yet counted: {usd, calls, missing}. */
  async settle(calls: CallRecord[]): Promise<{ usd: number; calls: number; missing: number; byId: Record<string, number | null> }> {
    const fresh = [...new Set(calls.map((c) => c.responseId))].filter((id) => !this.has(id));
    let usd = 0;
    let missing = 0;
    const byId: Record<string, number | null> = {};
    // Claim first so a concurrent settle cannot double-count.
    for (const id of fresh) this.seen[id] = null;
    const costs = await Promise.all(fresh.map((id) => this.generationCost(id)));
    fresh.forEach((id, i) => {
      const c = costs[i];
      this.seen[id] = c ?? null;
      byId[id] = c ?? null;
      if (c === null || c === undefined) missing++;
      else usd += c;
    });
    if (fresh.length) this.save();
    return { usd: Math.round(usd * 1e7) / 1e7, calls: fresh.length, missing, byId };
  }
}
