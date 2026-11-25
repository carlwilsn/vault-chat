// dragging a chat (from a chats list) or a tile (by its header) to the tile area.
// A pointer drag like the file tree's (src/dnd.ts treeDrag): the area (src/TileArea.tsx) watches where the pointer is
// to draw its drop preview, and takes the drop. A plain click stays a click (the drag starts after a few pixels).
/** newChat: "+ New chat", a project's "+" or a project row dragged out: a new chat in `place` ("main" or a project's
 *  slug) where it is dropped. */
export type TileDragWhat = { kind: "chat"; chatId: string; title: string } | { kind: "tile"; tileId: string; title: string } | { kind: "newChat"; place: string; title: string };
export type TileDragPoint = { what: TileDragWhat; x: number; y: number };

let now: TileDragPoint | null = null;
const subs = new Set<() => void>();
const drops = new Set<(d: TileDragPoint) => boolean>();
export const tileDrag = {
  current: () => now,
  subscribe(f: () => void): () => void {
    subs.add(f);
    return () => void subs.delete(f);
  },
  onDrop(h: (d: TileDragPoint) => boolean): () => void {
    drops.add(h);
    return () => void drops.delete(h);
  },
};
function move(d: TileDragPoint | null): void {
  now = d;
  for (const f of subs) f();
}

const THRESHOLD = 5;

// The drag's subscribers live in this module: a hot update of it alone would leave the tile area listening to the old
// copy (no preview at all). In the dev preview, an edit here reloads the page instead.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());

/** The kind icons (lucide's file-text, message-square, sticky-note, settings), as markup: the pill lives on <body>. */
const ICONS: Record<string, string> = {
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  notes: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
};
/** Where the cursor holds the pill when nothing says better (it is centred on the cursor then, once measured). */
const PILL_OX = 12, PILL_OY = 13;
/** The pill's label starts this far in from its left edge (padding 8 + icon 14 + gap 6). */
const PILL_LABEL_X = 28;

/** The label in what was grabbed (a tile's name in its top row, a list row's text), to build the pill over it: the
 *  title's own text (a file's name at the end of its breadcrumb, a chat's title, a project's name) where it is drawn. */
function labelIn(from: Element | null | undefined, title: string): DOMRect | null {
  if (!from) return null;
  const root = from.querySelector("[data-tile-head]") ?? from;
  const want = [title, title.replace(/\.md$/, ""), title.replace(/^New chat in /, "")].map((t) => t.trim()).filter(Boolean);
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = n.textContent ?? "";
    for (const w of want) {
      const i = text.lastIndexOf(w);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + w.length);
      const r = range.getBoundingClientRect();
      if (r.width) return r;
    }
  }
  return null;
}

/** The drag image for every drag (a tile by its top row, a chat row): one small rounded chip, kind icon and
 *  title (truncated at 240 px), held by its left part; the file tree's chip (filetree/Tree.tsx DragGhost) is the same
 *  look. Never a copy of the tile (Carl 11-24): what is under the cursor stays visible, the snap preview says where it
 *  lands. Inline styles only: it lives on <body>, outside the app. */
function makePill(title: string, kind: string): { el: HTMLDivElement; ox: number; oy: number } {
  const el = document.createElement("div");
  el.dataset.el = "tile-drag-ghost";
  el.dataset.ghost = "pill";
  el.style.cssText = [
    "position:fixed;left:0;top:0;z-index:1000;pointer-events:none;box-sizing:border-box",
    "max-width:240px;height:26px;padding:0 10px 0 8px;display:flex;align-items:center;gap:6px",
    "background:hsl(var(--popover));color:hsl(var(--popover-foreground));font-size:12.5px;font-weight:500;line-height:16px;white-space:nowrap",
    "border:1px solid hsl(var(--border));border-radius:7px;box-shadow:0 6px 16px rgba(0,0,0,0.28), 0 1px 3px rgba(0,0,0,0.18)",
    "will-change:transform,opacity",
  ].join(";");
  const icon = document.createElement("span");
  icon.style.cssText = "flex:none;display:flex;opacity:0.7";
  icon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind] ?? ICONS.file}</svg>`;
  const label = document.createElement("span");
  label.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis";
  label.textContent = title.replace(/\.md$/, "");
  el.append(icon, label);
  return { el, ox: PILL_OX, oy: PILL_OY };
}

/** Start watching a press: past a few pixels it becomes a drag of `what`, shown by the pill (makePill). `from`: the
 *  grabbed element (a tile: its data-tile-kind names the pill's icon). */
export function pressToDrag(e: { clientX: number; clientY: number; pointerId: number; button: number }, what: TileDragWhat, from?: Element | null): void {
  if (e.button !== 0) return;
  const start = { x: e.clientX, y: e.clientY };
  const kind = what.kind === "tile" ? ((from as HTMLElement | null | undefined)?.dataset?.tileKind ?? "file") : "chat";
  let dragging = false;
  let shield: HTMLDivElement | null = null;
  let ghost: ReturnType<typeof makePill> | null = null;
  // Esc during a drag: it is called off (nothing drops); the shield stays until the button comes up, so the release
  // clicks nothing underneath.
  let cancelled = false;
  const onKey = (k: KeyboardEvent) => {
    if (k.key !== "Escape" || !dragging || cancelled) return;
    k.preventDefault();
    k.stopImmediatePropagation();
    cancelled = true;
    if (frame) cancelAnimationFrame(frame), (frame = 0);
    move(null);
    const g = ghost;
    ghost = null;
    if (g) (g.el.style.transition = "opacity 120ms ease-in"), (g.el.style.opacity = "0"), setTimeout(() => g.el.remove(), 140);
  };
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId || cancelled) return;
    // The button came up where this window never heard it (let go outside the window, or the window lost focus
    // mid-drag): the drag is called off, so no pill or shield is left behind blocking the app.
    if (ev.pointerType === "mouse" && ev.buttons === 0) return end(ev, false);
    if (!dragging) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < THRESHOLD) return;
      dragging = true;
      shield = document.createElement("div");
      shield.dataset.dragShield = "1";
      shield.style.cssText = "position:fixed;inset:0;z-index:999;cursor:grabbing;user-select:none;";
      document.body.appendChild(shield);
      ghost = makePill(what.title, kind);
      document.body.appendChild(ghost.el);
      // Built over what was grabbed (Carl 11-24: "it should stay connected there"): its label over the grabbed label,
      // the cursor where it was on it (kept inside the pill); grabbed off the label, the pill centred on the cursor.
      const pw = ghost.el.offsetWidth || 160, ph = ghost.el.offsetHeight || 26;
      const lab = labelIn(from, what.title);
      const inside = lab && start.x >= lab.left - PILL_LABEL_X && start.x <= lab.left - PILL_LABEL_X + pw && start.y >= lab.top - 4 && start.y <= lab.bottom + 4;
      if (lab && inside) {
        ghost.ox = Math.min(pw - 6, Math.max(6, start.x - (lab.left - PILL_LABEL_X)));
        ghost.oy = Math.min(ph - 4, Math.max(4, start.y - (lab.top + lab.height / 2 - ph / 2)));
      } else (ghost.ox = pw / 2), (ghost.oy = ph / 2);
      last = { x: ev.clientX, y: ev.clientY };
      place();
    }
    // 1:1 with the pointer: the image is placed once a frame, at the newest point.
    last = { x: ev.clientX, y: ev.clientY };
    if (!frame) frame = requestAnimationFrame(place);
    move({ what, x: ev.clientX, y: ev.clientY });
  };
  let last = start;
  let frame = 0;
  const place = () => {
    frame = 0;
    if (ghost) ghost.el.style.transform = `translate3d(${last.x - ghost.ox}px, ${last.y - ghost.oy}px, 0)`;
  };
  const end = (ev: PointerEvent, commit: boolean) => {
    if (ev.pointerId !== e.pointerId) return;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", blur);
    if (!dragging) return;
    if (cancelled) commit = false;
    shield?.remove();
    if (frame) cancelAnimationFrame(frame), (frame = 0);
    const g = ghost;
    move(null);
    // The click this release makes is not a click on the row.
    const eat = (c: MouseEvent) => (c.stopPropagation(), c.preventDefault());
    window.addEventListener("click", eat, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", eat, true), 0);
    if (commit) for (const h of drops) if (h({ what, x: ev.clientX, y: ev.clientY })) break;
    if (!g) return;
    // The drop: the pill glides from where it was let go to the top-left of the place the tile took (a chat: the new
    // tile's) and fades there (160 ms), while the tile fades back in from its dimmed state (App.css [data-lifted]).
    // Dropped nowhere (or nothing took it): it just fades where it is.
    requestAnimationFrame(() => {
      const sel = what.kind === "tile" ? `[data-tile="${what.tileId}"]` : what.kind === "chat" ? `[data-chat-tile="${CSS.escape(what.chatId)}"]` : null;
      const to = commit && sel ? document.querySelector(sel)?.getBoundingClientRect() : undefined;
      g.el.style.transition = "transform 160ms ease-out, opacity 160ms ease-in";
      if (to && to.width) g.el.style.transform = `translate3d(${to.left + 8}px, ${to.top + 6}px, 0)`;
      g.el.style.opacity = "0";
      setTimeout(() => g.el.remove(), 180);
    });
  };
  const up = (ev: PointerEvent) => end(ev, true);
  const cancel = (ev: PointerEvent) => end(ev, false);
  const blur = () => end(new PointerEvent("pointercancel", { pointerId: e.pointerId, clientX: last.x, clientY: last.y }), false);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", blur);
}

/**
 * Chats lists (the chat panel's Chats overlay, full-screen chat's sidebar): a chat row dragged out is a chat tile.
 * One listener on the document, so every list (the plugin's and its fallback) drags the same way.
 */
export function startChatRowDrag(titleOf: (id: string) => string): () => void {
  const down = (e: PointerEvent) => {
    const t = e.target as Element | null;
    // "+ New chat", a project's "+", a project's row: dragged out, a new chat there (a click stays a click).
    const plus = t?.closest?.<HTMLElement>('[data-el="chats-new-chat"], [data-el="place-new-chat"][data-place]');
    const project = !plus && !t?.closest?.('[data-el="project-menu-list"]') ? t?.closest?.<HTMLElement>('[data-el="thread-project"][data-thread]') : null;
    if (plus || project) {
      const thread = plus?.dataset.place ?? project?.dataset.thread ?? "";
      const slug = thread.startsWith("project-") ? thread.slice("project-".length) : null;
      const name = project?.querySelector('[data-el="place-toggle"] span.truncate')?.textContent?.trim();
      return pressToDrag(e, { kind: "newChat", place: slug ?? "main", title: project && name ? `New chat in ${name}` : "New chat" }, plus ?? project);
    }
    const row = t?.closest?.('[data-el="place-chat"][data-chat], [data-el="thread-main"]') as HTMLElement | null;
    if (!row) return;
    // Main's row: only its name drags (its chevron and + stay buttons).
    if (row.dataset.el === "thread-main" && t?.closest('[data-el="place-chats"], [data-el="place-new"], button:not([data-el="place-toggle"])')) return;
    const id = row.dataset.chat ?? "main";
    pressToDrag(e, { kind: "chat", chatId: id, title: titleOf(id) }, row);
  };
  document.addEventListener("pointerdown", down, true);
  return () => document.removeEventListener("pointerdown", down, true);
}

// ------------------------------------------------------------------ dev only: a drag the preview's recorder can do

/**
 * RecordUI has clicks and keys but no drag. In a dev build, `#tiledrag=<from css>|<to css>|<fx>,<fy>` in the URL drags
 * from the middle of the first element to the point (fx, fy) (fractions of the second's box), slowly, with real
 * pointer events through the same handlers a mouse goes through (an optional `|<ms>` after the point: how long it is
 * held there before the drop, default 900; another `|<ms>`: wait that long before starting). Also `#tilesash=<css>|<dx>,<dy>` drags a sash.
 */
export function startDevDragHook(): () => void {
  if (!import.meta.env.DEV) return () => {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fire = (el: EventTarget, type: string, x: number, y: number) => {
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: type.endsWith("up") ? 0 : 1, isPrimary: true, pointerType: "mouse" } as PointerEventInit;
    el.dispatchEvent(new PointerEvent(type, init));
    const mouse = type.replace("pointer", "mouse");
    if (mouse !== type && mouse !== "mousecancel") el.dispatchEvent(new MouseEvent(mouse, init));
  };
  const glide = async (x0: number, y0: number, x1: number, y1: number) => {
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      const y = y0 + ((y1 - y0) * i) / steps;
      const under = document.elementFromPoint(x, y) ?? document.body;
      fire(under, "pointermove", x, y);
      await sleep(30);
    }
  };
  const run = async () => {
    const h = decodeURIComponent(location.hash.slice(1));
    let m = /^tiledrag=([^|]+)\|([^|]+)\|([\d.]+),([\d.]+)(?:\|(\d+))?(?:\|(\d+))?$/.exec(h);
    if (m) {
      if (m[6]) await sleep(Number(m[6]));
      const from = document.querySelector(m[1]!);
      const to = document.querySelector(m[2]!);
      if (!from || !to) return console.warn("[tiledrag] not found", m[1], m[2]);
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const x0 = a.left + Math.min(40, a.width / 2);
      const y0 = a.top + a.height / 2;
      fire(from, "pointerdown", x0, y0);
      await glide(x0, y0, b.left + b.width * Number(m[3]), b.top + b.height * Number(m[4]));
      await sleep(Number(m[5] ?? 900));
      const x1 = b.left + b.width * Number(m[3]);
      const y1 = b.top + b.height * Number(m[4]);
      fire(document.elementFromPoint(x1, y1) ?? document.body, "pointerup", x1, y1);
      return;
    }
    m = /^tilesash=([^|]+)\|(-?[\d.]+),(-?[\d.]+)$/.exec(h);
    if (m) {
      const sash = document.querySelector(m[1]!);
      if (!sash) return console.warn("[tilesash] not found", m[1]);
      const r = sash.getBoundingClientRect();
      const x0 = r.left + r.width / 2;
      const y0 = r.top + r.height / 2;
      fire(sash, "pointerdown", x0, y0);
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        const x = x0 + (Number(m[2]) * i) / steps;
        const y = y0 + (Number(m[3]) * i) / steps;
        fire(document, "pointermove", x, y);
        await sleep(30);
      }
      fire(document, "pointerup", x0 + Number(m[2]), y0 + Number(m[3]));
    }
  };
  window.addEventListener("hashchange", run);
  // Also when the page opens with one (RecordUI can't change the hash without waiting out the whole drag).
  if (/^#tile(drag|sash)=/.test(location.hash)) void run();
  (window as unknown as { __tileDrag: () => Promise<void> }).__tileDrag = run;
  return () => window.removeEventListener("hashchange", run);
}
