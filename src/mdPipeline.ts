// The one markdown pipeline. Every surface that shows markdown — the note
// viewer, the chat (finished and streaming), the history views, the phone —
// builds its remark/rehype chain here, so a construct renders the same
// everywhere and a fix lands everywhere at once.
//
//   source ─ prepareMarkdown ─ remark (gfm, math, wiki links[, breaks])
//          ─ rehype (raw HTML → rehypeSafeHtml → [slug] → KaTeX → [highlight])
//
// prepareMarkdown: CRLF → LF, YAML frontmatter dropped (notes), image paths
// with spaces made parseable, then the math preprocessing in mdMath.ts.
// rehypeSafeHtml: raw HTML in a note or a reply is rendered, but only the
// harmless part of it — no scripts, frames, forms, event handlers or
// javascript: URLs (the HTML is the user's and the model's; neither may run
// code in the app). KaTeX runs after it, so its own markup is never touched.
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import { codeRanges, mapOutsideCode, preprocessMarkdownMath } from "./mdMath";

// Lenient KaTeX options shared by every renderer: `strict: "ignore"` silences
// "unicode in math mode" and similar warnings; `errorColor: currentColor`
// makes a rare unrecoverable parse error read as ordinary text, not red.
// `trust: false` (KaTeX's default, stated here on purpose): \href{javascript:…}
// and \includegraphics stay inert.
export const KATEX_OPTIONS = { strict: "ignore", errorColor: "currentColor", trust: false } as const;

// ---- source preparation -------------------------------------------------------

/** CRLF / lone CR → LF, and a leading BOM dropped. */
export function normalizeNewlines(src: string): string {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  return src.indexOf("\r") === -1 ? src : src.replace(/\r\n?/g, "\n");
}

/** A leading YAML frontmatter block (`---` … `---` or `...`), split off. A
 *  note that merely starts with a rule and has no closing fence is left alone. */
export function splitFrontmatter(src: string): { frontmatter: string | null; body: string } {
  const m = /^---[ \t]*\n([\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { frontmatter: null, body: src };
  const fm = m[1] ?? "";
  // YAML, not prose between two rules: every non-blank line is a key, a list
  // item, a comment or an indented continuation.
  const yamlish = fm.split("\n").every((l) => !l.trim() || /^(?:[\w"'][^:\n]*:(?:\s|$)|\s*-\s|\s*-$|\s+\S|#)/.test(l));
  if (!yamlish) return { frontmatter: null, body: src };
  return { frontmatter: fm, body: src.slice(m[0].length) };
}

// `![alt](assets/My Shot 1.png)`, `[notes](Week 3/Lecture notes.md)` — a
// destination with spaces is not a link in CommonMark, so it showed as raw
// text. Wrap such a destination in <…> (the CommonMark way to allow spaces)
// when it names a file (an extension at the end), never a URL with a scheme.
const SPACED_DEST_RE =
  /(!?\[[^\]\n]*\]\()(?!<)(?![a-z][a-z0-9+.-]*:\/\/)([^()\n<>"]*? [^()\n<>"]*?\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif|md|markdown|pdf|txt|csv|ipynb|tex|html?|py))(\s+"[^"\n]*")?\)/gi;

function fixImagePaths(src: string): string {
  if (src.indexOf("](") === -1) return src;
  return mapOutsideCode(src, (s) => s.replace(SPACED_DEST_RE, (_m, open, path, title) => `${open}<${path}>${title ?? ""})`));
}

export type PrepareOptions = {
  /** Drop a leading YAML frontmatter block (notes; replies never have one). */
  frontmatter?: boolean;
};

/** Everything a source goes through before remark sees it. Never throws. */
export function prepareMarkdown(src: string | null | undefined, opts: PrepareOptions = {}): string {
  let s = normalizeNewlines(String(src ?? ""));
  if (opts.frontmatter) s = splitFrontmatter(s).body;
  try {
    s = fixImagePaths(s);
    return preprocessMarkdownMath(s);
  } catch (err) {
    // A bug in the preprocessing must never blank a note or a reply.
    console.warn("[markdown] preprocessing failed; rendering the source as is:", err);
    return s;
  }
}

// ---- URLs ---------------------------------------------------------------------

const SAFE_PROTOCOL = /^(?:https?|mailto|ircs?|xmpp|tel|file|vault)$/i;

/** The URL a link/image may carry, or "" when it is unsafe. Relative paths,
 *  #anchors, Windows absolute paths (`C:\…`, `C:/…`) and the safe protocols
 *  pass; `data:` only as a raster/SVG image in an `src`. Everything else —
 *  javascript:, vbscript:, data:text/html … — is dropped. */
export function safeUrl(url: string, key = "href"): string {
  const v = String(url ?? "").trim();
  // Browsers ignore ASCII whitespace/control chars inside a scheme ("java\tscript:").
  // eslint-disable-next-line no-control-regex
  const probe = v.replace(/[\u0000-\u0020]/g, "");
  if (/^[a-zA-Z]:[\\/]/.test(probe)) return v;
  if (/^data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml|avif);/i.test(probe)) return key === "src" ? v : "";
  const colon = probe.indexOf(":");
  if (colon === -1) return v;
  const slash = probe.indexOf("/");
  const q = probe.indexOf("?");
  const hash = probe.indexOf("#");
  if ((slash !== -1 && colon > slash) || (q !== -1 && colon > q) || (hash !== -1 && colon > hash)) return v;
  return SAFE_PROTOCOL.test(probe.slice(0, colon)) ? v : "";
}

/** react-markdown's `urlTransform`: none. rehypeSafeHtml already checked
 *  every URL of every element (markdown's and raw HTML's) with safeUrl and
 *  dropped the unsafe ones — dropped, not emptied: react-markdown's own
 *  transform leaves `src=""`, which React warns about and a browser may
 *  resolve to the page itself. */
export function markdownUrlTransform(url: string): string {
  return url;
}

/** A local vault path from a link/image URL: `file://` dropped, query/hash
 *  dropped, percent-escapes decoded (`My%20Note.md` → `My Note.md`). */
export function localPathFromUrl(url: string): string {
  const cleaned = url.replace(/^file:\/\/\/?/i, "").split("#")[0].split("?")[0];
  try {
    return decodeURI(cleaned);
  } catch {
    return cleaned;
  }
}

// ---- remark: wiki links -------------------------------------------------------

type MdNode = { type: string; value?: string; url?: string; alt?: string; title?: string | null; children?: MdNode[]; data?: Record<string, unknown> };

const WIKI_RE = /(!?)\[\[([^\[\]\n|#^]*)(#[^\[\]\n|]*)?(?:\|([^\[\]\n]*))?\]\]/g;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

function wikiHref(target: string, anchor: string | undefined): string {
  const t = target.trim();
  const withExt = t && !/\.[A-Za-z0-9]{1,6}$/.test(t) ? `${t}.md` : t;
  const enc = withExt.split("/").map((p) => encodeURIComponent(p)).join("/");
  return enc + (anchor ? "#" + encodeURIComponent(anchor.slice(1).trim().toLowerCase().replace(/\s+/g, "-")) : "");
}

/** Obsidian-style `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]` and
 *  `![[image.png]]` (text nodes only — never inside code or math). A link
 *  carries `data-wiki` so the click handler can find the note by name. */
export function remarkWikiLinks() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      const kids = node.children;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.type === "text" && child.value && child.value.includes("[[")) {
          const replaced = splitWiki(child.value);
          if (replaced) {
            kids.splice(i, 1, ...replaced);
            i += replaced.length - 1;
          }
          continue;
        }
        if (child.type !== "link" && child.type !== "linkReference") walk(child);
      }
    };
    walk(tree);
  };
}

function splitWiki(value: string): MdNode[] | null {
  const out: MdNode[] = [];
  let last = 0;
  WIKI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_RE.exec(value))) {
    const [all, bang, target, anchor, alias] = m;
    if (!target.trim() && !anchor) continue;
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    const label = (alias ?? "").trim() || (target.trim() + (anchor ? anchor.replace(/^#/, " › ") : "")).trim();
    if (bang && IMAGE_EXT.test(target.trim())) {
      out.push({ type: "image", url: wikiHref(target, undefined), alt: (alias ?? "").trim() || target.trim(), title: null });
    } else {
      out.push({
        type: "link",
        url: wikiHref(target, anchor),
        title: null,
        children: [{ type: "text", value: label }],
        data: { hProperties: { className: ["wiki-link"], dataWiki: target.trim() } },
      });
    }
    last = m.index + all.length;
  }
  if (!out.length) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

// ---- rehype: safe HTML --------------------------------------------------------

type HNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
  position?: unknown;
};

/** Elements dropped with everything inside them. */
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "link", "meta",
  "noscript", "template", "form", "textarea", "select", "option", "button", "dialog", "portal", "title", "head",
  "svg", "math", "canvas", "audio", "video", "source", "track", "param", "html", "body",
]);
/** Elements replaced by their children (structure we don't want, content we do). */
const UNWRAP = new Set(["font", "center", "marquee", "blink", "label", "fieldset", "legend", "nobr"]);
const URL_PROPS = new Set(["href", "src", "cite", "action", "formAction", "poster", "background", "xLinkHref", "data", "longDesc", "srcSet", "ping", "manifest", "icon", "itemId"]);

/** Strips what raw HTML in markdown must never do. Runs after rehype-raw,
 *  before KaTeX and highlight (their markup is the app's own). */
export function rehypeSafeHtml() {
  return (tree: HNode) => {
    clean(tree);
  };
}

function clean(node: HNode): void {
  const kids = node.children;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.type === "comment" || c.type === "doctype") {
      kids.splice(i--, 1);
      continue;
    }
    if (c.type === "raw") {
      // Raw HTML that rehype-raw did not take (no rehype-raw in the chain):
      // shown as text, the way react-markdown would.
      kids[i] = { type: "text", value: c.value ?? "" };
      continue;
    }
    if (c.type !== "element" || !c.tagName) continue;
    const tag = c.tagName.toLowerCase();
    if (DROP.has(tag) || (tag === "input" && !isTaskCheckbox(c, node))) {
      kids.splice(i--, 1);
      continue;
    }
    if (UNWRAP.has(tag)) {
      kids.splice(i, 1, ...(c.children ?? []));
      i--;
      continue;
    }
    cleanProps(c);
    clean(c);
  }
}

// The only <input> markdown makes: a GFM task item's checkbox (remark-gfm's,
// first in its <li> or its first <p>). A raw <input> would also shift which
// source checkbox a click flips, so it goes.
function isTaskCheckbox(el: HNode, parent: HNode): boolean {
  if (el.position) return false; // from raw HTML (parse5 positions it); remark-rehype's has none
  const p = el.properties ?? {};
  if (String(p.type).toLowerCase() !== "checkbox") return false;
  return parent.tagName === "li" || parent.tagName === "p";
}

function cleanProps(el: HNode): void {
  const p = el.properties;
  if (!p) return;
  for (const key of Object.keys(p)) {
    const v = p[key];
    if (/^on/i.test(key)) {
      delete p[key];
      continue;
    }
    if (URL_PROPS.has(key)) {
      if (key === "srcSet" || key === "ping") {
        delete p[key];
        continue;
      }
      const s = safeUrl(Array.isArray(v) ? v.join(" ") : String(v ?? ""), key === "src" ? "src" : "href");
      if (s) p[key] = s;
      else delete p[key];
      continue;
    }
    if (key === "style" && typeof v === "string") {
      // No fixed/absolute overlays over the app, no url() fetches, no
      // legacy expression().
      if (/url\s*\(|expression\s*\(|position\s*:\s*(?:fixed|absolute|sticky)|z-index|behavior\s*:|-moz-binding/i.test(v)) delete p[key];
      continue;
    }
    if (key === "formTarget" || key === "srcDoc" || key === "is") delete p[key];
  }
  if (el.tagName === "a" && typeof p.target === "string") {
    // A raw link that opens a window gets no handle back on the app.
    p.rel = ["noopener", "noreferrer"];
  }
}

// ---- rehype: layout ------------------------------------------------------------

/** Every table in its own horizontal scroller (`div.tablewrap`): a wide
 *  table scrolls inside the note / the reply instead of pushing the whole
 *  pane sideways. Text blocks get `dir="auto"`, so a Hebrew or Arabic
 *  paragraph reads right-to-left while the rest stays left-to-right. */
export function rehypeLayout() {
  const DIR = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "td", "th", "summary"]);
  const walk = (node: HNode) => {
    const kids = node.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.type !== "element") continue;
      if (c.tagName === "table" && !(node.tagName === "div" && hasClass(node, "tablewrap"))) {
        kids[i] = { type: "element", tagName: "div", properties: { className: ["tablewrap"] }, children: [c] };
      }
      if (DIR.has(c.tagName ?? "") && c.properties && c.properties.dir == null) c.properties.dir = "auto";
      if (c.tagName === "pre" || c.tagName === "code") continue;
      walk(c);
    }
  };
  return (tree: HNode) => walk(tree);
}

function hasClass(n: HNode, cls: string): boolean {
  const c = n.properties?.className;
  return Array.isArray(c) ? c.includes(cls) : c === cls;
}

// ---- rehype: KaTeX, cached ------------------------------------------------------

// KaTeX is most of a render's cost (each formula: KaTeX, then its HTML
// parsed back into a tree), and the same formulas render again and again —
// a checkbox flip re-renders the note, a streaming reply's tail re-renders
// per flush, the editor rebuilds a table widget when it scrolls back into
// view. So rendered formulas are kept (by display mode + TeX) and reused:
// rehypeKatexFromCache swaps cached output in before rehype-katex, and
// rehypeKatexToCache files what rehype-katex rendered. A formula that
// failed to parse is never cached (it carries no TeX annotation).
const katexCache = new Map<string, HNode>();
const KATEX_CACHE_MAX = 600;

function classesOf(n: HNode): string[] {
  const c = n.properties?.className;
  return Array.isArray(c) ? c.map(String) : typeof c === "string" ? c.split(" ") : [];
}

function textContent(n: HNode): string {
  if (n.type === "text") return n.value ?? "";
  return (n.children ?? []).map(textContent).join("");
}

export function rehypeKatexFromCache() {
  const walk = (node: HNode) => {
    const kids = node.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.type !== "element") continue;
      let code: HNode | null = null;
      let display = false;
      if (c.tagName === "pre" && c.children?.length === 1 && c.children[0].tagName === "code" && classesOf(c.children[0]).includes("language-math")) {
        code = c.children[0];
        display = true;
      } else if (c.tagName === "code") {
        const cls = classesOf(c);
        if (cls.includes("math-inline") || cls.includes("math-display")) {
          code = c;
          display = cls.includes("math-display");
        }
      }
      if (code) {
        const hit = katexCache.get((display ? "D" : "I") + textContent(code));
        if (hit) {
          kids[i] = structuredClone(hit);
        }
        continue;
      }
      walk(c);
    }
  };
  return (tree: HNode) => walk(tree);
}

export function rehypeKatexToCache() {
  const annotation = (n: HNode): string | null => {
    if (n.type === "element" && n.tagName === "annotation") return textContent(n);
    for (const k of n.children ?? []) {
      const a = annotation(k);
      if (a !== null) return a;
    }
    return null;
  };
  const walk = (node: HNode) => {
    for (const c of node.children ?? []) {
      if (c.type !== "element") continue;
      const cls = classesOf(c);
      if (c.tagName === "span" && (cls.includes("katex-display") || cls.includes("katex"))) {
        const tex = annotation(c);
        if (tex !== null) {
          const key = (cls.includes("katex-display") ? "D" : "I") + tex;
          if (!katexCache.has(key)) {
            katexCache.set(key, structuredClone(c));
            if (katexCache.size > KATEX_CACHE_MAX) katexCache.delete(katexCache.keys().next().value!);
          }
        }
        continue;
      }
      walk(c);
    }
  };
  return (tree: HNode) => walk(tree);
}

// ---- profiles -----------------------------------------------------------------

/** Where markdown is shown. `note`: a vault file (single newlines break,
 *  frontmatter hidden, heading ids). `chat`: a model reply (standard
 *  newlines). `user`: your own message (newlines break). `phone`: the phone's
 *  chat (the chat profile, no syntax highlighting). `stream`: the
 *  still-streaming tail of a reply (no highlighting: it re-renders on every
 *  flush). */
export type MdProfile = "note" | "chat" | "user" | "phone" | "stream";

type Plugin = any; // unified's PluggableList, without importing unified's types

/** The plugin chains for a profile. Syntax highlighting is passed in
 *  (`rehype-highlight` on the desktop) so the phone's bundle leaves
 *  highlight.js out; profiles that don't highlight ignore it. */
export function markdownPlugins(profile: MdProfile, rehypeHighlight?: Plugin): { remarkPlugins: Plugin[]; rehypePlugins: Plugin[] } {
  const breaks = profile === "note" || profile === "user";
  const highlight = !!rehypeHighlight && (profile === "note" || profile === "chat");
  // `singleTilde: false`: only `~~x~~` strikes through. In these notes a `~`
  // means "about" ("~$6, lands ~$20"), and GFM's single-tilde strikethrough
  // struck out everything between two of them.
  const remarkPlugins: Plugin[] = [[remarkGfm, { singleTilde: false }], remarkMath, remarkWikiLinks];
  if (breaks) remarkPlugins.push(remarkBreaks);
  const rehypePlugins: Plugin[] = [rehypeRaw, rehypeSafeHtml, rehypeLayout];
  if (profile === "note") rehypePlugins.push(rehypeSlug);
  rehypePlugins.push(rehypeKatexFromCache, [rehypeKatex, KATEX_OPTIONS], rehypeKatexToCache);
  if (highlight) rehypePlugins.push(rehypeHighlight);
  return { remarkPlugins, rehypePlugins };
}

const cache = new Map<string, ReturnType<typeof markdownPlugins>>();
/** The same plugin arrays every call (a stable identity keeps memoized
 *  ReactMarkdown callers from re-rendering). */
export function pluginsFor(profile: MdProfile, rehypeHighlight?: Plugin): ReturnType<typeof markdownPlugins> {
  const key = profile + (rehypeHighlight ? "+hl" : "");
  let p = cache.get(key);
  if (!p) cache.set(key, (p = markdownPlugins(profile, rehypeHighlight)));
  return p;
}

// ---- streaming ----------------------------------------------------------------

/** Split a reply that is still streaming into finished top-level blocks and
 *  the open tail. A block is finished once a blank line follows it outside
 *  any code fence or `$$` block, and the next line starts a new top-level
 *  block (not indented — an indented line may continue a list item). The
 *  blocks never change again, so each renders once; only the tail re-renders
 *  per flush. Footnote and link-reference definitions make every block
 *  depend on the end, so a reply that has one is not split. */
export function splitStreaming(src: string): { blocks: string[]; tail: string } {
  const s = normalizeNewlines(src);
  if (/^\s{0,3}\[[^\]\n]+\]:/m.test(s)) return { blocks: [], tail: s };
  const lines = s.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let fence: string | null = null;
  let inMath = false;
  let listOpen = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (fence) {
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(l);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^[ \t]*(`{3,}|~{3,})/.exec(l);
    if (open) {
      fence = open[1];
      continue;
    }
    const dd = (l.match(/\$\$/g) ?? []).length;
    if (dd % 2 === 1) inMath = !inMath;
    if (inMath) continue;
    if (/^[ \t]*(?:[-*+]|\d+[.)])[ \t]/.test(l)) listOpen = true;
    if (l.trim() !== "" || i + 1 >= lines.length) continue;
    // A blank line: a boundary if the next non-blank line starts a new block.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j >= lines.length) continue; // nothing after it yet
    const next = lines[j];
    if (/^[ \t]/.test(next)) continue; // continues a list item / indented code
    if (listOpen && /^(?:[-*+]|\d+[.)])[ \t]/.test(next)) continue; // the same list goes on
    blocks.push(lines.slice(start, j).join("\n"));
    start = j;
    listOpen = false;
    i = j - 1;
  }
  return { blocks, tail: lines.slice(start).join("\n") };
}

// ---- task lists -----------------------------------------------------------------

/** Flip the Nth GFM task-list checkbox in a note's source (the Nth rendered
 *  checkbox). A task item is a list item (`-`, `*`, `+`, `1.`, `1)`), maybe
 *  inside quotes, whose content starts with `[ ]`/`[x]`/`[X]` and a space.
 *  Items inside code blocks and the frontmatter render no checkbox, so they
 *  don't count. Null when there is no Nth one. */
export function flipNthTaskCheckbox(content: string, n: number): string | null {
  const fm = splitFrontmatter(normalizeNewlinesKeepLength(content));
  const skipTo = content.length - fm.body.length;
  const code = codeRanges(content);
  const inCode = (pos: number) => code.some(([a, b]) => pos >= a && pos < b);
  const re = /^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\](?=[ \t])/gm;
  let i = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match.index < skipTo || inCode(match.index)) continue;
    if (i === n) {
      const flipped = match[2] === " " ? "x" : " ";
      const charIdx = match.index + match[1].length + 1; // between the brackets
      return content.slice(0, charIdx) + flipped + content.slice(charIdx + 1);
    }
    i++;
  }
  return null;
}

/** CRLF-tolerant frontmatter detection without changing offsets. */
function normalizeNewlinesKeepLength(src: string): string {
  return src.replace(/\r/g, " ");
}
