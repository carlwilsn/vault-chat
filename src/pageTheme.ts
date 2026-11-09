// The app's theme, handed to every sandboxed vault page (inline in chat, in the viewer, on the phone).
//
// A page gets CSS custom properties on its root: --vc-bg, --vc-fg, --vc-muted (secondary text), --vc-surface (a raised
// panel), --vc-border, --vc-accent, --vc-font, --vc-mono, plus `color-scheme` (light/dark) and, below any rule the page
// writes itself, a default background and text colour. So a page that ignores them still matches the app, and a page
// that uses them follows the theme live: the host (installPageTheme) posts the new values to each page frame when the
// app's theme changes, over postMessage. The page asks once at load ("hello") so a frame built before a theme change
// catches up. Nothing here gives a page any power: it only reads colours.
export const PAGE_THEME_MSG = "__vc_theme";
export const PAGE_THEME_HELLO = "__vc_theme_hello";
/** A frame that takes part: the host posts theme updates to every `iframe[data-vc-page]`. */
export const PAGE_FRAME_ATTR = "data-vc-page";

export type PageMode = "light" | "dark";
export type PageTheme = { mode: PageMode; vars: Record<string, string> };

const FONT = `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
const MONO = `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

// The app's HSL triples (src/App.css), the fallback where there is no document to read them from (the box, the phone).
const TRIPLES: Record<PageMode, Record<string, string>> = {
  dark: { background: "0 0% 10%", foreground: "0 0% 92%", "muted-foreground": "0 0% 60%", muted: "0 0% 14%", border: "0 0% 22%", primary: "0 0% 85%" },
  light: { background: "0 0% 98%", foreground: "0 0% 12%", "muted-foreground": "0 0% 42%", muted: "0 0% 94%", border: "0 0% 88%", primary: "0 0% 20%" },
};
const MAP: [string, string][] = [
  ["--vc-bg", "background"], ["--vc-fg", "foreground"], ["--vc-muted", "muted-foreground"],
  ["--vc-surface", "muted"], ["--vc-border", "border"], ["--vc-accent", "primary"],
];

export const modeOf = (themeAttr: string | null | undefined): PageMode => (themeAttr === "light" ? "light" : "dark");

/** The page theme for a mode. `read(name)`: the app's CSS variable `--name` (an HSL triple), where a document has them. */
export function pageThemeFor(mode: PageMode, read?: (name: string) => string): PageTheme {
  const vars: Record<string, string> = {};
  for (const [out, name] of MAP) {
    const v = (read?.(name) ?? "").trim() || TRIPLES[mode][name]!;
    vars[out] = `hsl(${v})`;
  }
  vars["--vc-font"] = FONT;
  vars["--vc-mono"] = MONO;
  return { mode, vars };
}

/** The running app's theme, read from its document. */
export function appPageTheme(doc: Document = document): PageTheme {
  const cs = doc.defaultView?.getComputedStyle(doc.documentElement);
  return pageThemeFor(modeOf(doc.documentElement.dataset.theme), cs ? (n) => cs.getPropertyValue(`--${n}`) : undefined);
}

const safe = (s: string) => s.replace(/[<>{};]/g, "");
const rootRule = (t: PageTheme) => `:root{${Object.entries(t.vars).map(([k, v]) => `${k}:${safe(v)}`).join(";")};color-scheme:${t.mode}}`;
// Zero specificity: any rule the page writes for html/body wins.
const DEFAULTS = `:where(html){background:var(--vc-bg);color:var(--vc-fg)}`;

/** Markup for the top of a page's <head>: the variables, the default colours, and the script that follows the app's theme. */
export function pageThemeHead(t: PageTheme): string {
  const script =
    `(function(){var M=${JSON.stringify(PAGE_THEME_MSG)},d=document.documentElement;` +
    `function apply(t){if(!t||!t.vars)return;for(var k in t.vars)d.style.setProperty(k,t.vars[k]);` +
    `d.style.colorScheme=t.mode;d.setAttribute("data-vc-mode",t.mode);` +
    `try{dispatchEvent(new CustomEvent("vc-theme",{detail:t}));}catch(e){}}` +
    `addEventListener("message",function(e){var m=e.data;if(e.source===parent&&m&&m[M])apply(m[M]);});` +
    `try{parent.postMessage({${JSON.stringify(PAGE_THEME_HELLO)}:1},"*");}catch(e){}})();`;
  return `<style data-vc-theme>${rootRule(t)}${DEFAULTS}</style><script>${script}</script>`;
}

/** The host side, once per app window: when the theme changes (or a frame says hello) every page frame gets the new values. */
export function installPageTheme(doc: Document = document): () => void {
  const win = doc.defaultView!;
  const frames = () => Array.from(doc.querySelectorAll<HTMLIFrameElement>(`iframe[${PAGE_FRAME_ATTR}]`));
  const send = (f: HTMLIFrameElement) => {
    try {
      f.contentWindow?.postMessage({ [PAGE_THEME_MSG]: appPageTheme(doc) }, "*");
    } catch {
      /* the frame is between documents */
    }
  };
  const onMessage = (e: MessageEvent) => {
    const d = e.data as Record<string, unknown> | null;
    if (!d || typeof d !== "object" || !d[PAGE_THEME_HELLO]) return;
    const f = frames().find((x) => x.contentWindow === e.source);
    if (f) send(f);
  };
  const mo = new win.MutationObserver(() => frames().forEach(send));
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  win.addEventListener("message", onMessage);
  return () => {
    win.removeEventListener("message", onMessage);
    mo.disconnect();
  };
}
