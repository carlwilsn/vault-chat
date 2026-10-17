// The page a board widget runs in (board/INBOX.md, kind `widget`): the same
// document for the box's headless mount check (server/inbox.ts) and for the
// iPad's sandboxed iframe (board/src/items.ts), so what was checked is what runs.
//
// The widget is one module bundled by esbuild as an IIFE (global __vcWidget)
// exporting `mount(el, api)`; `api` is size(), onResize(fn) and theme. CSP
// `default-src 'none'`: inline script and style, data:/blob: images, nothing
// from the network. In the iframe it also runs under sandbox="allow-scripts"
// (no same origin: no storage, no parent page).
//
// The page reports in #vc-result: "ok", or the error that mount threw (or
// that the first ticks after it threw / rejected).

export const WIDGET_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

const RUNTIME = `
(function () {
  var out = document.getElementById("vc-result");
  var root = document.getElementById("vc-root");
  var done = false, errors = [];
  function report(msg) {
    if (msg) errors.push(String(msg));
    out.textContent = errors.length ? errors[0] : "ok";
  }
  window.addEventListener("error", function (e) { report((e.error && (e.error.stack || e.error.message)) || e.message || "error"); });
  window.addEventListener("unhandledrejection", function (e) { var r = e.reason; report((r && (r.stack || r.message)) || String(r)); });
  var fns = [];
  var api = {
    size: function () { return { w: root.clientWidth, h: root.clientHeight }; },
    onResize: function (fn) { if (typeof fn === "function") fns.push(fn); },
    theme: { mode: "light", ink: "#1f1f24", paper: "#ffffff", accent: "#1f5bd6", font: "-apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif" },
  };
  window.addEventListener("resize", function () { for (var i = 0; i < fns.length; i++) try { fns[i](api.size()); } catch (e) { report(e && (e.stack || e.message)); } });
  try {
    var m = window.__vcWidget || {};
    var f = typeof m.mount === "function" ? m.mount : m.default && typeof m.default.mount === "function" ? m.default.mount : typeof m.default === "function" ? m.default : null;
    if (!f) throw new Error("the module exports no mount(el, api)");
    var r = f(root, api);
    if (r && typeof r.then === "function") r.then(function () { report(); }, function (e) { report(e && (e.stack || e.message) || String(e)); });
    else report();
  } catch (e) {
    report(e && (e.stack || e.message) || String(e));
  }
})();`;

const scriptSafe = (js: string) => js.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

/** The whole widget document: `bundle` is esbuild's IIFE output. */
export function widgetDocument(bundle: string, layout: { w: number; h: number }): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">
<style>html,body{margin:0;padding:0;background:#fff;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif;color:#1f1f24}
#vc-root{position:relative;width:${layout.w}px;height:${layout.h}px;overflow:hidden}#vc-result{display:none}</style></head>
<body><div id="vc-root"></div><pre id="vc-result"></pre>
<script>${scriptSafe(bundle)}</script>
<script>${RUNTIME}</script></body></html>`;
}

/** The page the box typesets a math part on for its snapshot: `css` is KaTeX's (fonts inlined). Reports the height. */
export function mathDocument(html: string, css: string, width: number): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">
<style>${css}</style><style>${MATH_CSS}html,body{margin:0;background:#fff}#vc-result{display:none}</style></head>
<body><div class="vc-math" id="m" style="width:${width}px">${html}</div><pre id="vc-result"></pre>
<script>document.fonts.ready.then(function(){document.getElementById("vc-result").textContent=JSON.stringify({h:Math.ceil(document.getElementById("m").getBoundingClientRect().height)})});</script></body></html>`;
}

/** Typeset math's print style: black on transparent, a fixed reading size (the board app uses it too). */
export const MATH_CSS = `.vc-math{box-sizing:border-box;padding:14px 18px;font:18px/1.5 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;color:#111;background:transparent}
.vc-math>:first-child{margin-top:0}.vc-math>:last-child{margin-bottom:0}.vc-math p{margin:0 0 .6em}.vc-math ul,.vc-math ol{margin:0 0 .6em;padding-left:1.4em}
.vc-math table{border-collapse:collapse;margin:0 0 .6em}.vc-math th,.vc-math td{border:1px solid #bbb;padding:3px 8px}.vc-math .katex{font-size:1.08em}.vc-math .katex-display{margin:.5em 0}
.vc-math h1,.vc-math h2,.vc-math h3{font-size:1.05em;margin:0 0 .4em}.vc-math code{font-size:.9em}`;
