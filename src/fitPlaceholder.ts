// A textarea's placeholder on one line at any width: cut to what fits, with an ellipsis. Chromium clips a
// textarea's placeholder but draws no ellipsis (text-overflow does not reach it), and a wrapped placeholder made
// an empty composer two lines tall, cut off, with a scrollbar (Carl, 2026-10-23: "scroll bug").
import { useEffect, useState, type RefObject } from "react";

let canvas: HTMLCanvasElement | null = null;

/** `text` cut (at a word when it can) to fit `width` pixels in `font`, with "…"; as it is when it fits. */
export function fitText(text: string, width: number, measure: (s: string) => number): string {
  if (width <= 0 || measure(text) <= width) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid).trimEnd() + "…") <= width) lo = mid;
    else hi = mid - 1;
  }
  let cut = text.slice(0, lo);
  const space = cut.lastIndexOf(" ");
  if (space > lo * 0.6) cut = cut.slice(0, space);
  cut = cut.replace(/[\s,;:·—-]+$/, "");
  return cut ? `${cut}…` : "…";
}

/** The placeholder for `ref`'s textarea at its current width (re-fitted when it resizes). */
export function useFittedPlaceholder(ref: RefObject<HTMLTextAreaElement | null>, text: string): string {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const cs = getComputedStyle(el);
      const width = el.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0") - 2;
      canvas ??= document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return setShown(text);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      setShown(fitText(text, width, (s) => ctx.measureText(s).width));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
    // The element itself is a dependency: the composer mounts after Settings or the no-box screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current, text]);
  return shown;
}
