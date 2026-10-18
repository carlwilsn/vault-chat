// The board's WebKit checks run as Carl's iPad is seen by a page: an iPad Pro 11 viewport with touch, but the
// user agent of a Mac. iPadOS Safari and Home Screen apps send a desktop Mac UA by default (the box's board log
// shows "ua":"Macintosh" on every line), so nothing may depend on the UA saying "iPad"; maxTouchPoints and
// each event's pointerType are what tell a touch screen.
//
// Needs playwright-core with its WebKit (npx playwright install webkit); if it is not in node_modules, point
// PLAYWRIGHT_CORE at its folder (e.g. preview/node_modules/playwright-core).
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/** What iPadOS 18 Safari / a Home Screen app sends: a Mac. */
export const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

export async function playwright() {
  const pwPath = process.env.PLAYWRIGHT_CORE;
  return import(pwPath ? pathToFileURL(join(pwPath, "index.mjs")).href : "playwright-core");
}

/** A WebKit page that looks like Carl's iPad (Mac UA, touch, maxTouchPoints 5). */
export async function ipadPage(o = {}) {
  const { webkit, devices } = await playwright();
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices["iPad Pro 11 landscape"], userAgent: MAC_UA, hasTouch: true, isMobile: true, ...o });
  await ctx.addInitScript(() => {
    // WebKit on a desktop reports no touch points; the iPad reports 5.
    try {
      Object.defineProperty(Navigator.prototype, "maxTouchPoints", { get: () => 5, configurable: true });
    } catch {
      /* already defined */
    }
  });
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

export function checker() {
  let failed = 0;
  const check = (ok, what, detail = "") => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failed++;
    return ok;
  };
  return { check, failed: () => failed };
}

/**
 * Touches as iPadOS delivers them to a page: PointerEvents with pointerType "touch" and the contact's size
 * (WebKit iOS reports width/height as twice UITouch's majorRadius: a fingertip is 41.75 or 62.6, a thumb up to
 * 83.5, a palm 104 and more). Dispatched on the element under each point, like the real thing.
 */
export function touchScript() {
  return () => {
    const live = new Map();
    const at = (x, y) => document.elementFromPoint(x, y) ?? document.body;
    const fire = (type, id, x, y, size, kind = "touch", buttons = 1) => {
      const target = type === "pointerdown" ? at(x, y) : (live.get(id)?.target ?? at(x, y));
      if (type === "pointerdown") live.set(id, { target });
      const ev = new PointerEvent(type, { pointerId: id, pointerType: kind, isPrimary: live.size === 1, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, width: size, height: size, pressure: buttons ? 0.5 : 0, buttons, button: type === "pointermove" ? -1 : 0 });
      target.dispatchEvent(ev);
      if (type === "pointerup" || type === "pointercancel") live.delete(id);
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    /** Fingers moving together: `paths` [{id, from: [x,y], to: [x,y], size}], over `ms`, landing `stagger` ms apart. */
    window.__gesture = async (paths, ms = 300, stagger = 30, steps = 12) => {
      for (const [k, p] of paths.entries()) {
        // The stagger exactly (a busy page delays timers: a 30 ms setTimeout can fire 300 ms late).
        if (k) for (const t = performance.now(); performance.now() - t < stagger; );
        fire("pointerdown", p.id, p.from[0], p.from[1], p.size, p.kind);
      }
      for (let i = 1; i <= steps; i++) {
        await sleep(ms / steps);
        for (const p of paths) fire("pointermove", p.id, p.from[0] + ((p.to[0] - p.from[0]) * i) / steps, p.from[1] + ((p.to[1] - p.from[1]) * i) / steps, p.grow ? p.size + (p.grow * i) / steps : p.size, p.kind);
      }
      for (const p of paths) fire("pointerup", p.id, p.to[0], p.to[1], p.size, p.kind, 0);
    };
    /** A Pencil stroke from `from` to `to`. */
    window.__pen = async (from, to, ms = 200, steps = 10) => {
      fire("pointerdown", 900, from[0], from[1], 1, "pen");
      for (let i = 1; i <= steps; i++) {
        await sleep(ms / steps);
        fire("pointermove", 900, from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, 1, "pen");
      }
      fire("pointerup", 900, to[0], to[1], 1, "pen", 0);
    };
  };
}
