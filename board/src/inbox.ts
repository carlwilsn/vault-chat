// The inbox (board/INBOX.md): what the agent sent, waiting to be added.
// A badge on the top-right icon (unread count, live from the box's /poll
// ring), a sheet sliding in from the right with the entries as cards (title,
// note, parts, time, an unread dot; "being made…" shimmers; "couldn't make"
// says why), and an entry's viewer: PDF pages to scroll, typeset math, the
// image, the widget live in its sandbox. "Add to board" for the whole entry
// or one part; the parts land at the centre of the view, selected.
import type { Entry, EntrySummary, Part } from "../../src/inboxFormat";
import { WIDGET_LAYOUT, MATH_LAYOUT_W } from "../../src/inboxFormat";
import { widgetDocument } from "../../src/widgetHost";
import * as api from "./api";
import { icon, type IconName } from "./icons";
import { ensureMathStyle, fetchText, renderPdfPage } from "./items";

export type InboxHost = {
  /** Add an entry's part (or all of it) to the board; resolves with the new items' ids. */
  add: (id: string, part?: number) => Promise<string[]>;
  closed: () => void;
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const KIND: Record<string, { icon: IconName; tint: string; one: string; many: string }> = {
  pdf: { icon: "file-pdf", tint: "bg-[rgb(255_59_48/0.12)] text-[rgb(var(--sys-red))]", one: "PDF page", many: "PDF pages" },
  math: { icon: "sigma", tint: "bg-sys-blue/15 text-sys-blue", one: "problem", many: "problems" },
  image: { icon: "image-square", tint: "bg-[rgb(52_199_89/0.14)] text-[rgb(var(--sys-green))]", one: "image", many: "images" },
  widget: { icon: "puzzle-piece", tint: "bg-[rgb(175_82_222/0.14)] text-[rgb(175_82_222)]", one: "widget", many: "widgets" },
};

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "3 PDF pages · 5 problems" (a PDF part counts its pages when the entry is known). */
function partsLine(parts: { kind: string; n?: number }[], full?: Part[]): string {
  const n = new Map<string, number>();
  parts.forEach((p, i) => {
    const f = full?.[i];
    n.set(p.kind, (n.get(p.kind) ?? 0) + (f?.kind === "pdf" ? f.pages.length : (p.n ?? 1)));
  });
  return [...n].map(([k, c]) => `${c} ${c === 1 ? KIND[k]?.one ?? k : KIND[k]?.many ?? k}`).join(" · ");
}

// ---------------------------------------------------------------- the live list and the badge

let entries: EntrySummary[] = [];
let unread = 0;
const listeners = new Set<() => void>();
let started = false;
let refreshT = 0;

async function refresh(): Promise<void> {
  try {
    const r = await api.listInbox();
    entries = r.entries;
    unread = r.unread;
  } catch {
    /* offline: keep what we had */
  }
  for (const fn of listeners) fn();
}
function soon(): void {
  clearTimeout(refreshT);
  refreshT = window.setTimeout(() => void refresh(), 150);
}

/** Keep `badge` showing the unread count (the box pushes {type:"inbox"} on /poll). */
export function inboxBadge(badge: HTMLElement): void {
  const paint = () => {
    badge.textContent = unread > 9 ? "9+" : String(unread);
    badge.classList.toggle("hidden", !unread);
  };
  listeners.add(paint);
  paint();
  if (!started) {
    started = true;
    void refresh();
    void api.watch((ev) => {
      if (ev?.type === "inbox") soon();
    });
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && soon());
  } else void refresh();
}

// ---------------------------------------------------------------- the sheet

/** Open the inbox over `root`; returns its close function. */
export function openInbox(root: HTMLElement, host: InboxHost): () => void {
  ensureMathStyle();
  const scrim = document.createElement("div");
  scrim.className = "absolute inset-0 z-30 bg-black/10 animate-fade-in";
  const sheet = document.createElement("aside");
  sheet.className =
    "inbox material shadow-sheet absolute bottom-3 right-3 top-3 z-40 flex w-[min(400px,calc(100%-24px))] flex-col overflow-hidden rounded-[22px] text-foreground animate-sheet-in transition-[width] duration-300 ease-ios";
  root.append(scrim, sheet);
  let closed = false;
  let current: string | null = null;
  const close = () => {
    if (closed) return;
    closed = true;
    listeners.delete(paintList);
    sheet.style.transition = "transform 220ms cubic-bezier(0.32,0.72,0,1), opacity 220ms";
    sheet.style.transform = "translateX(104%)";
    scrim.style.transition = "opacity 220ms";
    scrim.style.opacity = "0";
    setTimeout(() => {
      sheet.remove();
      scrim.remove();
    }, 230);
    host.closed();
  };
  scrim.addEventListener("click", close);

  const header = (left: string, title: string, right = "") => `
    <header class="flex h-14 shrink-0 items-center gap-1 px-2">
      ${left}
      <h2 class="min-w-0 flex-1 truncate px-1 text-title3 font-semibold tracking-tight text-sys-label">${esc(title)}</h2>
      ${right}
      <button data-x="close" class="grid h-11 w-11 place-items-center rounded-full text-sys-secondary/60 active:bg-sys-fill/20" aria-label="Close">${icon("x")}</button>
    </header>`;

  const paintList = () => {
    if (current) return;
    sheet.style.width = "";
    const cards = entries
      .map((e) => {
        const k = KIND[e.parts[0]?.kind ?? ""] ?? { icon: e.making ? "circle-notch" : e.failed ? "warning-circle" : "tray", tint: e.failed ? "bg-[rgb(255_59_48/0.12)] text-[rgb(var(--sys-red))]" : "bg-sys-fill/15 text-sys-secondary/70" };
        const status = e.failed
          ? `<div class="mt-1 text-footnote text-[rgb(var(--sys-red))]">Couldn’t make: ${esc(e.failed)}</div>`
          : e.making
            ? `<div class="mt-1 flex items-center gap-1.5 text-footnote text-sys-blue"><span class="inline-block animate-spin">${icon("circle-notch", 14)}</span>Being made…</div>`
            : `<div class="mt-1 text-footnote text-sys-secondary/60">${esc(partsLine(e.parts))}${e.added ? ` · <span class="text-[rgb(var(--sys-green))]">${e.added} added</span>` : ""}</div>`;
        return `
        <button data-id="${esc(e.id)}" ${e.making || e.failed ? "data-inert" : ""} class="group relative flex w-full gap-3 overflow-hidden rounded-2xl bg-card/70 p-3.5 text-left hairline transition active:scale-[0.985] ${e.making ? "shimmer animate-shimmer" : ""}">
          <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl ${k.tint}">${icon(k.icon, 20)}</span>
          <span class="min-w-0 flex-1">
            <span class="flex items-baseline gap-2">
              <span class="min-w-0 flex-1 truncate text-subhead font-semibold text-sys-label">${esc(e.title)}</span>
              <span class="shrink-0 text-caption text-sys-secondary/60 tabular-nums">${ago(e.createdAt)}</span>
            </span>
            ${e.note ? `<span class="mt-0.5 block truncate text-footnote text-sys-secondary/70">${esc(e.note)}</span>` : ""}
            ${status}
          </span>
          ${e.status === "unread" && !e.making && !e.failed ? '<span class="absolute left-1.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-sys-blue" aria-label="Unread"></span>' : ""}
        </button>`;
      })
      .join("");
    sheet.innerHTML = `${header("", "Inbox")}
      <div data-scroll class="flex-1 space-y-2 overflow-y-auto overscroll-contain px-3 pb-4">
        ${cards || `<div class="grid h-full place-items-center px-8 text-center"><div><div class="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-sys-fill/15 text-sys-secondary/60">${icon("tray", 28)}</div><div class="text-subhead font-semibold text-sys-label">Nothing here yet</div><div class="mt-1 text-footnote text-sys-secondary/60">Ask the agent for a problem set, a graph or pages of a PDF; they land here.</div></div></div>`}
      </div>`;
  };

  const openEntry = async (id: string) => {
    current = id;
    sheet.style.width = "min(680px, calc(100% - 24px))";
    sheet.innerHTML = `${header(`<button data-x="back" class="flex h-11 items-center gap-0.5 rounded-full pl-1 pr-2 text-body text-sys-blue active:opacity-60">${icon("caret-left")}<span>Inbox</span></button>`, "")}<div class="grid flex-1 place-items-center text-sys-secondary/60">${icon("circle-notch")}</div>`;
    let e: Entry;
    try {
      e = await api.getEntry(id);
    } catch (err) {
      sheet.querySelector("div.grid")!.textContent = `Couldn't open it: ${String((err as Error).message)}`;
      return;
    }
    if (current !== id) return;
    if (e.status === "unread") void api.markRead(id).then(soon, () => {});
    const added = (n: number) => !!e.added?.[String(n)];
    const addBtn = (n: number | null, label: string) =>
      `<button data-add="${n ?? "all"}" class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full ${n === null ? "bg-sys-blue px-4 text-white" : "bg-sys-blue/15 px-3.5 text-sys-blue"} text-footnote font-semibold transition active:scale-95">${icon("plus", 16)}${label}</button>`;
    sheet.innerHTML = `${header(`<button data-x="back" class="flex h-11 items-center gap-0.5 rounded-full pl-1 pr-2 text-body text-sys-blue active:opacity-60">${icon("caret-left")}<span>Inbox</span></button>`, "", addBtn(null, "Add all"))}
      <div data-scroll class="flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
        <h3 class="text-title3 font-semibold tracking-tight text-sys-label">${esc(e.title)}</h3>
        ${e.note ? `<p class="mt-1 text-subhead text-sys-secondary/70">${esc(e.note)}</p>` : ""}
        <p class="mt-1 text-footnote text-sys-secondary/50">${esc(partsLine(e.parts, e.parts))} · ${ago(e.createdAt)}</p>
        <div class="mt-4 space-y-4">
          ${e.parts
            .map((p, n) => {
              const k = KIND[p.kind]!;
              const title = p.label || (p.kind === "pdf" ? `${p.path.split("/").pop()} · ${p.pages.length > 1 ? `pp. ${p.pages[0]}–${p.pages[p.pages.length - 1]}` : `p. ${p.pages[0]}`}` : p.kind === "image" || p.kind === "widget" ? p.alt : `Part ${n + 1}`);
              return `
              <section class="overflow-hidden rounded-2xl bg-card hairline shadow-sm" data-part="${n}">
                <div class="flex items-center gap-2.5 border-b border-sys-separator/15 px-3.5 py-2.5">
                  <span class="grid h-7 w-7 shrink-0 place-items-center rounded-lg ${k.tint}">${icon(k.icon, 16)}</span>
                  <span class="min-w-0 flex-1 truncate text-subhead font-semibold text-sys-label">${esc(title)}</span>
                  ${added(n) ? `<span class="text-footnote text-[rgb(var(--sys-green))]">Added</span>` : ""}
                  ${addBtn(n, p.kind === "pdf" && p.pages.length > 1 ? `Add ${p.pages.length} pages` : "Add")}
                </div>
                <div class="part-body bg-white" data-kind="${p.kind}"></div>
              </section>`;
            })
            .join("")}
        </div>
      </div>`;
    // Fill each part's preview.
    sheet.querySelectorAll<HTMLElement>("[data-part]").forEach((sec) => void fillPart(sec.querySelector(".part-body") as HTMLElement, e, Number(sec.dataset.part)));
  };

  sheet.addEventListener("click", (ev) => {
    const t = (ev.target as HTMLElement).closest("button");
    if (!t) return;
    if (t.dataset.x === "close") return close();
    if (t.dataset.x === "back") {
      current = null;
      paintList();
      void refresh();
      return;
    }
    if (t.dataset.id !== undefined && t.dataset.inert === undefined) return void openEntry(t.dataset.id);
    if (t.dataset.add !== undefined && current) {
      const part = t.dataset.add === "all" ? undefined : Number(t.dataset.add);
      (t as HTMLButtonElement).disabled = true;
      t.classList.add("opacity-50");
      void host
        .add(current, part)
        .then(() => {
          soon();
          close();
        })
        .catch((err) => {
          (t as HTMLButtonElement).disabled = false;
          t.classList.remove("opacity-50");
          t.title = String(err?.message ?? err);
          t.innerHTML = `${icon("warning-circle", 16)}Retry`;
        });
    }
  });

  listeners.add(paintList);
  paintList();
  void refresh();
  return close;
}

/** A part's preview in the viewer. */
async function fillPart(box: HTMLElement, e: Entry, n: number): Promise<void> {
  const p = e.parts[n]!;
  const width = box.clientWidth || 600;
  try {
    if (p.kind === "pdf") {
      box.className += " space-y-px bg-sys-fill/10";
      const url = api.partUrl(e.id, n);
      for (const pg of p.pages) {
        const c = await renderPdfPage(url, pg, Math.round(width * Math.min(2, window.devicePixelRatio || 1)));
        c.className = "block w-full h-auto bg-white";
        c.style.aspectRatio = `${c.width} / ${c.height}`;
        box.appendChild(c);
      }
    } else if (p.kind === "math") {
      const html = await fetchText(api.partUrl(e.id, n, "html"));
      const m = document.createElement("div");
      m.className = "vc-math";
      m.style.width = `${MATH_LAYOUT_W}px`;
      m.style.maxWidth = "100%";
      m.innerHTML = html;
      box.appendChild(m);
    } else if (p.kind === "image") {
      const img = document.createElement("img");
      img.src = api.partUrl(e.id, n);
      img.alt = p.alt;
      img.className = "mx-auto block max-h-[520px] w-full object-contain";
      box.appendChild(img);
    } else if (p.kind === "widget") {
      const lay = p.layout ?? WIDGET_LAYOUT;
      const s = Math.min(1, width / lay.w);
      const wrap = document.createElement("div");
      wrap.style.cssText = `height:${Math.round(lay.h * s)}px;overflow:hidden`;
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts");
      f.setAttribute("title", p.alt);
      f.style.cssText = `width:${lay.w}px;height:${lay.h}px;border:0;transform:scale(${s});transform-origin:0 0;display:block;background:#fff`;
      f.srcdoc = widgetDocument(await fetchText(api.partUrl(e.id, n, "bundle")), lay);
      wrap.appendChild(f);
      box.appendChild(wrap);
    }
  } catch (err) {
    box.innerHTML = `<p class="p-4 text-footnote text-sys-secondary/60">Couldn't show this part: ${esc(String((err as Error)?.message ?? err))}</p>`;
  }
}
