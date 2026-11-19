// After a core Try (src/changeReady.ts checkCoreSwap): point at where the new frontend's changes show, so Carl's eye
// goes straight to them. Each change's place is a commit's `Look: <selector> :: <what to see>` trailer
// (src/coreBundle.ts parseLooks); a ring is drawn over the first element that matches, with "New: <what to see>" next
// to it, for POINT_MS or until he clicks anywhere. A selector that matches nothing (a pane not open) is skipped: the
// outcome line still says what to look at.
import type { CoreLook } from "./coreBundle";

const POINT_MS = 12_000;
const WAIT_MS = 10_000;

function find(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null; // not a valid selector
  }
}

async function waitFor(selector: string, ms: number): Promise<Element | null> {
  const end = Date.now() + ms;
  for (;;) {
    const el = find(selector);
    if (el || Date.now() > end) return el;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Draw a ring and a label over each Look's element. Returns how many it pointed at. */
export async function pointAt(looks: readonly CoreLook[], o: { ms?: number; waitMs?: number } = {}): Promise<number> {
  if (typeof document === "undefined") return 0;
  const marks: HTMLElement[] = [];
  for (const look of looks.slice(0, 3)) {
    if (!look.selector) continue;
    const el = await waitFor(look.selector, o.waitMs ?? WAIT_MS);
    if (!el) continue;
    el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    const ring = document.createElement("div");
    ring.setAttribute("data-el", "core-look");
    ring.style.cssText = `position:fixed;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:2px solid hsl(var(--primary, 217 91% 60%));border-radius:8px;box-shadow:0 0 0 4px hsl(var(--primary, 217 91% 60%) / .25);pointer-events:none;z-index:9999;animation:vc-look-pulse 1.2s ease-in-out 3`;
    const label = document.createElement("div");
    label.setAttribute("data-el", "core-look-label");
    label.textContent = `New: ${look.text}`;
    const below = r.bottom + 40 < window.innerHeight;
    label.style.cssText = `position:fixed;left:${Math.max(8, Math.min(r.left, window.innerWidth - 328))}px;top:${below ? r.bottom + 8 : Math.max(8, r.top - 36)}px;max-width:320px;padding:4px 8px;border-radius:6px;font-size:12px;line-height:1.35;background:hsl(var(--primary, 217 91% 60%));color:hsl(var(--primary-foreground, 0 0% 100%));pointer-events:none;z-index:9999;box-shadow:0 4px 14px rgba(0,0,0,.25)`;
    marks.push(ring, label);
  }
  if (!marks.length) return 0;
  if (!document.getElementById("vc-look-style")) {
    const st = document.createElement("style");
    st.id = "vc-look-style";
    st.textContent = "@keyframes vc-look-pulse{0%,100%{opacity:1}50%{opacity:.35}}";
    document.head.appendChild(st);
  }
  for (const m of marks) document.body.appendChild(m);
  const clear = () => {
    for (const m of marks) m.remove();
    window.removeEventListener("pointerdown", clear, true);
  };
  window.addEventListener("pointerdown", clear, true);
  setTimeout(clear, o.ms ?? POINT_MS);
  return marks.length / 2;
}
