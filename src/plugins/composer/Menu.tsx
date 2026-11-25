// The composer's two menus, @ files and / skills (./Composer.tsx), as one popover: a small list just above the
// composer with its left edge at the "@" or "/" that opened it, 28 px rows of an optional icon, a bold name and a dim
// detail on the same line, the selected row filled grey, matched letters at full text colour against the rest at 60%.
// Carl approved the look from the @ mockup (option A) and asked for the / menu to match.
//
// It is placed inside the composer (absolute, in the composer's own coordinates), so it moves with the chat panel by
// construction; the anchor's offset and the clamp to the panel are measured again whenever the composer, the panel
// or the window changes size.
import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { cn } from "../../lib/utils";
import { MENTION_ROWS } from "./mentionMatch";

/** The popover is this wide (narrower in a narrow panel), its rows this tall. */
const MENU_W = 360;
const MENU_ROW = 28;

export type MenuRow = {
  key: string;
  icon?: ReactNode;
  name: ReactNode;
  detail?: ReactNode;
  /** The detail is a folder path: cut from the left, so the nearest folder stays. */
  detailIsPath?: boolean;
  /** The row has matched letters: the rest of its text dims. */
  lit: boolean;
  title?: string;
};

/** Text with the matched letters lit. */
export function Lit({ text, idx }: { text: string; idx: number[] }) {
  if (!idx.length) return <>{text}</>;
  const on = new Set(idx);
  const out: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const hit = on.has(i);
    let j = i;
    while (j < text.length && on.has(j) === hit) j++;
    out.push(hit ? <span key={i} className="mention-hit">{text.slice(i, j)}</span> : text.slice(i, j));
    i = j;
  }
  return <>{out}</>;
}

/** Where the character at `at` sits horizontally inside the textarea (px from its left edge): a mirror of the box's
 *  text up to it, laid out with the same font, padding and wrapping. */
function caretX(el: HTMLTextAreaElement, at: number): number {
  const cs = getComputedStyle(el);
  const m = document.createElement("div");
  for (const k of ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "paddingLeft", "paddingRight", "paddingTop", "borderLeftWidth", "borderRightWidth", "boxSizing", "tabSize", "textIndent"] as const) {
    (m.style as unknown as Record<string, string>)[k] = cs[k];
  }
  Object.assign(m.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", whiteSpace: "pre-wrap", overflowWrap: "break-word", width: `${el.clientWidth + parseFloat(cs.borderLeftWidth || "0") + parseFloat(cs.borderRightWidth || "0")}px` });
  m.textContent = el.value.slice(0, at);
  const mark = document.createElement("span");
  mark.textContent = el.value[at] || "@";
  m.appendChild(mark);
  document.body.appendChild(m);
  const x = mark.offsetLeft - el.scrollLeft;
  m.remove();
  return x;
}

export function ComposerMenu(props: {
  /** "mention" or "skill": its data-el names (`<kind>-picker`, `<kind>-row`). */
  kind: string;
  boxRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** The index in the text of the "@" or "/" it hangs from. */
  start: number;
  rows: MenuRow[];
  idx: number;
  onPick: (i: number) => void;
  onHover: (i: number) => void;
}) {
  const { kind, boxRef, inputRef, start, rows, idx, onPick, onHover } = props;
  const [pos, setPos] = useState<{ left: number; width: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const box = boxRef.current;
      const el = inputRef.current;
      if (!box || !el) return;
      const b = box.getBoundingClientRect();
      const t = el.getBoundingClientRect();
      // Kept inside what can show it: the nearest ancestor that clips (the chat panel, which the split view keeps in the
      // window), else the window. Measured from the same moment as the composer, so the offsets hold when the panel only
      // moves (a window resize can slide it without resizing it, which no ResizeObserver sees).
      let lo = 0;
      let hi = window.innerWidth;
      for (let a = box.parentElement; a; a = a.parentElement) {
        if (getComputedStyle(a).overflowX === "visible") continue;
        ro?.observe(a);
        const r = a.getBoundingClientRect();
        lo = r.left;
        hi = r.right;
        break;
      }
      const width = Math.max(160, Math.min(MENU_W, hi - lo - 16));
      const at = t.left - b.left + caretX(el, start) - 14;
      const left = Math.max(lo + 8 - b.left, Math.min(at, hi - 8 - width - b.left));
      const maxHeight = Math.min(MENTION_ROWS * MENU_ROW + 10, Math.max(120, b.top - 14));
      setPos((p) => (p && p.left === left && p.width === width && p.maxHeight === maxHeight ? p : { left, width, maxHeight }));
    };
    // Again whenever the composer, its parent or the panel that clips it changes size (a sash drag, fullscreen, the
    // window), and a frame after a window resize, once the split view has laid itself out.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place());
    if (ro && boxRef.current) {
      ro.observe(boxRef.current);
      if (boxRef.current.parentElement) ro.observe(boxRef.current.parentElement);
    }
    place();
    let raf = 0;
    const onResize = () => {
      place();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    window.addEventListener("resize", onResize);
    return () => {
      ro?.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [boxRef, inputRef, start]);

  useEffect(() => {
    boxRef.current?.querySelector(`[data-el="${kind}-row"][data-i="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [boxRef, kind, idx]);

  if (!pos) return null;
  return (
    <div className="mention-picker" data-el={`${kind}-picker`} role="listbox" style={{ left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}>
      {rows.map((r, i) => (
        <div
          key={r.key}
          role="option"
          aria-selected={i === idx}
          data-el={`${kind}-row`}
          data-i={i}
          title={r.title}
          className={cn("mention-row", i === idx && "on", r.lit && "lit")}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(i);
          }}
          onMouseEnter={() => onHover(i)}
        >
          {r.icon}
          <span className="mention-name">{r.name}</span>
          {r.detail != null && r.detail !== "" && (
            <span className={cn("mention-dir", r.detailIsPath ? "mention-path" : "mention-desc")}>{r.detailIsPath ? <bdi>{r.detail}</bdi> : r.detail}</span>
          )}
        </div>
      ))}
    </div>
  );
}
