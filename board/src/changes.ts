// Change ready on the iPad board (reports/07 corrected model point 4; the laptop's is src/ChangeReadyNotice.tsx, the
// phone's phone/src/changes.ts). The drafts waiting for Carl come from the box (src/changeCards.ts); his word goes
// through the same supervisor route, so a Keep or Discard here clears the card on the laptop and the phone too.
//
// The board runs no plugins, so nothing can be tried here: Keep / Discard, and the card says where it can be tried
// (the laptop, the phone) or that the box applies it. A floating card at the top right, over the list or a board,
// iPadOS-styled like the inbox sheet; nothing pending: no element at all. The board turned off: its line, no card.
import { changeTitle, startChangeCards, type BoxPendingChange, type ChangeCards } from "../../src/changeCards";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const key = (c: BoxPendingChange) => `${c.plugin}@${c.version}`;

const BTN = "h-10 rounded-full px-4 text-subhead font-semibold transition active:scale-[0.97] disabled:opacity-50";

/** Where else it can be tried, said on the card. */
function where(c: BoxPendingChange): string {
  const on = c.tryOn.filter((s) => s !== "board");
  if (!on.length) return "The box applies this, so it can't be tried first. Keep sets it; Switch back undoes it.";
  return `Try it on the ${on.map((s) => (s === "laptop" ? "laptop" : "phone")).join(" or the ")}, or keep or discard it from here.`;
}

export type BoardChangeDeps = {
  /** The box with the board's auth and vault (board/src/api.ts fetchBox). */
  api: (path: string, init?: RequestInit) => Promise<Response>;
  /** The board's one /poll feed (board/src/inbox.ts onFeed): each record, null after a resync. */
  onFeed: (fn: (rec: unknown) => void) => () => void;
  /** The board's log (board/src/log.ts). */
  blog?: (ev: string, data?: Record<string, unknown>) => void;
  root?: HTMLElement;
  everyMs?: number;
  visible?: () => boolean;
};

export function startBoardChanges(d: BoardChangeDeps): { cards: ChangeCards; stop(): void } {
  const cards = startChangeCards({ api: d.api, surface: "board", ...(d.everyMs ? { everyMs: d.everyMs } : {}), ...(d.visible ? { visible: d.visible } : {}) });
  const blog = d.blog ?? (() => {});
  const later = new Set<string>();
  let el: HTMLElement | null = null;
  const root = () => d.root ?? document.body;

  function draw() {
    const list = cards.list();
    const shown = cards.off() ? null : (list.find((c) => !later.has(key(c))) ?? null);
    const o = cards.outcome();
    if (!shown && !o) {
      el?.remove();
      el = null;
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.setAttribute("data-el", "change-ready");
      el.className =
        "material hairline shadow-sheet fixed right-[max(16px,env(safe-area-inset-right))] top-[calc(max(12px,env(safe-area-inset-top))+64px)] z-50 w-[min(360px,calc(100%-32px))] overflow-hidden rounded-[18px] text-sys-label animate-pop-in";
      el.addEventListener("click", onClick);
      root().appendChild(el);
      if (shown) blog("change.shown", { plugin: shown.plugin, version: shown.version, n: list.length });
    }
    const busy = cards.busy() ? " disabled" : "";
    let h = "";
    if (shown) {
      const more = list.length > 1 ? ` · ${list.length - 1} more` : "";
      h += `<div class="flex items-start gap-2 px-4 pt-3.5">
        <div class="min-w-0 flex-1">
          <div class="text-subhead font-semibold leading-snug" data-el="change-ready-title">${esc(changeTitle(shown))}</div>
          <div class="mt-0.5 truncate font-mono text-[12px] text-sys-secondary/70">${esc(shown.name)} · ${esc(shown.version)}${esc(more)}</div>
        </div>
        <button data-a="later" class="-mr-1.5 -mt-1 grid h-8 w-8 place-items-center rounded-full text-[20px] leading-none text-sys-secondary/70 active:bg-sys-fill/20" aria-label="Later">×</button>
      </div>
      <div class="px-4 pt-2 text-footnote leading-snug text-sys-secondary" data-el="change-direct">${esc(where(shown))}</div>
      <div class="flex gap-2 px-4 pb-3.5 pt-3">
        <button data-a="keep" data-el="change-keep" class="${BTN} flex-1 bg-sys-blue text-white"${busy}>Keep</button>
        <button data-a="discard" data-el="change-discard" class="${BTN} bg-sys-fill/15 text-sys-blue"${busy}>Discard</button>
      </div>`;
    }
    if (o) {
      h += `<div data-el="change-outcome" class="flex items-start gap-2 px-4 py-2.5 text-footnote ${shown ? "border-t border-sys-separator/20" : ""} ${o.ok ? "text-sys-secondary" : "text-[rgb(var(--sys-red))]"}">
        <span class="min-w-0 flex-1 break-words">${esc(o.name)}: ${esc(o.text)}</span>
        ${o.kept ? `<button data-a="switch" data-el="change-switch-back" class="shrink-0 font-semibold text-sys-blue">Switch back</button>` : ""}
        <button data-a="dismiss" class="-my-1 -mr-1.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[18px] leading-none text-sys-secondary/70" aria-label="Dismiss">×</button>
      </div>`;
    }
    el.innerHTML = h;
    el.dataset.plugin = shown?.plugin ?? "";
    el.dataset.version = shown?.version ?? "";
  }

  function onClick(e: Event) {
    const b = (e.target as HTMLElement).closest("button[data-a]") as HTMLButtonElement | null;
    if (!b || b.disabled || !el) return;
    const a = b.dataset.a;
    if (a === "dismiss") return cards.clearOutcome();
    if (a === "switch") {
      const o = cards.outcome();
      if (o) void cards.decide(o.plugin, "switch");
      return;
    }
    const shown = cards.list().find((c) => c.plugin === el!.dataset.plugin && c.version === el!.dataset.version);
    if (!shown) return;
    if (a === "later") {
      later.add(key(shown));
      return draw();
    }
    if (a === "keep" || a === "discard") {
      blog("change.word", { plugin: shown.plugin, version: shown.version, change: a });
      void cards.decide(shown.plugin, a, shown.version);
    }
  }

  const offDraw = cards.subscribe(draw);
  const offFeed = d.onFeed((rec) => (rec === null ? cards.refresh() : cards.record(rec)));
  return {
    cards,
    stop() {
      offDraw();
      offFeed();
      cards.stop();
      el?.remove();
      el = null;
    },
  };
}
