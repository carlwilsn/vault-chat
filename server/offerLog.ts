// Offer events in the box's event log (src/offerHistory.ts sends them): each is an `offer.event` signal record in the
// vault's log, kept like every other record (and in the daily backup, server/dailyBackup.ts). box:history
// (server/boxOffers.ts) searches them, with no 7-day limit and no device needed.
import { signal, signalLog } from "./convlog/log";
import { redact } from "./boxOffers";

export const OFFER_EVENT = "offer.event";
const MAX_EVENTS = 50;

/** `before`: what the part's state was before this event, where it changed (src/pluginOffers.ts): the agent's undo. */
export type OfferLogRecord = { seq: number; at: number; device: string; plugin: string; event: string; payload?: string; before?: string };

const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");

/** POST /api/v2/offer-events {events: [{plugin, event, at, payload?, before?}], client}: each kept as one record. */
export function offerEventsRoute(vault: string, body: Record<string, unknown> | null): { status: number; body: unknown } {
  const list = Array.isArray(body?.events) ? (body!.events as unknown[]).slice(0, MAX_EVENTS) : null;
  if (!list) return { status: 400, body: { error: "events: [{plugin, event, at, payload?}]" } };
  const device = ["laptop", "phone"].includes(String(body?.client)) ? String(body!.client) : "laptop";
  let kept = 0;
  for (const raw of list) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const plugin = str(e.plugin, 200);
    const event = str(e.event, 80);
    if (!plugin || !event) continue;
    const at = Number.isFinite(Number(e.at)) ? Number(e.at) : Date.now();
    const payload = typeof e.payload === "string" ? redact(e.payload.slice(0, 500)) : undefined;
    const before = typeof e.before === "string" ? redact(e.before.slice(0, 2_000)) : undefined;
    if (signal(vault, { type: OFFER_EVENT, device, plugin, event, at, ...(payload ? { payload } : {}), ...(before ? { before } : {}) })) kept++;
  }
  return { status: 200, body: { ok: true, kept } };
}

/** The offer events of these vaults' logs, oldest first. */
export function offerEvents(vaults: string[]): OfferLogRecord[] {
  const out: OfferLogRecord[] = [];
  for (const v of new Set(vaults)) {
    let recs: unknown[] = [];
    try {
      recs = signalLog(v).signals(0);
    } catch {
      continue;
    }
    for (const r of recs as { seq: number; at: number; signal?: Record<string, unknown> }[]) {
      const s = r.signal;
      if (s?.type !== OFFER_EVENT) continue;
      out.push({ seq: r.seq, at: Number(s.at) || r.at, device: String(s.device ?? ""), plugin: String(s.plugin ?? ""), event: String(s.event ?? ""), ...(typeof s.payload === "string" ? { payload: s.payload } : {}), ...(typeof s.before === "string" ? { before: s.before } : {}) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Search them: every word of `query` in the plugin, event or payload; `plugin` narrows; `days` back (default all). */
export function searchOfferEvents(vaults: string[], o: { query?: string; plugin?: string; days?: number; limit?: number; now?: number } = {}): OfferLogRecord[] {
  const words = String(o.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const since = o.days && o.days > 0 ? (o.now ?? Date.now()) - o.days * 86_400_000 : 0;
  const plugin = String(o.plugin ?? "").toLowerCase();
  const hits = offerEvents(vaults).filter((r) => r.at >= since && (!plugin || r.plugin.toLowerCase().includes(plugin)) && words.every((w) => `${r.plugin} ${r.event} ${r.payload ?? ""}`.toLowerCase().includes(w)));
  return hits.slice(-Math.min(Math.max(Number(o.limit) || 30, 1), 200));
}
