// The board list, Freeform-style: a large title, a grid of 4:3 thumbnails
// (the board's overview, or drawn from its ink), the name under each and when
// it changed; "New board" is the first tile. Long-press a tile for Rename and
// Delete (Delete asks first; the box moves the board to boards/.trash).
import { contentBounds } from "../../src/boardFormat";
import * as api from "./api";
import { icon } from "./icons";
import { drawItem, drawStroke } from "./ink";
import { blog } from "./log";

/** The last pointer's kind (the name dialog logs what opened it: a finger, the Pencil, a mouse). */
let lastPointer = "";
if (typeof document !== "undefined") document.addEventListener("pointerdown", (e) => (lastPointer = e.pointerType), true);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

const TILE = "relative block aspect-[4/3] w-full overflow-hidden rounded-[14px] bg-white shadow-tile transition duration-200 ease-ios group-active:scale-[0.97]";

export function renderList(root: HTMLElement, open: (slug: string) => void): void {
  root.innerHTML = `
    <div data-scroll class="absolute inset-0 overflow-y-auto bg-sys-grouped px-[max(32px,env(safe-area-inset-left))] pb-16 pt-[max(28px,env(safe-area-inset-top))]">
      <header class="mx-auto mb-6 mt-4 flex max-w-[1180px] items-end justify-between">
        <h1 class="font-display text-large font-bold tracking-tight text-sys-label">Boards</h1>
      </header>
      <div class="boards mx-auto grid max-w-[1180px] grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-7 gap-y-8">
        <p class="col-span-full text-subhead text-sys-secondary/60">Loading…</p>
      </div>
    </div>`;
  const grid = root.querySelector(".boards") as HTMLElement;
  const newTile = `
    <button data-act="new" class="group text-left">
      <span class="${TILE.replace("bg-white", "")} grid place-items-center bg-sys-fill/10 shadow-none ring-1 ring-inset ring-sys-separator/20">
        <span class="grid h-14 w-14 place-items-center rounded-full bg-sys-blue text-white shadow-float">${icon("plus", 28)}</span>
      </span>
      <span class="mt-2.5 block text-subhead font-semibold text-sys-blue">New board</span>
      <span class="block text-footnote text-sys-secondary/60">&nbsp;</span>
    </button>`;
  const paint = () =>
    api
      .listBoards()
      .then((boards) => {
        grid.innerHTML =
          newTile +
          boards
            .map(
              (b) => `
          <button class="card group text-left" data-slug="${esc(b.slug)}">
            <span class="${TILE} thumb">${b.strokes || b.items ? `<img alt="" loading="lazy" class="absolute inset-0 h-full w-full object-contain" src="${esc(api.overviewUrl(b.slug, b.updated))}">` : ""}</span>
            <span class="mt-2.5 block truncate text-subhead font-semibold text-sys-label">${esc(b.name)}</span>
            <span class="block text-footnote text-sys-secondary/60">${b.strokes || b.items ? ago(b.updated) : "Empty"}</span>
          </button>`,
            )
            .join("");
        grid.querySelector('[data-act="new"]')!.addEventListener("click", () => newBoard(root, open));
        grid.querySelectorAll<HTMLElement>(".card").forEach((c) => {
          const b = boards.find((x) => x.slug === c.dataset.slug)!;
          longPress(c, () => menu(root, c, b.slug, b.name, paint), () => open(b.slug));
          const img = c.querySelector("img");
          // No overview yet (an older board, never opened since): draw it from its ink.
          img?.addEventListener("error", () => {
            img.remove();
            void drawThumb(c.querySelector(".thumb") as HTMLElement, b.slug);
          });
        });
      })
      .catch((e) => {
        grid.innerHTML =
          e instanceof api.HttpError && e.status === 401
            ? `<p class="col-span-full text-subhead text-sys-secondary/70"><b class="text-sys-label">Not signed in to the box.</b> Open this page over Tailscale, or once from the phone link in vault-chat Settings.</p>`
            : `<p class="col-span-full text-subhead text-sys-secondary/70">Couldn't reach the box: ${esc(String(e?.message ?? e))}</p>`;
      });
  void paint();
}

/** A tap opens; holding 450 ms (without moving) opens the menu instead. */
function longPress(el: HTMLElement, onLong: () => void, onTap: () => void): void {
  let t = 0, fired = false, x = 0, y = 0;
  el.addEventListener("pointerdown", (e) => {
    fired = false;
    x = e.clientX;
    y = e.clientY;
    t = window.setTimeout(() => {
      fired = true;
      navigator.vibrate?.(10);
      onLong();
    }, 450);
  });
  el.addEventListener("pointermove", (e) => {
    if (Math.hypot(e.clientX - x, e.clientY - y) > 8) clearTimeout(t);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(ev, () => clearTimeout(t));
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    clearTimeout(t);
    if (!fired) {
      fired = true;
      onLong();
    }
  });
  el.addEventListener("click", (e) => {
    if (fired) {
      e.preventDefault();
      fired = false;
      return;
    }
    onTap();
  });
}

/** The tile's menu: Rename, Delete (confirmed). */
function menu(root: HTMLElement, tile: HTMLElement, slug: string, name: string, repaint: () => void): void {
  const r = tile.querySelector(".thumb")!.getBoundingClientRect();
  const scrim = document.createElement("div");
  scrim.className = "fixed inset-0 z-40 bg-black/20 animate-fade-in";
  const m = document.createElement("div");
  m.className = "material hairline shadow-pop fixed z-50 w-[250px] overflow-hidden rounded-[14px] text-body text-sys-label animate-pop-in";
  m.style.left = `${Math.min(window.innerWidth - 262, Math.max(12, r.left + r.width / 2 - 125))}px`;
  m.style.top = `${Math.min(window.innerHeight - 140, r.bottom + 10)}px`;
  const row = "flex h-12 w-full items-center justify-between px-4 text-left active:bg-sys-fill/20";
  m.innerHTML = `
    <button data-m="rename" class="${row}">Rename<span class="text-sys-secondary/60">${icon("pencil-simple", 20)}</span></button>
    <div class="h-px bg-sys-separator/20"></div>
    <button data-m="delete" class="${row} text-[rgb(var(--sys-red))]">Delete<span>${icon("trash", 20)}</span></button>`;
  const done = () => {
    scrim.remove();
    m.remove();
  };
  scrim.addEventListener("click", done);
  root.append(scrim, m);
  m.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    done();
    if (b.dataset.m === "rename") nameDialog(root, "Rename board", name, "Rename", (v) => api.renameBoard(slug, v).then(repaint));
    else confirmDelete(root, name, () => api.deleteBoard(slug).then(repaint));
  });
}

/**
 * An iOS alert-style dialog with one text field. The field is focused in the tap that opened it (New board, Rename)
 * and is fully visible when it is: the scrim fades in beside it, never around it, and the alert only slides. Until
 * v0.6.46 the whole dialog faded in from opacity 0, so the field was focused while transparent — iOS treats that as
 * a hidden field and raises no keyboard, and a tap on the field, already focused, changes no focus to raise it.
 */
function nameDialog(root: HTMLElement, title: string, value: string, action: string, submit: (v: string) => Promise<unknown>): void {
  const dlg = document.createElement("div");
  dlg.className = "name-dialog fixed inset-0 z-50 grid place-items-center p-4";
  dlg.innerHTML = `
    <div data-scrim class="absolute inset-0 bg-black/25 animate-fade-in"></div>
    <form class="material relative w-[min(340px,100%)] overflow-hidden rounded-[14px] text-center shadow-pop animate-lift-in">
      <div class="px-4 pb-4 pt-5">
        <div class="text-body font-semibold text-sys-label">${esc(title)}</div>
        <input name="name" type="text" inputmode="text" autocomplete="off" autocapitalize="sentences" enterkeyhint="done" maxlength="120" value="${esc(value)}"
          class="mt-3 h-10 w-full rounded-[10px] border-0 bg-card px-3 text-body text-sys-label outline-none ring-1 ring-sys-separator/30 focus:ring-2 focus:ring-sys-blue">
        <p class="err mt-2 hidden text-footnote text-[rgb(var(--sys-red))]"></p>
      </div>
      <div class="grid grid-cols-2 border-t border-sys-separator/25">
        <button type="button" data-act="cancel" class="h-11 text-body text-sys-blue active:bg-sys-fill/20">Cancel</button>
        <button type="submit" class="h-11 border-l border-sys-separator/25 text-body font-semibold text-sys-blue active:bg-sys-fill/20 disabled:opacity-40">${esc(action)}</button>
      </div>
    </form>`;
  root.appendChild(dlg);
  const input = dlg.querySelector("input")!;
  // Synchronously, still inside the opening tap's gesture: iOS raises the keyboard only for a focus made there.
  input.focus();
  input.select();
  // Carl's iPad (v0.6.47, 2026-10-18): the keyboard still did not come up, and nothing logged why. The board's log
  // now says how the dialog was opened, whether the field took focus and whether a keyboard appeared (the visual
  // viewport shrinks when it does; a hardware keyboard shows none). And a tap on the field always raises it: a
  // field focused without a keyboard is blurred and focused again inside the tap (a focus change in a gesture).
  const kind = action === "Create" ? "new" : "rename";
  const how = lastPointer;
  const focused = document.activeElement === input;
  const ih = window.innerHeight;
  const vv = () => Math.round(window.visualViewport?.height ?? ih);
  const keyboardUp = () => vv() < ih * 0.85;
  setTimeout(() => {
    if (dlg.isConnected) blog("dialog", { what: kind, how, focused, field: document.activeElement === input, keyboard: keyboardUp(), vvh: vv(), ih });
  }, 900);
  let retaps = 0;
  input.addEventListener("touchend", () => {
    if (keyboardUp()) return;
    retaps++;
    input.blur();
    input.focus();
    setTimeout(() => blog("dialog.tap", { what: kind, n: retaps, field: document.activeElement === input, keyboard: keyboardUp(), vvh: vv(), ih }), 900);
  });
  dlg.querySelector('[data-act="cancel"]')!.addEventListener("click", () => dlg.remove());
  dlg.querySelector("form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return input.focus();
    const btn = dlg.querySelector('button[type="submit"]') as HTMLButtonElement;
    btn.disabled = true;
    submit(v)
      .then(() => dlg.remove())
      .catch((err) => {
        btn.disabled = false;
        const p = dlg.querySelector(".err") as HTMLElement;
        p.textContent = String(err?.message ?? err);
        p.classList.remove("hidden");
      });
  });
}

function confirmDelete(root: HTMLElement, name: string, yes: () => Promise<unknown>): void {
  const dlg = document.createElement("div");
  dlg.className = "fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 animate-fade-in";
  dlg.innerHTML = `
    <div class="material w-[min(300px,100%)] overflow-hidden rounded-[14px] text-center shadow-pop animate-rise-in">
      <div class="px-4 pb-4 pt-5">
        <div class="text-body font-semibold text-sys-label">Delete “${esc(name)}”?</div>
        <div class="mt-1 text-footnote text-sys-secondary/70">It moves to the board trash on the box.</div>
      </div>
      <div class="grid grid-cols-2 border-t border-sys-separator/25">
        <button data-a="no" class="h-11 text-body text-sys-blue active:bg-sys-fill/20">Cancel</button>
        <button data-a="yes" class="h-11 border-l border-sys-separator/25 text-body font-semibold text-[rgb(var(--sys-red))] active:bg-sys-fill/20">Delete</button>
      </div>
    </div>`;
  root.appendChild(dlg);
  dlg.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    if (b.dataset.a === "yes") void yes().finally(() => dlg.remove());
    else dlg.remove();
  });
}

function newBoard(root: HTMLElement, open: (slug: string) => void): void {
  const today = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
  nameDialog(root, "New board", `Board · ${today}`, "Create", (v) => api.createBoard(v).then((r) => open(r.slug)));
}

/** A thumbnail drawn here from the board's ink (items as their placeholders): the content, fitted. */
async function drawThumb(box: HTMLElement, slug: string): Promise<void> {
  try {
    const board = await api.getBoard(slug);
    const b = contentBounds(board);
    if (!b) return;
    const r = box.getBoundingClientRect();
    const d = Math.min(2, window.devicePixelRatio || 1);
    const c = document.createElement("canvas");
    c.width = Math.round(r.width * d);
    c.height = Math.round(r.height * d);
    c.className = "absolute inset-0 h-full w-full";
    const pad = 20, w = b.x1 - b.x0 + pad * 2, h = b.y1 - b.y0 + pad * 2;
    const s = Math.min(c.width / w, c.height / h);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(s, 0, 0, s, (c.width - w * s) / 2 + (pad - b.x0) * s, (c.height - h * s) / 2 + (pad - b.y0) * s);
    for (const it of board.items) drawItem(ctx, it, null);
    for (const st of board.strokes) drawStroke(ctx, st, 1.2 / s);
    box.appendChild(c);
  } catch {
    /* no thumbnail */
  }
}
