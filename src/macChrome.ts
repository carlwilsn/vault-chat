// macOS window chrome: the main window draws under its title bar (src-tauri/tauri.macos.conf.json: titleBarStyle
// Overlay, hiddenTitle, trafficLightPosition {x: 14, y: 12}), and the chat popout does the same on a Mac
// (src/sync.ts), so the red/yellow/green buttons float over the window's top-left corner. Whatever the app draws there
// keeps clear of them: the title bar (src/plugins/titlebar/Bar.tsx, src/Titlebar.tsx) starts its controls after
// TRAFFIC_LIGHTS_INSET.left, and where there is no title bar (full-screen chat, the popout: src/plugins/chat/Frame.tsx,
// src/FullscreenChat.tsx) the chats sidebar sits below a TRAFFIC_LIGHTS_INSET.top strip and the chat's own bar starts
// after the left inset. Windows and Linux draw their own window controls (src/WindowControls.tsx): nothing is reserved.
// The self-test's {expect: {clear: "traffic-lights"}} (src/selfTest.ts, test/selftest/tour.json) measures it on a real Mac.

/** True in the macOS app (and any Mac browser preview, which then looks like the app). */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The room the traffic lights take, in CSS px from the window's top-left: content starts after `left` on the title
 * bar's row, or below `top` (the 36 px of a bar, h-9) when it is not on a bar. */
export const TRAFFIC_LIGHTS_INSET = { left: 76, top: 36 } as const;

/** Where the three buttons are drawn (trafficLightPosition x 14, y 12; 14 px buttons 20 px apart), with a few px of
 * margin: nothing the app draws may touch this. */
export const TRAFFIC_LIGHTS_RECT = { left: 8, top: 4, right: 72, bottom: 32 } as const;

/** Style for a row at the window's top-left: its content starts after the traffic lights on a Mac. */
export const macBarInset: { paddingLeft: number } | undefined = isMac ? { paddingLeft: TRAFFIC_LIGHTS_INSET.left } : undefined;

export type Box = { left: number; top: number; right: number; bottom: number };

export function intersects(a: Box, b: Box = TRAFFIC_LIGHTS_RECT): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** What the window draws under the traffic lights: each visible text run and each control (button, link, input)
 * whose box touches TRAFFIC_LIGHTS_RECT, as "<what> at x,y wxh". Empty when the corner is clear. */
export function underTrafficLights(doc: Document = document, rect: Box = TRAFFIC_LIGHTS_RECT): string[] {
  const hits: string[] = [];
  const view = doc.defaultView;
  const visible = (el: Element) => {
    const cs = view?.getComputedStyle(el);
    return !cs || (cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity || "1") > 0.05);
  };
  const say = (what: string, b: DOMRect) => `${what} at ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`;
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n && hits.length < 10; n = walker.nextNode()) {
    const t = (n.textContent ?? "").trim();
    if (!t || !n.parentElement || !visible(n.parentElement)) continue;
    const range = doc.createRange();
    range.selectNodeContents(n);
    for (const b of Array.from(range.getClientRects())) {
      if (b.width > 0 && b.height > 0 && intersects(b, rect)) {
        hits.push(say(`text "${t.slice(0, 30)}"`, b));
        break;
      }
    }
  }
  for (const el of Array.from(doc.querySelectorAll("button, a[href], input, textarea, select, svg"))) {
    if (hits.length >= 10) break;
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0 && visible(el) && intersects(b, rect)) {
      const name = el.getAttribute("title") || el.getAttribute("aria-label") || el.getAttribute("data-el") || "";
      hits.push(say(`${el.tagName.toLowerCase()}${name ? ` "${name.slice(0, 30)}"` : ""}`, b));
    }
  }
  return hits;
}

/** The first visible text near the window's top (the full-screen chat's "Chats" header), for the self-test's note. */
export function firstHeaderText(doc: Document = document): string | null {
  const walker = doc.createTreeWalker(doc.body, 4);
  let best: { t: string; b: DOMRect } | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent ?? "").trim();
    if (!t || !n.parentElement) continue;
    const range = doc.createRange();
    range.selectNodeContents(n);
    const b = range.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0 || b.top > 80) continue;
    if (!best || b.left < best.b.left) best = { t, b };
  }
  return best ? `"${best.t.slice(0, 30)}" at ${Math.round(best.b.left)},${Math.round(best.b.top)} ${Math.round(best.b.width)}x${Math.round(best.b.height)}` : null;
}
