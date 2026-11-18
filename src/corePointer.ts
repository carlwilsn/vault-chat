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

// ---------------------------------------------------------------- trial mode: an aura while a change is tried

const AURA_ID = "vc-trial-aura";
const FRAME_ID = "vc-trial-frame";
/** The trial colour (accent purple), the same in light and dark. */
const AURA = "270 85% 66%";

/** A selector CSS can take as it is (a bad one would void the whole rule). */
function validSelector(s: string): boolean {
  try {
    document.createDocumentFragment().querySelector(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * While a change is tried: every element it touches (`selectors`, the commits' Look selectors) glows with a soft,
 * gently pulsing outline, so Carl sees what is not committed yet; a change with no element to name gets the glow
 * around the whole window frame. A stylesheet, not marks on elements: an element drawn again keeps its glow.
 * Returns the undo (Keep, Discard and Back clear it).
 */
export function trialAura(selectors: readonly string[]): () => void {
  if (typeof document === "undefined") return () => {};
  clearTrialAura();
  const ok = selectors.filter(validSelector).slice(0, 8);
  const style = document.createElement("style");
  style.id = AURA_ID;
  const pulse = `@keyframes vc-trial-pulse{0%,100%{box-shadow:0 0 0 2px hsl(${AURA} / .9),0 0 14px 3px hsl(${AURA} / .45)}50%{box-shadow:0 0 0 2px hsl(${AURA} / .55),0 0 6px 1px hsl(${AURA} / .2)}}`;
  if (ok.length) {
    // An outline, not a shadow: the element's own box-shadow (its focus ring, a card's depth) stays as it is.
    const glow = `@keyframes vc-trial-glow{0%,100%{outline-color:hsl(${AURA} / .95)}50%{outline-color:hsl(${AURA} / .35)}}`;
    style.textContent = `${pulse}\n${glow}\n${ok.join(",\n")}{outline:2px solid hsl(${AURA}) !important;outline-offset:3px !important;animation:vc-trial-glow 2.4s ease-in-out infinite !important}`;
  } else {
    style.textContent = `${pulse}\n#${FRAME_ID}{position:fixed;inset:0;pointer-events:none;z-index:9998;border-radius:0;animation:vc-trial-pulse 2.4s ease-in-out infinite}`;
    const frame = document.createElement("div");
    frame.id = FRAME_ID;
    frame.setAttribute("data-el", "trial-frame");
    document.body.appendChild(frame);
  }
  document.head.appendChild(style);
  return clearTrialAura;
}

export function clearTrialAura(): void {
  if (typeof document === "undefined") return;
  document.getElementById(AURA_ID)?.remove();
  document.getElementById(FRAME_ID)?.remove();
}
