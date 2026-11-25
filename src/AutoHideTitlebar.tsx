// the title bar's right-click menu (one item, "Auto-hide title bar") and the auto-hidden bar. The
// choice is a setting (titleBarAutoHide, src/settingsRecords.ts: box:settings for the agent), so it persists.
//  - Off: the bar as always, in the layout.
//  - On: the bar is out of the layout (the tiles and panels take its room; toggling reflows once). The pointer held at
//    the very top edge (the top 2px, about 150 ms, no button down: never during a tile, divider or selection drag) slides
//    it in OVER the content, nothing moves; it slides away about 300 ms after the pointer leaves it, never while one of
//    its menus is open.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, PanelTopClose } from "lucide-react";
import { ContextMenu, menuItemClass } from "./ui";
import { cn } from "./lib/utils";
import { saveSetting, useSetting } from "./settings";
import { tileDrag } from "./tileDrag";
import { treeDrag } from "./dnd";
import { appHostBackend } from "./hostBackend";

const EDGE = 2;
const HOLD_MS = 150;
const LEAVE_MS = 300;
/** A menu of the bar's (or anything popped from it) is open: the bar stays. */
const menuOpen = () => !!document.querySelector('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-el="titlebar-menu"]');

export function AutoHideTitlebar({ children }: { children: ReactNode }) {
  const on = useSetting("titleBarAutoHide") === true;
  const [shown, setShown] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const over = useRef(false);

  useEffect(() => {
    if (!on) {
      setShown(false);
      return;
    }
    const clear = (r: typeof hold) => r.current && (clearTimeout(r.current), (r.current = null));
    const onMove = (e: PointerEvent) => {
      const atEdge = e.clientY < EDGE && e.buttons === 0 && !tileDrag.current() && !treeDrag.current();
      if (!atEdge) return void clear(hold);
      if (!hold.current) hold.current = setTimeout(() => ((hold.current = null), setShown(true)), HOLD_MS);
    };
    window.addEventListener("pointermove", onMove, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      clear(hold);
      clear(leave);
    };
  }, [on]);

  const scheduleHide = () => {
    if (leave.current) clearTimeout(leave.current);
    leave.current = setTimeout(function tick() {
      leave.current = null;
      if (over.current) return;
      if (menuOpen()) return void (leave.current = setTimeout(tick, LEAVE_MS));
      setShown(false);
    }, LEAVE_MS);
  };

  return (
    <>
      <div
        data-el="titlebar-slot"
        data-autohide={on ? (shown ? "shown" : "hidden") : undefined}
        // On: out of the layout, over the content. Hidden it sits fully above the window with no shadow (nothing shows, no
        // hairline: the tiles' own top edge reads cleaner, and the right-click menu / Settings name the feature); shown it
        // slides down in 120 ms with a soft shadow under it so it reads as floating. The shadow fades with it, so none peeks
        // under the top edge while hidden.
        className={on ? cn("absolute inset-x-0 top-0 z-[70] will-change-transform transition-[transform,box-shadow] [transition-duration:120ms] ease-out", shown ? "translate-y-0 shadow-[0_1px_2px_rgb(0_0_0/0.10),0_8px_20px_-6px_rgb(0_0_0/0.35)]" : "-translate-y-full shadow-none") : "shrink-0"}
        onPointerEnter={() => {
          over.current = true;
          if (leave.current) (clearTimeout(leave.current), (leave.current = null));
        }}
        onPointerLeave={() => {
          over.current = false;
          if (on && shown) scheduleHide();
        }}
        onContextMenu={(e) => {
          // The bar's own controls keep theirs (none today); anywhere else on it, this menu.
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {children}
      </div>
      {menu && (
        <BarMenu
          at={menu}
          on={on}
          onClose={() => {
            setMenu(null);
            if (on && !over.current) scheduleHide();
          }}
        />
      )}
    </>
  );
}

/** The bar's right-click menu: the app's menu (src/ui.tsx ContextMenu), one toggle row: an icon, the name and a muted
 *  hint, a check at the right end when it is on. */
function BarMenu({ at, on, onClose }: { at: { x: number; y: number }; on: boolean; onClose: () => void }) {
  return (
    <ContextMenu at={at} onClose={onClose} data-el="titlebar-menu">
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={on}
        data-offer="box:workspace.autoHideTitleBar"
        data-el="titlebar-autohide"
        className={cn(menuItemClass(), "flex items-start gap-2 pr-2.5")}
        onClick={() => {
          onClose();
          void saveSetting("titleBarAutoHide", !on).then((err) => err && appHostBackend.notify(`Couldn't change it: ${err}`, "error"));
        }}
      >
        <PanelTopClose className="h-3.5 w-3.5 mt-px shrink-0 text-muted-foreground" />
        <span className="flex flex-col gap-0.5 min-w-0">
          <span>Auto-hide title bar</span>
          <span className="text-[11px] leading-tight text-muted-foreground">Shows when the pointer reaches the top</span>
        </span>
        <Check className={cn("h-3.5 w-3.5 mt-px ml-3 shrink-0 text-foreground", !on && "invisible")} />
      </button>
    </ContextMenu>
  );
}
