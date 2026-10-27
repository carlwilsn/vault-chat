// The voice's waiting line: one thin line under the voice bars, shown only while the voice is waiting on work, and the
// same everywhere (laptop titlebar, popout, phone, iPad board). Carl's model: wait until the line is complete and the
// voice talks back. So it never lies:
//   • determinate only when real steps exist (the agent's plan: done / total), never a made-up percentage;
//   • otherwise indeterminate, its pace the only hint of how long: quick (seconds) or slow (a minute or more);
//   • the expectation is the agent's own word (Delegate {expect}) or, without one, what such work took before
//     (calibration from the box's turn log and this conversation's history), corrected when the word is off;
//   • work that runs past its expectation turns slow; it never sits at 99%;
//   • when the work ends the line completes, and stays complete until the voice speaks (then it goes), or until it is
//     clear nothing is coming (COMPLETE_HOLD_MS).
// Several jobs at once are one line. Pure logic (WaitTracker) plus one DOM renderer (renderWaitLine) every surface uses.

export type Expect = "short" | "long";
/** Something the voice is waiting on: the running turn's tools, a Delegate worker, a Classic Ask. */
export type WaitWork = { key: string; kind: string; startedAt: number; expect?: Expect };
export type WaitPlan = { done: number; total: number };
/** What such work took before, by kind: "turn" (a voice turn with tools), "Delegate", "VoiceAsk", a tool's name. */
export type WaitCalib = Record<string, { n: number; p50Ms: number; p90Ms: number }>;
/** frac: 0..1 (1 = complete) or null (indeterminate). */
export type WaitView = { frac: number | null; pace: Expect };

/** Work expected to take this long or more is "long". */
export const LONG_MS = 20_000;
/** A completed line waits this long for the voice to speak before it goes (never a stale "done" left up). */
export const COMPLETE_HOLD_MS = 30_000;
const DEFAULT_MS: Record<string, number> = { turn: 8_000, VoiceAsk: 15_000, Delegate: 60_000 };
const MIN_SAMPLES = 3;

/** How long this work should take (ms), from its declaration and the calibration. Pure. */
export function expectedMs(w: WaitWork, calib: WaitCalib): number {
  const c = calib[w.kind];
  const cal = c && c.n >= MIN_SAMPLES ? c : null;
  if (w.expect === "long") return Math.max(LONG_MS, cal?.p90Ms ?? 0);
  if (w.expect === "short") {
    // Its word, unless history says this kind of work is systematically long.
    if (cal && cal.n >= 5 && cal.p50Ms >= LONG_MS) return cal.p90Ms;
    return Math.min(cal?.p90Ms ?? LONG_MS / 2, LONG_MS - 1);
  }
  return cal?.p90Ms ?? DEFAULT_MS[w.kind] ?? DEFAULT_MS.turn;
}

/** The line for the work running now (no completion state). Pure. */
export function waitView(o: { works: WaitWork[]; plan?: WaitPlan | null; calib: WaitCalib; now: number }): WaitView | null {
  if (!o.works.length) return null;
  const slow = o.works.some((w) => {
    const exp = expectedMs(w, o.calib);
    return exp >= LONG_MS || o.now - w.startedAt > exp;
  });
  const p = o.plan;
  const frac = p && p.total > 0 && p.done < p.total ? Math.max(0, p.done) / p.total : null;
  return { frac, pace: slow ? "long" : "short" };
}

/** Between two spoken pieces of one reply the voice is quiet this long; the line stays down meanwhile (it flickered
 *  on in every gap while a worker ran). */
export const SPEECH_GAP_MS = 1_500;

/** The line over time: running → complete (held until the voice speaks) → gone. One per surface. */
export class WaitTracker {
  private last: WaitView | null = null;
  private completeAt: number | null = null;
  /** The running turn's work, kept between its tool calls while the turn still runs (it is still working: writing
   *  the next call, reading what came back). Without it the line showed "complete" for 20 s while the turn went on. */
  private turn: WaitWork | null = null;
  private spokeAt = -Infinity;

  /** `running`: the conversation's turn is still running (its tools come and go; the turn is the work). */
  update(o: { works: WaitWork[]; plan?: WaitPlan | null; calib: WaitCalib; now: number; speaking: boolean; running?: boolean }): WaitView | null {
    if (o.speaking) {
      // The voice talks back: the line has done its job.
      this.last = null;
      this.completeAt = null;
      this.turn = null;
      this.spokeAt = o.now;
      return null;
    }
    if (o.now - this.spokeAt < SPEECH_GAP_MS) return null;
    const live = o.works.find((w) => w.kind === "turn");
    if (live) this.turn = { ...live, startedAt: Math.min(live.startedAt, this.turn?.startedAt ?? live.startedAt) };
    else if (!o.running) this.turn = null;
    if (!live && this.turn && o.running) o = { ...o, works: [...o.works, this.turn] };
    const v = waitView(o);
    if (v) {
      this.last = v;
      this.completeAt = null;
      return v;
    }
    if (!this.last) return null;
    this.completeAt ??= o.now;
    if (o.now - this.completeAt >= COMPLETE_HOLD_MS) {
      this.last = null;
      this.completeAt = null;
      return null;
    }
    return { frac: 1, pace: this.last.pace };
  }
}

/** What the voice waits on, from what every surface already has (the conversation's view): the running turn's tools
 *  (one job: the turn), the work it handed off (Delegate workers, with the agent's expect), on Classic what was asked
 *  on the call (its Ask rows); the agent's plan when the turn has one in progress; and history for calibration. */
export function waitInputs(o: {
  running: boolean;
  tools: { startedAt?: number }[];
  startedAt?: number | null;
  subagents?: { threadId: string; kind?: string; state?: string; status?: string; startedAt?: number; endedAt?: number; expect?: Expect }[];
  todos?: { status: string }[] | null;
  messages?: { mid?: string; voiceAsk?: { request: string; running?: boolean; startedAt?: number; ms?: number } }[];
  now: number;
}): { works: WaitWork[]; plan: WaitPlan | null; samples: Record<string, number[]>; running: boolean } {
  const works: WaitWork[] = [];
  const tools = o.running ? o.tools : [];
  if (tools.length) works.push({ key: "turn", kind: "turn", startedAt: Math.min(...tools.map((t) => t.startedAt ?? o.startedAt ?? o.now)) });
  // A StartJob job (a dev server) is not work the voice waits on.
  for (const a of o.subagents ?? []) {
    if (a.kind === "job") continue;
    if ((a.state ?? a.status) === "running" && a.startedAt) works.push({ key: a.threadId, kind: "Delegate", startedAt: a.startedAt, ...(a.expect ? { expect: a.expect } : {}) });
  }
  for (const m of o.messages ?? []) {
    if (m.voiceAsk?.running && m.voiceAsk.startedAt) works.push({ key: m.mid ?? m.voiceAsk.request, kind: "VoiceAsk", startedAt: m.voiceAsk.startedAt });
  }
  const todos = o.todos ?? [];
  const plan = tools.length && todos.some((t) => t.status === "in_progress") ? { done: todos.filter((t) => t.status === "completed").length, total: todos.length } : null;
  const samples = {
    Delegate: (o.subagents ?? []).filter((a) => a.kind !== "job" && a.startedAt && a.endedAt).map((a) => a.endedAt! - a.startedAt!),
    VoiceAsk: (o.messages ?? []).filter((m) => m.voiceAsk && !m.voiceAsk.running && m.voiceAsk.ms).map((m) => m.voiceAsk!.ms!),
  };
  return { works, plan, samples, running: o.running };
}

/** Calibration from history this surface can see (finished Delegate workers, finished Classic Asks), merged over the
 *  box's (GET /api/v1/brain/expect). */
export function calibFrom(samples: Record<string, number[]>, base: WaitCalib = {}): WaitCalib {
  const out: WaitCalib = { ...base };
  for (const [kind, ms] of Object.entries(samples)) {
    const xs = ms.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
    if (xs.length < MIN_SAMPLES) continue;
    const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))]!;
    out[kind] = { n: xs.length, p50Ms: q(0.5), p90Ms: q(0.9) };
  }
  return out;
}

// ---------------------------------------------------------------- the one look

const STYLE_ID = "vc-wait-line-style";
const CSS = `
.vc-wait{position:relative;height:1.5px;width:100%;margin-top:3px;border-radius:1px;overflow:hidden;opacity:0;transition:opacity .25s}
.vc-wait.on{opacity:1}
.vc-wait::before{content:"";position:absolute;inset:0;background:currentColor;opacity:.18}
.vc-wait>i{position:absolute;top:0;bottom:0;left:0;background:currentColor;opacity:.75;border-radius:1px;transition:width .35s ease-out}
.vc-wait.ind>i{width:32%!important;animation:vc-wait-run var(--vc-wait-pace,1.2s) ease-in-out infinite}
@keyframes vc-wait-run{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
@media (prefers-reduced-motion:reduce){.vc-wait.ind>i{animation:none;width:100%!important;opacity:.4}}
`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

/** Draw the line into `el` (made a .vc-wait with one child). The same element and look on every surface. */
export function renderWaitLine(el: HTMLElement, v: WaitView | null): void {
  ensureStyle(el.ownerDocument);
  if (!el.classList.contains("vc-wait")) {
    el.classList.add("vc-wait");
    el.setAttribute("aria-hidden", "true");
    el.dataset.el = "voice-wait-line";
  }
  let fill = el.firstElementChild as HTMLElement | null;
  if (!fill) {
    fill = el.ownerDocument.createElement("i");
    el.appendChild(fill);
  }
  el.classList.toggle("on", !!v);
  if (!v) {
    el.dataset.state = "off";
    return;
  }
  const ind = v.frac === null;
  el.classList.toggle("ind", ind);
  el.style.setProperty("--vc-wait-pace", v.pace === "long" ? "3.2s" : "1.1s");
  fill.style.width = ind ? "" : `${Math.round(Math.min(1, v.frac!) * 1000) / 10}%`;
  el.dataset.state = ind ? v.pace : v.frac! >= 1 ? "complete" : "steps";
}
