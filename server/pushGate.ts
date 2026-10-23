// When the phone buzzes: one rule, in one place (Carl, 2026-10-23: "i get notifications on my
// phone for seemingly random reasons, doesn't add up well").
//
//   A push goes out only when
//     • something Carl started finished while he was not looking at any surface, or
//     • something needs him (a question, a failure he must act on) — and he is not looking;
//       while he is, it waits, and goes out when he leaves (if it still needs him).
//   Never for: background work he did not start, anything while he is looking at a
//   surface (laptop, phone, iPad) or in a voice call, a thing he already saw, or a duplicate.
//
// "Looking" is what the surfaces say (POST /api/v1/attention: the laptop while focused and used
// in the last few minutes, the phone and the iPad while their app is on screen), his own
// activity in the vault's context stream in the last two minutes, and a live voice call.
//
// The feed (notifications.jsonl, the in-app Alerts) is not gated: only the buzz is. Every
// decision is one journal line, `[push] sent|held|dropped …`, with what triggered it.
import { resolve } from "node:path";

export type Device = "laptop" | "phone" | "board";
const DEVICES: Device[] = ["laptop", "phone", "board"];

/** Why a push is offered. */
export type PushWhy =
  /** A question waits on Carl's answer. */
  | "ask"
  /** Something finished. */
  | "finished"
  /** A failure he must act on. */
  | "failed";

export type PushOffer = {
  vault: string;
  why: PushWhy;
  title: string;
  body: string;
  url: string;
  /** The Web Push tag: a newer push with the same tag replaces the older one on the phone. */
  tag: string;
  convId?: string | null;
  /** What raised it (the log's `trigger=`): AskUser, Notify, turn end, sync, alert … */
  trigger: string;
  /** Carl started it: his own message, or a wake/job his own turn set. A finish he did not start never buzzes. */
  byCarl?: boolean;
  /** Still needs him (an ask: not yet answered). Asked again for a held push before it goes out. */
  stillNeeded?: () => boolean;
};

export type Attention = { looking: boolean; where: string | null };

export type Decision = { act: "push" | "hold" | "drop"; reason: string };

/** A surface's beat counts this long (they beat every 30 s while Carl looks). */
export const BEAT_MS = 75_000;
/** His own activity in the context stream counts this long. */
export const ACTIVITY_MS = 2 * 60_000;
/** The same push (why, conversation, title, body) inside this window is a duplicate. */
export const DUP_MS = 30 * 60_000;
/** A held push (he was looking) waits at most this long for him to leave. */
export const HOLD_MAX_MS = 3 * 3_600_000;

/** The rule. Pure: the gate below feeds it what it knows. */
export function decide(o: { why: PushWhy; byCarl?: boolean; attention: Attention; duplicate: boolean; stillNeeded: boolean; heldMs?: number }): Decision {
  if (o.duplicate) return { act: "drop", reason: "duplicate" };
  if (!o.stillNeeded) return { act: "drop", reason: "no longer needed" };
  if (o.why === "finished" && !o.byCarl) return { act: "drop", reason: "background work Carl did not start" };
  if (o.attention.looking) {
    // A finish he was there for is seen; a question or a failure still needs him once he leaves.
    if (o.why === "finished") return { act: "drop", reason: `Carl is looking (${o.attention.where})` };
    if ((o.heldMs ?? 0) > HOLD_MAX_MS) return { act: "drop", reason: "held too long" };
    return { act: "hold", reason: `Carl is looking (${o.attention.where}); goes out when he leaves` };
  }
  if ((o.heldMs ?? 0) > HOLD_MAX_MS) return { act: "drop", reason: "held too long" };
  return { act: "push", reason: "Carl is not looking" };
}

// ---------------------------------------------------------------- attention (what the surfaces say)

const vkey = (vault: string) => resolve(vault).toLowerCase();
type Beat = { looking: boolean; at: number; convId: string | null };
const beats = new Map<string, Map<Device, Beat>>();
/** Per vault: conversation → when a surface last showed it to Carl. */
const viewed = new Map<string, Map<string, number>>();

/** A surface says Carl is (or is no longer) looking, and at which conversation. */
export function noteAttention(vault: string, device: unknown, looking: boolean, convId?: unknown, now = Date.now()): boolean {
  if (!DEVICES.includes(device as Device)) return false;
  const k = vkey(vault);
  const m = beats.get(k) ?? new Map<Device, Beat>();
  const c = typeof convId === "string" && convId ? convId.slice(0, 200) : null;
  m.set(device as Device, { looking, at: now, convId: c });
  beats.set(k, m);
  if (looking && c) {
    const v = viewed.get(k) ?? new Map<string, number>();
    v.set(c, now);
    viewed.set(k, v);
  }
  return true;
}

/** When a surface last showed Carl this conversation (0: never, this run). */
export function lastViewed(vault: string, convId: string): number {
  return viewed.get(vkey(vault))?.get(convId) ?? 0;
}

/** The surface that has this conversation on screen while Carl looks at it, or null. */
export function viewingConv(vault: string, convId: string, now = Date.now()): Device | null {
  const m = beats.get(vkey(vault));
  if (!m) return null;
  for (const d of DEVICES) {
    const b = m.get(d);
    if (b && b.looking && b.convId === convId && now - b.at < BEAT_MS) return d;
  }
  return null;
}

/** Is Carl looking at a surface: the surfaces' beats, and what the gate is told besides (voice, activity). */
export function surfacesLooking(vault: string, now = Date.now()): Device | null {
  const m = beats.get(vkey(vault));
  if (!m) return null;
  for (const d of DEVICES) {
    const b = m.get(d);
    if (b && b.looking && now - b.at < BEAT_MS) return d;
  }
  return null;
}

/** Tests: forget every beat. */
export function resetAttention(): void {
  beats.clear();
  viewed.clear();
}

// ---------------------------------------------------------------- the gate

export type GateDeps = {
  send: (title: string, body: string, url: string, tag: string) => Promise<number>;
  /** Besides the surfaces' beats: a live voice call, his activity in the context stream. */
  attention?: (vault: string, now: number) => Attention;
  now?: () => number;
  log?: (line: string) => void;
};

type Held = { o: PushOffer; at: number; key: string };

export class PushGate {
  private held: Held[] = [];
  private recent: { key: string; convId: string | null; at: number }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private d: GateDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private log(line: string): void {
    (this.d.log ?? ((s) => console.log(s)))(line);
  }

  attention(vault: string, now = this.now()): Attention {
    const s = surfacesLooking(vault, now);
    if (s) return { looking: true, where: s === "board" ? "iPad" : s };
    return this.d.attention?.(vault, now) ?? { looking: false, where: null };
  }

  private keyOf(o: PushOffer): string {
    return `${vkey(o.vault)}|${o.why}|${o.convId ?? ""}|${o.title}|${o.body}`;
  }

  private duplicate(o: PushOffer, key: string, now: number, self?: Held): boolean {
    this.recent = this.recent.filter((r) => now - r.at < DUP_MS);
    if (this.recent.some((r) => r.key === key)) return true;
    if (this.held.some((h) => h !== self && h.key === key)) return true;
    // One "done" per conversation: the agent's own Notify and the turn's end say the same thing.
    if (o.why === "finished" && o.convId && this.recent.some((r) => r.convId === o.convId && now - r.at < 5 * 60_000)) return true;
    return false;
  }

  private line(act: string, o: PushOffer, reason: string): void {
    this.log(`[push] ${act} trigger=${o.trigger} why=${o.why}${o.convId ? ` conv=${o.convId}` : ""} "${o.title.slice(0, 80)}" — ${reason}`);
  }

  /** Offer a push: it goes out now, waits for Carl to leave, or is dropped. Resolves to what was done. */
  async offer(o: PushOffer): Promise<Decision & { sent?: number }> {
    const now = this.now();
    const key = this.keyOf(o);
    // On screen where he is looking: he is reading it (a question in the thread he has open is asked there).
    const reading = o.convId ? viewingConv(o.vault, o.convId, now) : null;
    if (reading) {
      this.line("dropped", o, `Carl has it open (${reading === "board" ? "iPad" : reading})`);
      return { act: "drop", reason: "Carl has it open" };
    }
    const dec = decide({ why: o.why, byCarl: o.byCarl, attention: this.attention(o.vault, now), duplicate: this.duplicate(o, key, now), stillNeeded: o.stillNeeded ? safe(o.stillNeeded) : true });
    if (dec.act === "push") return { ...dec, sent: await this.deliver(o, key, now, dec.reason) };
    this.line(dec.act === "hold" ? "held" : "dropped", o, dec.reason);
    if (dec.act === "hold") {
      this.held.push({ o, at: now, key });
      this.arm();
    }
    return dec;
  }

  private async deliver(o: PushOffer, key: string, now: number, reason: string): Promise<number> {
    this.recent.push({ key, convId: o.convId ?? null, at: now });
    const sent = await this.d.send(o.title, o.body, o.url, o.tag).catch(() => 0);
    this.line("sent", o, `${reason}; ${sent} phone${sent === 1 ? "" : "s"}`);
    return sent;
  }

  /** Held pushes, looked at again: out once Carl left, gone once it no longer needs him (or he saw it). */
  async tick(): Promise<void> {
    const now = this.now();
    for (const h of this.held.slice()) {
      const o = h.o;
      // He opened that conversation since it was held: he has seen it.
      const seen = !!o.convId && lastViewed(o.vault, o.convId) > h.at;
      const dec = seen
        ? { act: "drop" as const, reason: "Carl opened it" }
        : decide({ why: o.why, byCarl: o.byCarl, attention: this.attention(o.vault, now), duplicate: this.duplicate(o, h.key, now, h), stillNeeded: o.stillNeeded ? safe(o.stillNeeded) : true, heldMs: now - h.at });
      if (dec.act === "hold") continue;
      this.held = this.held.filter((x) => x !== h);
      if (dec.act === "push") await this.deliver(o, h.key, now, `${dec.reason} (held ${Math.round((now - h.at) / 1000)} s)`);
      else this.line("dropped", o, dec.reason);
    }
    if (!this.held.length) this.disarm();
  }

  /** What a tag's held push was about is over (a sync that recovered): it never goes out. */
  resolve(tag: string): number {
    const gone = this.held.filter((h) => h.o.tag === tag);
    this.held = this.held.filter((h) => h.o.tag !== tag);
    for (const h of gone) this.line("dropped", h.o, "resolved before Carl left");
    if (!this.held.length) this.disarm();
    return gone.length;
  }

  /** Pushes waiting for Carl to leave (tests, diagnostics). */
  pending(): PushOffer[] {
    return this.held.map((h) => h.o);
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 15_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stop(): void {
    this.disarm();
    this.held = [];
  }
}

function safe(f: () => boolean): boolean {
  try {
    return f();
  } catch {
    return true;
  }
}

let gate: PushGate | null = null;

/** The box's one gate (main.ts configures it with Web Push; until then nothing is sent). */
export function configurePushGate(d: GateDeps): PushGate {
  gate?.stop();
  gate = new PushGate(d);
  return gate;
}

export function pushGate(): PushGate | null {
  return gate;
}
