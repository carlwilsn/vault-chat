// A core swap loads every window on purpose (src/coreSwap.ts, src/coreFollow.ts): nothing may ask "Reload site?" then.
// The window's own leave guard (src/linkNav.ts) stands aside while the hold is on. A framed page (a web page or the
// preview harness, itself a vault-chat copy, in a viewer pane; an inline chat page) may have a beforeunload of its own
// that the app can't reach (another origin); Chromium asks for it on the window's load all the same. So the hold also
// takes every frame out of the document (a frame that is removed gets no beforeunload), leaving a box of the same
// place and size, so nothing on the screen moves. A swap that did not start puts the frames back (releaseSwapHold).
// No dependencies: a chat popout loads it too.

type Kept = { frame: Element; box: HTMLElement };
let kept: Kept[] = [];

const win = (): (Window & { __vcCoreSwapping?: boolean }) | null => (typeof window !== "undefined" ? (window as Window & { __vcCoreSwapping?: boolean }) : null);

/** A core swap is loading this window. */
export const swapHeld = (): boolean => !!win()?.__vcCoreSwapping;

/** The swap's load is next: the leave guard stands aside and every frame leaves the document (a still box in its
 *  place). Returns how many frames it took out. */
export function holdForSwap(): number {
  const w = win();
  if (!w) return 0;
  w.__vcCoreSwapping = true;
  if (typeof document === "undefined") return 0;
  let n = 0;
  for (const frame of [...document.querySelectorAll("iframe, embed, object")]) {
    const parent = frame.parentNode;
    if (!parent) continue;
    const box = document.createElement("div");
    const cls = frame.getAttribute("class");
    if (cls) box.setAttribute("class", cls);
    const style = frame.getAttribute("style");
    if (style) box.setAttribute("style", style);
    try {
      const r = frame.getBoundingClientRect();
      const cs = getComputedStyle(frame);
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      box.style.display = cs.display === "inline" ? "inline-block" : cs.display;
    } catch {
      /* no layout: the frame's own class and style */
    }
    box.dataset.vcSwapFrame = "";
    parent.replaceChild(box, frame);
    kept.push({ frame, box });
    n++;
  }
  return n;
}

/** The swap did not start: the frames go back where they were and the leave guard is on again. */
export function releaseSwapHold(): void {
  const w = win();
  if (w) w.__vcCoreSwapping = false;
  for (const { frame, box } of kept) box.parentNode?.replaceChild(frame, box);
  kept = [];
}
