// The Tour's player inside a frame: the same steps as runSteps (steps.ts),
// played at a human pace — a visible pointer glides to what it clicks, text is
// typed a character at a time, key chords are shown as a badge, a hovered
// element's tooltip (its title) is drawn, and what changed gets a soft outline
// pulse (after side only). The shell calls window.__preview.tour(steps, opts).
import type { Step } from "../scenarios/types";
import { runSteps, q, qa, byText, pressKey } from "./steps";

export type TourStep =
  | Step
  | { hover: string; text?: string; tip?: boolean; hold?: number }
  | { highlight: string; text?: string; label?: string; both?: boolean; all?: boolean }
  | { scroll: string; text?: string; to?: "top" | "bottom" | number; by?: number; ms?: number }
  | { typeSlow: string; into: string; enter?: boolean }
  | { selectLine: string; within?: string }
  | { hold: number }
  | { click: string; text?: string; nth?: number; optional?: boolean };

export type TourOpts = { side: string; pace?: number; vault: string };

export type TourCtl = { paused: boolean; aborted: boolean };
export const ctl: TourCtl = { paused: false, aborted: false };

class Aborted extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sleep that honours pause and abort. */
async function wait(ms: number): Promise<void> {
  let left = ms;
  while (left > 0) {
    if (ctl.aborted) throw new Aborted("aborted");
    if (ctl.paused) {
      await sleep(100);
      continue;
    }
    const d = Math.min(100, left);
    await sleep(d);
    left -= d;
  }
  if (ctl.aborted) throw new Aborted("aborted");
}

// ---- overlay: pointer, key badge, tooltip, highlight -------------------------

const Z = "2147483646";
let layer: HTMLDivElement | null = null;
let pointer: HTMLDivElement | null = null;
let pos = { x: 0, y: 0 };

function overlay(): HTMLDivElement {
  if (layer && document.body.contains(layer)) return layer;
  layer = document.createElement("div");
  layer.id = "vc-tour-layer";
  Object.assign(layer.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: Z });
  const st = document.createElement("style");
  st.textContent = `
  @keyframes vcTourPulse { 0% { box-shadow: 0 0 0 0 rgba(255,196,64,.75), 0 0 0 2px rgba(255,196,64,.95) } 70% { box-shadow: 0 0 0 14px rgba(255,196,64,0), 0 0 0 2px rgba(255,196,64,.95) } 100% { box-shadow: 0 0 0 0 rgba(255,196,64,0), 0 0 0 2px rgba(255,196,64,.95) } }
  @keyframes vcTourRipple { from { transform: translate(-50%,-50%) scale(.3); opacity: .9 } to { transform: translate(-50%,-50%) scale(1.6); opacity: 0 } }
  .vc-tour-hl { position: fixed; border-radius: 8px; animation: vcTourPulse 1.6s ease-out infinite; transition: all .25s; }
  .vc-tour-hl b { position: absolute; right: 0; top: -22px; font: 600 11px/1 system-ui, sans-serif; color: #1b1300; background: #ffc440; padding: 4px 7px; border-radius: 5px; white-space: nowrap; }
  .vc-tour-tip { position: fixed; max-width: 360px; font: 12px/1.45 system-ui, "Segoe UI", sans-serif; color: #f2f2f2; background: #26282d; border: 1px solid #44474f; padding: 7px 10px; border-radius: 6px; white-space: pre-line; box-shadow: 0 6px 18px rgba(0,0,0,.45); }
  .vc-tour-key { position: fixed; left: 50%; bottom: 46px; transform: translateX(-50%); font: 600 20px/1 system-ui, sans-serif; color: #fff; background: rgba(20,22,26,.88); border: 1px solid #555; padding: 12px 18px; border-radius: 10px; letter-spacing: .02em; }
  .vc-tour-ripple { position: fixed; width: 34px; height: 34px; border-radius: 50%; border: 2px solid #ffc440; animation: vcTourRipple .5s ease-out forwards; }`;
  layer.appendChild(st);
  pointer = document.createElement("div");
  Object.assign(pointer.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "18px",
    height: "18px",
    marginLeft: "-3px",
    marginTop: "-2px",
    opacity: "0",
    transition: "opacity .2s",
    background:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'%3E%3Cpath d='M2 1l13 7.5-5.6 1.4L7 15.6z' fill='%23fff' stroke='%23000' stroke-width='1.2'/%3E%3C/svg%3E\") no-repeat",
  });
  layer.appendChild(pointer);
  document.body.appendChild(layer);
  pos = { x: window.innerWidth * 0.6, y: window.innerHeight * 0.55 };
  place();
  return layer;
}

function place(): void {
  if (pointer) pointer.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
}

async function glideTo(el: Element): Promise<void> {
  overlay();
  el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const r = el.getBoundingClientRect();
  const to = { x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2 };
  const from = { ...pos };
  pointer!.style.opacity = "1";
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const ms = Math.max(250, Math.min(700, dist * 0.9));
  const t0 = performance.now();
  for (;;) {
    if (ctl.aborted) throw new Aborted("aborted");
    const t = Math.min(1, (performance.now() - t0) / ms);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    pos = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
    place();
    if (t >= 1) break;
    await sleep(16);
  }
}

function ripple(): void {
  const d = document.createElement("div");
  d.className = "vc-tour-ripple";
  d.style.left = pos.x + "px";
  d.style.top = pos.y + "px";
  overlay().appendChild(d);
  setTimeout(() => d.remove(), 600);
}

let tipEl: HTMLDivElement | null = null;
function tip(el: HTMLElement, text: string): void {
  tipEl?.remove();
  if (!text) return;
  const r = el.getBoundingClientRect();
  tipEl = document.createElement("div");
  tipEl.className = "vc-tour-tip";
  tipEl.textContent = text;
  overlay().appendChild(tipEl);
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  const top = r.top - h - 10 > 8 ? r.top - h - 10 : r.bottom + 10;
  Object.assign(tipEl.style, { left: left + "px", top: top + "px" });
}

async function keyBadge(chord: string): Promise<void> {
  const b = document.createElement("div");
  b.className = "vc-tour-key";
  b.textContent = chord.replace(/\+([a-z])$/, (_m, k: string) => "+" + k.toUpperCase());
  overlay().appendChild(b);
  setTimeout(() => b.remove(), 1300);
  await wait(450);
}

const highlights: Array<{ el: HTMLElement; box: HTMLDivElement }> = [];
function highlight(els: HTMLElement[], label?: string): void {
  for (const [i, el] of els.entries()) {
    const box = document.createElement("div");
    box.className = "vc-tour-hl";
    if (label && i === 0) {
      const b = document.createElement("b");
      b.textContent = label;
      box.appendChild(b);
    }
    overlay().appendChild(box);
    highlights.push({ el, box });
  }
  track();
}
let tracking = false;
function track(): void {
  if (tracking) return;
  tracking = true;
  const tick = () => {
    for (const { el, box } of highlights) {
      const r = el.getBoundingClientRect();
      const pad = 4;
      Object.assign(box.style, { left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px", display: r.width ? "block" : "none" });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---- finding things ----------------------------------------------------------

function textMatcher(t: string | RegExp): string | RegExp {
  if (t instanceof RegExp) return t;
  const m = /^\/(.*)\/([a-z]*)$/.exec(t);
  return m ? new RegExp(m[1], m[2]) : t;
}

async function find(sel: string, text?: string | RegExp, timeout = 10000): Promise<HTMLElement> {
  const t0 = Date.now();
  for (;;) {
    const el = text ? byText(textMatcher(text), sel) : q(sel);
    if (el) return el;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${sel}${text ? ` "${text}"` : ""}`);
    await wait(80);
  }
}

function scrollParent(el: HTMLElement): HTMLElement {
  for (let p: HTMLElement | null = el; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 4) return p;
  }
  return (document.scrollingElement as HTMLElement) ?? document.body;
}

async function smoothScroll(box: HTMLElement, to: number, ms: number): Promise<void> {
  const from = box.scrollTop;
  const max = box.scrollHeight - box.clientHeight;
  const target = Math.max(0, Math.min(max, to));
  const t0 = performance.now();
  for (;;) {
    if (ctl.aborted) throw new Aborted("aborted");
    if (ctl.paused) {
      await sleep(100);
      continue;
    }
    const t = Math.min(1, (performance.now() - t0) / ms);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    box.scrollTop = from + (target - from) * e;
    if (t >= 1) break;
    await sleep(16);
  }
}

function setValue(el: HTMLElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---- the player --------------------------------------------------------------

export async function playTour(steps: TourStep[], opts: TourOpts): Promise<{ ok: boolean; error?: string; aborted?: boolean }> {
  ctl.aborted = false;
  ctl.paused = false;
  const pace = opts.pace ?? 550;
  const after = opts.side === "after";
  try {
    overlay();
    for (const s of steps) {
      await wait(0);
      if ("hold" in s && Object.keys(s).length === 1) {
        await wait(s.hold);
        continue;
      }
      if ("click" in s) {
        // optional: a control only one side has (the Rocket, the Compass) —
        // clicked if it is there, skipped after a short look if not.
        const opt = (s as { optional?: boolean }).optional;
        const el = opt ? await find(s.click, s.text as any, 2500).catch(() => null) : await find(s.click, s.text as any);
        if (!el) continue;
        const target = s.nth !== undefined ? qa(s.click)[s.nth] ?? el : el;
        await glideTo(target);
        await wait(180);
        ripple();
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        target.click();
      } else if ("key" in s) {
        const target = s.target ? await find(s.target) : null;
        await keyBadge(s.key);
        pressKey(s.key, target);
      } else if ("typeSlow" in s || "type" in s) {
        const text = "typeSlow" in s ? s.typeSlow : (s as { type: string }).type;
        const el = await find(s.into);
        await glideTo(el);
        el.focus();
        const per = Math.max(18, Math.min(60, 1500 / Math.max(1, text.length)));
        for (let i = 1; i <= text.length; i++) {
          setValue(el, text.slice(0, i));
          await wait(per);
        }
        if ("enter" in s && s.enter) {
          await wait(250);
          pressKey("Enter", el);
        }
      } else if ("hover" in s) {
        const el = await find(s.hover, s.text);
        await glideTo(el);
        for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) el.dispatchEvent(new MouseEvent(t, { bubbles: t.endsWith("over") || t === "mousemove" }));
        if (s.tip !== false) tip(el, el.getAttribute("title") ?? el.closest("[title]")?.getAttribute("title") ?? "");
        await wait(s.hold ?? 1800);
      } else if ("highlight" in s) {
        if (!after && !s.both) continue;
        let els: HTMLElement[];
        if (s.all) {
          const m = s.text ? textMatcher(s.text) : null;
          const hit = (e: HTMLElement) => !m || (typeof m === "string" ? (e.textContent ?? "").trim() === m : m.test(e.textContent ?? ""));
          await find(s.highlight, s.text);
          els = qa(s.highlight).filter(hit);
        } else els = [await find(s.highlight, s.text)];
        highlight(els, s.label);
        await wait(300);
        continue;
      } else if ("scroll" in s) {
        const el = await find(s.scroll, s.text);
        const box = el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY) ? el : scrollParent(el);
        const to =
          s.to === "bottom" ? box.scrollHeight : s.to === "top" ? 0 : typeof s.to === "number" ? s.to : s.by !== undefined ? box.scrollTop + s.by : box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
        await smoothScroll(box, to, s.ms ?? 1800);
      } else if ("selectLine" in s) {
        // Select one line of the editor the way a person would (click, Home,
        // Shift+End): a DOM range over the line, which CodeMirror adopts.
        const line = await find(s.within ?? ".cm-line", s.selectLine);
        await glideTo(line);
        ripple();
        const r = document.createRange();
        r.selectNodeContents(line);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
        (line.closest("[contenteditable]") as HTMLElement | null)?.focus();
        document.dispatchEvent(new Event("selectionchange"));
        await wait(300);
      } else {
        // file / chat / conversation / waitIdle / wait / sleep / advance / emit / run
        if ("waitIdle" in s) {
          // Watch the stream: no extra pause, just wait for the turn.
          await runSteps([s], opts.vault);
        } else await runSteps([s as Step], opts.vault);
      }
      await wait(pace);
    }
    tipEl?.remove();
    return { ok: true };
  } catch (e) {
    if (e instanceof Aborted) return { ok: false, aborted: true };
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
