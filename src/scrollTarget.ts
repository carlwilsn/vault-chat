// ScrollTo's target, the same for every viewer (HTML, markdown, PDF): what the
// voice agent asked for (an id, a heading's text, its slug, or a phrase on the
// page) matched against the sections the viewer has, and the viewer's answer
// back to the tool — so a scroll that lands says where, and one that cannot
// says why, with the headings that do exist.

import { decodeTarget, mdLineQuery, type ViewTarget } from "./viewTarget";

/** A place the viewer can scroll to: a heading (or an in-page link, e.g. a hash-routed page's nav). */
export type Section = { id?: string; text: string; link?: boolean };

/** "End-to-end: MDP concepts", "end-to-end-mdp-concepts", "#End_to_end" → "end to end mdp concepts". */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/^#\/?/, "")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const STOP = new Set(["to", "of", "the", "and", "an", "in", "on", "for", "is", "at", "by", "with"]);
const words = (s: string) => norm(s).split(" ").filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP.has(w));

/** How alike two names are, 0..1 (shared words over the larger set, plus a little for a shared prefix). */
export function likeness(a: string, b: string): number {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w) || [...wb].some((x) => x.length >= 3 && w.length >= 3 && (x.startsWith(w) || w.startsWith(x)))) shared++;
  return shared / Math.max(wa.size, wb.size);
}

/**
 * The section `query` names, or null: an exact id, then the same name
 * (normalized: a slug and its heading match), then a heading that contains
 * the query (or is contained in it), then the clearly closest by shared words.
 * Headings win over links of the same name.
 */
export function matchSection(sections: Section[], query: string): number | null {
  const q = query.trim().replace(/^#/, "");
  if (!q) return null;
  const nq = norm(q);
  if (!nq) return null;
  const order = sections.map((s, i) => ({ s, i })).sort((a, b) => Number(!!a.s.link) - Number(!!b.s.link) || a.i - b.i);
  const first = (ok: (s: Section) => boolean) => order.find((x) => ok(x.s))?.i ?? null;
  return (
    first((s) => !!s.id && s.id === q) ??
    first((s) => !!s.id && s.id.toLowerCase() === q.toLowerCase()) ??
    first((s) => norm(s.text) === nq || (!!s.id && norm(s.id) === nq)) ??
    first((s) => nq.length >= 4 && norm(s.text).includes(nq)) ??
    first((s) => norm(s.text).length >= 4 && nq.includes(norm(s.text))) ??
    closest(sections, q)
  );
}

function closest(sections: Section[], q: string): number | null {
  const scored = sections.map((s, i) => ({ i, v: Math.max(likeness(s.text, q), s.id ? likeness(s.id, q) : 0) })).sort((a, b) => b.v - a.v);
  const best = scored[0];
  if (!best || best.v < 0.6) return null;
  // Two equally good: not clear enough to move someone's view.
  if (scored[1] && scored[1].v === best.v) return null;
  return best.i;
}

/** The headings nearest `query` (most alike first), for an error the agent can retry from. */
export function nearestSections(sections: Section[], query: string, n = 5): Section[] {
  return sections
    .map((s, i) => ({ s, i, v: Math.max(likeness(s.text, query), s.id ? likeness(s.id, query) : 0) }))
    .sort((a, b) => b.v - a.v || a.i - b.i)
    .slice(0, n)
    .map((x) => x.s);
}

const label = (s: Section) => `"${s.text.slice(0, 80)}"${s.id ? ` (#${s.id})` : ""}`;

/** The precise "not here" answer: what was asked, the nearest headings, and how to ask again. */
export function notFound(query: string, file: string, sections: Section[]): string {
  const name = file.split(/[\\/]/).pop() ?? file;
  if (!sections.length) return `Error: "${query}" is not in ${name}: no heading or text on the page matches, and the page has no headings. Pass a phrase that appears on the page.`;
  const near = nearestSections(sections, query, 5);
  const all = sections.length <= 25 ? ` All of them: ${sections.map(label).join(", ")}.` : "";
  return `Error: "${query}" is not in ${name}: no heading, id or text on the page matches. Nearest headings: ${near.map(label).join(", ")}.${all} Call ScrollTo again with one of these (its text or its #id), or a phrase that appears on the page.`;
}

// ---------------------------------------------------------------- the viewer's answer

type Waiter = { anchor: string; resolve: (outcome: string) => void };
const waiters = new Map<string, Waiter>();
const key = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/** A viewer took a scroll request for `path`: what happened ("Scrolled to …" or "Error: …"). */
export function reportScroll(path: string, outcome: string): void {
  const w = waiters.get(key(path));
  if (!w) return;
  waiters.delete(key(path));
  w.resolve(outcome);
}

/** Wait for the viewer of `path` to answer a scroll request (null: no answer in `ms`). A newer wait replaces an older one. */
export function awaitScroll(path: string, anchor: string, ms: number): Promise<string | null> {
  const k = key(path);
  waiters.get(k)?.resolve("Superseded by later ScrollTo");
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      if (waiters.get(k) === w) waiters.delete(k);
      resolve(null);
    }, ms);
    const w: Waiter = {
      anchor,
      resolve: (o) => {
        clearTimeout(t);
        resolve(o);
      },
    };
    waiters.set(k, w);
  });
}

// ---------------------------------------------------------------- in the app's own DOM (markdown)

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** The first element under `root` whose text holds `q` (case and spacing ignored). */
export function findText(root: HTMLElement, q: string): HTMLElement | null {
  const want = squash(q).toLowerCase();
  if (!want) return null;
  const w = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const p = n.parentElement;
    if (p && !/^(SCRIPT|STYLE)$/.test(p.tagName) && squash(n.nodeValue).toLowerCase().includes(want)) return p;
  }
  for (const b of Array.from(root.querySelectorAll<HTMLElement>("p,li,td,th,dt,dd,blockquote,pre,h1,h2,h3,h4,h5,h6"))) {
    if (squash(b.textContent).toLowerCase().includes(want)) return b;
  }
  return null;
}

/** ScrollTo in a rendered document under `root`: an id, a heading by its text or slug, else the first place the phrase appears. */
export function scrollInDom(root: HTMLElement, anchor: string, file: string): string {
  const name = file.split(/[\\/]/).pop() ?? file;
  const q = anchor.trim().replace(/^#/, "");
  const els = Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
  const sections: Section[] = els.map((h) => ({ id: h.id || undefined, text: squash(h.textContent).slice(0, 200) })).filter((s) => s.text);
  const go = (el: Element, where: string) => {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    return `Scrolled to ${where} in ${name}`;
  };
  let byId: HTMLElement | null = null;
  try {
    byId = q ? root.querySelector<HTMLElement>(`[id="${CSS.escape(q)}"]`) : null;
  } catch {
    byId = null;
  }
  if (byId) return go(byId, `#${q}`);
  const i = matchSection(sections, q);
  if (i !== null) {
    const el = els.find((h) => squash(h.textContent).slice(0, 200) === sections[i]!.text);
    if (el) return go(el, `"${sections[i]!.text.slice(0, 80)}"`);
  }
  const at = findText(root, anchor);
  if (at) return go(at, `the text "${squash(anchor).slice(0, 80)}"`);
  return notFound(anchor, file, sections);
}

// ---------------------------------------------------------------- typed targets (src/viewTarget.ts)

/** A rendered markdown page under `root`: an id (anchor), a heading (headings only), a phrase (text), or an older free string. */
export function scrollToTarget(root: HTMLElement, t: ViewTarget, file: string, said?: string): string {
  if (t.query !== undefined) return scrollInDom(root, t.query, file);
  const name = file.split(/[\/]/).pop() ?? file;
  const els = Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
  const sections: Section[] = els.map((h) => ({ id: h.id || undefined, text: squash(h.textContent).slice(0, 200) })).filter((s) => s.text);
  const go = (el: Element, where: string) => {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    return `Scrolled to ${said ?? where} in ${name}`;
  };
  if (t.anchor) {
    let el: HTMLElement | null = null;
    try {
      el = root.querySelector<HTMLElement>(`[id="${CSS.escape(t.anchor)}"]`);
    } catch {
      el = null;
    }
    return el ? go(el, `#${t.anchor}`) : notFound(`#${t.anchor}`, file, sections);
  }
  if (t.heading) {
    const i = matchSection(sections, t.heading);
    const el = i === null ? null : els.find((h) => squash(h.textContent).slice(0, 200) === sections[i]!.text);
    return el ? go(el, `heading "${sections[i!]!.text.slice(0, 80)}"`) : notFound(t.heading, file, sections);
  }
  if (t.text) {
    const el = findText(root, t.text);
    return el ? go(el, `the text "${squash(t.text).slice(0, 80)}"`) : notFound(t.text, file, sections);
  }
  return `Error: nothing to scroll to in ${name}.`;
}

/** The HTML viewer's bridge, as a function (HtmlView passes its iframe's; tests pass a fake page). */
export type FrameAsk = <T>(msg: Record<string, unknown>, pick: (d: any) => T | undefined, ms: number) => Promise<T | null>;

/** An HTML page in the viewer: anchor (an id), heading (headings and nav links), text, or an older free string. */
export async function scrollHtmlWith(ask: FrameAsk, t: ViewTarget, path: string, req: number): Promise<string> {
  const name = path.split(/[\/]/).pop() ?? path;
  const q = t.anchor ? `#${t.anchor}` : t.heading ?? t.text ?? t.query ?? "";
  if (t.page !== undefined || (t.query !== undefined && /^page=\d+$/.test(t.query)))
    return `Error: ${name} is a web page, not a PDF: it has no pages. Pass a heading (its text), an anchor (#id) or a phrase on the page.`;
  if (!q) return `Error: ${name} takes anchor, heading or text.`;
  const listed = await ask({ __vc_scroll_list: { req, q } }, (d) => (d?.__vc_scroll_list_result?.req === req ? (d.__vc_scroll_list_result as { sections: Section[]; byId: boolean }) : undefined), 5000);
  if (!listed) return `Error: ${name} did not answer (the page is still loading, or it is not open in the viewer). Try again in a moment.`;
  const sections = Array.isArray(listed.sections) ? listed.sections : [];
  const shown = () => sections.filter((s) => !s.link || !sections.some((h) => !h.link && h.text === s.text));
  let go: Record<string, unknown>;
  if (t.anchor) {
    if (!listed.byId) return notFound(q, path, shown());
    go = { id: t.anchor };
  } else if (t.heading) {
    const i = matchSection(sections, t.heading);
    if (i === null) return notFound(t.heading, path, shown());
    go = { i };
  } else if (t.text) go = { text: t.text };
  else {
    const i = listed.byId ? null : matchSection(sections, q);
    go = listed.byId ? { id: q.replace(/^#/, "") } : i !== null ? { i } : { text: q };
  }
  const done = await ask({ __vc_scroll_go: { req, ...go } }, (d) => (d?.__vc_scroll_done?.req === req ? (d.__vc_scroll_done as { ok: boolean; where: string; error?: string }) : undefined), 3000);
  if (!done) return `Error: ${name} did not answer the scroll. Try again in a moment.`;
  if (done.ok) return `Scrolled to ${done.where} in ${name}`;
  if (done.error) return `Error: the scroll in ${name} failed: ${done.error}`;
  return notFound(q, path, shown());
}

/**
 * A markdown viewer's answer to a request (MarkdownView): in reading view a source line becomes the heading on it
 * or its first words on the rendered page; while editing only a line can be reached (LiveEditor takes those, so
 * the caller never passes one here with `editing`).
 */
export function landMarkdown(root: HTMLElement | null, content: string, anchor: string, file: string, editing: boolean): string {
  const name = file.split(/[\/]/).pop() ?? file;
  const t = decodeTarget(anchor);
  if (editing) return `Error: ${name} is open for editing, so it has no reading view to move. Pass line (the editor goes to a source line), or ask to switch it to view.`;
  if (!root) return `Error: ${file} is not on screen.`;
  if (t.line === undefined) return scrollToTarget(root, t, file);
  const q = mdLineQuery(content, t.line);
  if (!q) {
    const total = content.split(/\r?\n/).length;
    return `Error: ${name} has ${total} lines; nothing on the page is at or after line ${t.line}. Lines are 1–${total}.`;
  }
  return scrollToTarget(root, q, file, `line ${t.line}${q.heading ? ` (heading "${q.heading.slice(0, 80)}")` : ""}`);
}
