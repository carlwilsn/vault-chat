import { useEffect, useMemo, useRef, useState } from "react";
import { rewriteAssetUrls, resolveRelative, pageBaseUrl, withBase } from "./htmlAssets";
import { invoke } from "@tauri-apps/api/core";
import { isUnreadableAsText } from "./fileKind";
import { openUrl, isExternalHref } from "./opener";
import { InlineEditPrompt, type InlineEditRequest } from "./InlineEditPrompt";
import { useStore } from "./store";
import { reportScroll, scrollHtmlWith } from "./scrollTarget";
import { decodeTarget } from "./viewTarget";
const LINK_INTERCEPT = `<script>(function(){
  function isExternal(href){ return /^(https?:|mailto:)/i.test(href); }
  function handle(e){
    var btn = e.button || 0;
    if (btn !== 0 && btn !== 1) return;
    var el = e.target;
    while (el && el.tagName !== 'A') el = el.parentElement;
    if (!el) return;
    var href = el.getAttribute('href');
    if (!href) return;
    // The page has no address of its own (srcdoc): an in-page "#x" link would
    // resolve against the app's address and load vault-chat in this frame.
    if (href.charAt(0) === '#') {
      e.preventDefault();
      var id = decodeURIComponent(href.slice(1));
      var t = id ? (document.getElementById(id) || document.querySelector('[name="' + id.replace(/"/g, '') + '"]')) : null;
      if (t) t.scrollIntoView({ block: 'start' });
      else if (!id) window.scrollTo(0, 0);
      // A hash-routed page ("#/02-lecture"): its own router moves (the fragment of this frame's own address).
      else { try { location.hash = href; } catch(_) {} }
      return;
    }
    if (/^javascript:/i.test(href)) return;
    e.preventDefault();
    e.stopPropagation();
    if (isExternal(href)) {
      try { parent.postMessage({ __vc_open_url: href }, '*'); } catch(_) {}
    } else {
      // Another file in the vault: vault-chat opens it in its own viewer.
      try { parent.postMessage({ __vc_open_path: href }, '*'); } catch(_) {}
    }
  }
  document.addEventListener('click', handle, true);
  document.addEventListener('auxclick', handle, true);
})();</script>`;

// Injected into the iframe so the parent can request text inside a
// rectangle (in iframe-local client coords). The script walks text
// nodes, collects any whose range intersects the rect in reading order,
// and posts the result back. We also return a rough "before" and "after"
// slice of the full body text around the captured span so the ask has
// the same kind of context the PDF marquee provides.
const MARQUEE_BRIDGE = `<script>(function(){
  function collectText(root, rect){
    var hits = [];
    function walk(node){
      if (node.nodeType === 3) {
        var txt = node.nodeValue;
        if (!txt || !txt.trim()) return;
        var r = document.createRange();
        r.selectNodeContents(node);
        var br = r.getBoundingClientRect();
        if (br.width === 0 && br.height === 0) return;
        if (br.left < rect.right && br.right > rect.left && br.top < rect.bottom && br.bottom > rect.top) {
          hits.push({ text: txt.replace(/\\s+/g, ' ').trim(), top: br.top, bottom: br.bottom });
        }
        return;
      }
      if (node.nodeType !== 1) return;
      var tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
    }
    walk(root);
    hits.sort(function(a,b){ return a.top - b.top; });
    var out = '';
    var prevBottom = null;
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (!h.text) continue;
      if (prevBottom !== null && h.top > prevBottom + 4) out += '\\n';
      else if (out && !out.endsWith(' ') && !out.endsWith('\\n')) out += ' ';
      out += h.text;
      prevBottom = h.bottom;
    }
    return out.trim();
  }
  window.addEventListener('message', function(e){
    var data = e.data;
    if (!data) return;
    if (data.__vc_marquee_capture) {
      try {
        var captured = collectText(document.body, data.__vc_marquee_capture);
        var full = (document.body.innerText || '').replace(/\\s+\\n/g, '\\n');
        var before = '';
        var after = '';
        if (captured) {
          var idx = full.indexOf(captured.slice(0, Math.min(80, captured.length)));
          if (idx >= 0) {
            before = full.slice(Math.max(0, idx - 3000), idx);
            after = full.slice(idx + captured.length, Math.min(full.length, idx + captured.length + 3000));
          } else {
            before = full.slice(-3000);
          }
        } else {
          before = full.slice(-3000);
        }
        parent.postMessage({ __vc_marquee_result: { text: captured, before: before, after: after } }, '*');
      } catch(_) {
        parent.postMessage({ __vc_marquee_result: { text: '', before: '', after: '' } }, '*');
      }
    }
    if (data.__vc_look) {
      // LookAtScreen (src/screenLook.ts): the page as it is on screen — the
      // text in view, each image and canvas in view drawn as shown, the scroll.
      var W = innerWidth, H = innerHeight;
      var out = { id: data.__vc_look, text: '', images: [], failed: [], above: false, below: false, region: 'the whole page' };
      try { out.text = collectText(document.body, { left: 0, top: 0, right: W, bottom: H }); } catch(_) {}
      var els = document.querySelectorAll('img, canvas');
      for (var i = 0; i < els.length && out.images.length < 5; i++) {
        var el = els[i], b = el.getBoundingClientRect();
        if (b.width < 32 || b.height < 32 || b.right <= 0 || b.bottom <= 0 || b.left >= W || b.top >= H) continue;
        var label = el.tagName === 'CANVAS' ? ('drawing ' + (i + 1)) : ((el.getAttribute('alt') || (el.getAttribute('src') || '').split('/').pop() || ('image ' + (i + 1))).slice(0, 80));
        try {
          var url;
          if (el.tagName === 'CANVAS') url = el.toDataURL('image/png');
          else {
            var c = document.createElement('canvas');
            var s = Math.min(1, 2048 / Math.max(el.naturalWidth || 1, el.naturalHeight || 1));
            c.width = Math.max(1, Math.round((el.naturalWidth || b.width) * s));
            c.height = Math.max(1, Math.round((el.naturalHeight || b.height) * s));
            c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
            url = c.toDataURL('image/png');
          }
          out.images.push({ label: label, dataUrl: url, partial: b.left < 0 || b.top < 0 || b.right > W || b.bottom > H });
        } catch (err) {
          out.failed.push(label + ': the page may not read it (' + (err && err.name || 'error') + ')');
        }
      }
      var sh = document.documentElement.scrollHeight, y = scrollY;
      if (sh > H + 2) {
        out.above = y > 2; out.below = y + H < sh - 2;
        out.region = 'about ' + Math.round(y / sh * 100) + '%–' + Math.round((y + H) / sh * 100) + '% of the page';
      }
      parent.postMessage({ __vc_look_result: out }, '*');
    }
  });
})();</script>`;

// ScrollTo (src/scrollTarget.ts): the page's sections for the parent to match,
// then the move — to an id, a section, or the first place a phrase appears.
// A link section (a hash-routed page's nav) is followed like a click.
const SCROLL_BRIDGE = `<script>(function(){
  var found = [];
  function clean(s){ return (s || '').replace(/\\s+/g, ' ').trim(); }
  function list(){
    found = [];
    var out = [];
    var els = document.querySelectorAll('h1,h2,h3,h4,h5,h6,a[href^="#"]');
    for (var i = 0; i < els.length && out.length < 400; i++) {
      var el = els[i], text = clean(el.innerText || el.textContent);
      if (!text) continue;
      if (el.tagName === 'A') {
        var h = el.getAttribute('href') || '';
        if (h === '#' || h === '#top') continue;
        found.push(el); out.push({ id: h.slice(1), text: text.slice(0, 200), link: true });
      } else {
        var idEl = el.id ? el : (el.querySelector('[id]') || (el.parentElement && /^(SECTION|ARTICLE)$/.test(el.parentElement.tagName) && el.parentElement.firstElementChild === el && el.parentElement.id ? el.parentElement : null));
        found.push(el); out.push({ id: idEl ? idEl.id : undefined, text: text.slice(0, 200) });
      }
    }
    return out;
  }
  function norm(s){ return clean(s).toLowerCase(); }
  function byText(q){
    var want = norm(q);
    if (!want) return null;
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    for (var n = w.nextNode(); n; n = w.nextNode()) {
      var p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
      if (norm(n.nodeValue).indexOf(want) >= 0) return p;
    }
    // Across inline markup ("the <em>Bellman</em> equation"): the deepest block that holds it.
    var blocks = document.body.querySelectorAll('p,li,td,th,dt,dd,blockquote,pre,figcaption,caption,summary,h1,h2,h3,h4,h5,h6');
    for (var i = 0; i < blocks.length; i++) if (norm(blocks[i].textContent).indexOf(want) >= 0) return blocks[i];
    return null;
  }
  function visible(el){ var b = el.getBoundingClientRect(); return b.width > 0 || b.height > 0; }
  function go(el){ el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  window.addEventListener('message', function(e){
    var d = e.data;
    if (!d) return;
    if (d.__vc_scroll_list) {
      var q = String(d.__vc_scroll_list.q || '').replace(/^#/, '');
      var byId = q ? (document.getElementById(q) || document.getElementById(decodeURIComponent(q))) : null;
      parent.postMessage({ __vc_scroll_list_result: { req: d.__vc_scroll_list.req, sections: list(), byId: !!(byId && visible(byId)) } }, '*');
    }
    if (d.__vc_scroll_go) {
      var g = d.__vc_scroll_go, r = { req: g.req, ok: false, where: '', error: '' };
      try {
        if (g.id) {
          var t = document.getElementById(g.id) || document.getElementById(decodeURIComponent(g.id));
          if (t) { go(t); r.ok = true; r.where = '#' + g.id; }
        } else if (typeof g.i === 'number' && found[g.i]) {
          var el = found[g.i];
          if (el.tagName === 'A') { el.click(); r.ok = true; r.where = 'the link "' + clean(el.textContent).slice(0, 80) + '"'; r.link = true; }
          else { go(el); r.ok = true; r.where = '"' + clean(el.textContent).slice(0, 80) + '"'; }
        } else if (g.text) {
          var at = byText(g.text);
          if (at) { go(at); r.ok = true; r.where = 'the text "' + clean(g.text).slice(0, 80) + '"'; }
        }
      } catch (err) { r.error = String(err && err.message || err); }
      parent.postMessage({ __vc_scroll_done: r }, '*');
    }
  });
})();</script>`;

const SCROLLBAR_INJECT = `<style id="__vc_scrollbar_base">
  ::-webkit-scrollbar { width: 5px; height: 5px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 9999px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.5); }
  html { scrollbar-width: thin; scrollbar-color: rgba(128,128,128,0.3) transparent; }
</style>
<script>(function(){
  function apply(){
    var bg = getComputedStyle(document.body).backgroundColor;
    var m = bg && bg.match(/\\d+(?:\\.\\d+)?/g);
    if (!m || m.length < 3) return;
    document.documentElement.style.background = bg;
    var lum = (+m[0]*0.299 + +m[1]*0.587 + +m[2]*0.114);
    var dark = lum < 128;
    var thumb = dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.22)';
    var hover = dark ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.38)';
    var s = document.getElementById('__vc_scrollbar_tint') || document.createElement('style');
    s.id = '__vc_scrollbar_tint';
    s.textContent = '::-webkit-scrollbar{background:'+bg+'}'
      + '::-webkit-scrollbar-track{background:'+bg+'}'
      + '::-webkit-scrollbar-thumb{background:'+thumb+'}'
      + '::-webkit-scrollbar-thumb:hover{background:'+hover+'}'
      + 'html{scrollbar-color:'+thumb+' '+bg+'}';
    document.head.appendChild(s);
  }
  function run(){ apply(); setTimeout(apply, 100); setTimeout(apply, 500); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();</script>`;

// Reports the page's scroll to the parent, and (on a reload of the same page
// with new content: an agent's edit shown live) puts it back where it was.
const scrollKeeper = (y: number) => `<script>(function(){
  var y = ${Math.max(0, Math.round(y))};
  if (y) addEventListener('load', function(){ scrollTo(0, y); setTimeout(function(){ scrollTo(0, y); }, 50); });
  var t = 0;
  addEventListener('scroll', function(){
    clearTimeout(t);
    t = setTimeout(function(){ try { parent.postMessage({ __vc_scroll: scrollY }, '*'); } catch(_) {} }, 80);
  }, { passive: true });
})();</script>`;

// The open vault, registered once with the vcpage protocol (vault_page.rs):
// its index in page URLs, or null where there is no protocol (the preview,
// a host without it) and pages keep the markup rewrite.
const pageRoots = new Map<string, Promise<number | null>>();
function pageRoot(vault: string): Promise<number | null> {
  let p = pageRoots.get(vault);
  if (!p) {
    p = invoke<number>("vault_page_root", { root: vault }).then(
      (i) => (typeof i === "number" ? i : null),
      (err) => {
        console.warn("[html] vault pages load without their folder:", err);
        return null;
      },
    );
    pageRoots.set(vault, p);
  }
  return p;
}
const settledRoots = new Map<string, number | null>();

/** The page's folder as its base URL (null: no base); undefined while the vault registers. */
function usePageBase(path: string | null | undefined): string | null | undefined {
  const vault = useStore((s) => s.vaultPath);
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!vault || settledRoots.has(vault)) return;
    let live = true;
    void pageRoot(vault).then((i) => {
      settledRoots.set(vault, i);
      if (live) rerender((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [vault]);
  if (!vault || !path) return null;
  if (!settledRoots.has(vault)) return undefined;
  const i = settledRoots.get(vault);
  return i == null ? null : pageBaseUrl(i, vault, path);
}

function injectHeadScripts(html: string, scrollY = 0): string {
  const payload = SCROLLBAR_INJECT + LINK_INTERCEPT + MARQUEE_BRIDGE + SCROLL_BRIDGE + scrollKeeper(scrollY);
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + payload);
  }
  return payload + html;
}

/** Ask the page (SCROLL_BRIDGE) and wait for its answer; resent until the page's bridge is up (a page still loading). */
function askFrame<T>(frame: () => HTMLIFrameElement | null, msg: Record<string, unknown>, pick: (d: any) => T | undefined, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMsg);
      clearInterval(resend);
      clearTimeout(stop);
      resolve(v);
    };
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame()?.contentWindow) return;
      const v = pick(e.data);
      if (v !== undefined) finish(v);
    };
    const send = () => {
      try {
        frame()?.contentWindow?.postMessage(msg, "*");
      } catch {
        /* the frame is between documents: the next send */
      }
    };
    window.addEventListener("message", onMsg);
    const resend = setInterval(send, 400);
    const stop = setTimeout(() => finish(null), ms);
    send();
  });
}

let scrollReq = 0;

/** ScrollTo on an HTML page: an id, a section (heading or in-page link) by its text or slug, else the first place the phrase appears. */
export async function scrollHtml(frame: () => HTMLIFrameElement | null, anchor: string, path: string): Promise<string> {
  return scrollHtmlWith((msg, pick, ms) => askFrame(frame, msg, pick, ms), decodeTarget(anchor), path, ++scrollReq);
}

export function HtmlView({ content, path }: { content: string; path?: string | null }) {
  // The page's last scroll (reported by scrollKeeper); a new path starts at the top.
  const scrollRef = useRef<{ path: string | null | undefined; y: number }>({ path, y: 0 });
  if (scrollRef.current.path !== path) scrollRef.current = { path, y: 0 };
  // The page loads its own files as from its folder: a base at that folder
  // (relative URLs in markup, CSS and script alike); the markup rewrite only
  // for absolute paths, or for a page with no base.
  const base = usePageBase(path);
  const srcDoc = useMemo(() => {
    if (base === undefined) return null;
    const html = path ? rewriteAssetUrls(content, path, !base) : content;
    return injectHeadScripts(base ? withBase(html, base) : html, scrollRef.current.y);
  }, [content, path, base]);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [marqueeOn, setMarqueeOn] = useState(false);
  const [marquee, setMarquee] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);
  const pendingCaptureRef = useRef<{
    anchor: InlineEditRequest["anchor"];
  } | null>(null);
  const [inlineAsk, setInlineAsk] = useState<InlineEditRequest | null>(null);

  useEffect(() => {
    const onToggle = () => setMarqueeOn((v) => !v);
    window.addEventListener("vc-marquee-toggle", onToggle);
    return () => window.removeEventListener("vc-marquee-toggle", onToggle);
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const sy = (e.data as { __vc_scroll?: unknown } | null)?.__vc_scroll;
      if (typeof sy === "number") {
        scrollRef.current.y = sy;
        return;
      }
      const data = e.data as {
        __vc_open_url?: unknown;
        __vc_open_path?: unknown;
        __vc_marquee_result?: { text?: unknown; before?: unknown; after?: unknown };
      } | null;
      if (typeof data?.__vc_open_path === "string" && path) {
        const rel = data.__vc_open_path.replace(/^file:\/\/\/?/, "").split("#")[0].split("?")[0];
        if (rel) {
          const target = /^([a-zA-Z]:[\/\\]|[\/\\])/.test(rel) ? rel : resolveRelative(path, decodeURIComponent(rel));
          void (async () => {
            try {
              const content = isUnreadableAsText(target) ? "" : await invoke<string>("read_text_file", { path: target });
              useStore.getState().setCurrentFile(target, content);
            } catch (err) {
              console.warn("[html] couldn't open linked file:", target, err);
            }
          })();
        }
        return;
      }
      if (typeof data?.__vc_open_url === "string" && isExternalHref(data.__vc_open_url)) {
        openUrl(data.__vc_open_url).catch((err) =>
          console.error("[opener] failed:", err),
        );
        return;
      }
      const mr = data?.__vc_marquee_result;
      if (mr && typeof mr.text !== "undefined") {
        const pending = pendingCaptureRef.current;
        pendingCaptureRef.current = null;
        if (!pending) return;
        const selection = typeof mr.text === "string" ? mr.text : "";
        const curPath = useStore.getState().currentFile;
        // Marquee output is owned by whichever popup it feeds. Don't
        // stash in lastCapture — Ctrl+N stays vault-context-only.
        const store = useStore.getState();
        if (store.noteCapturePending && curPath) {
          // HTML doesn't snapshot pixels — just pipe the selection text
          // into the composer's primary anchor and come back.
          const stashed = store.noteComposer;
          const prev = stashed.initialAnchors ?? [];
          const hasPrimary = prev.some((a) => a.primary);
          const updated = prev.length > 0
            ? prev.map((a) =>
                a.primary ? { ...a, source_selection: selection || a.source_selection } : a,
              )
            : [];
          const anchors = hasPrimary
            ? updated
            : [
                ...updated,
                {
                  source_path: curPath,
                  source_kind: "html" as const,
                  source_anchor: null,
                  source_selection: selection || null,
                  primary: true,
                },
              ];
          store.openNoteComposer({
            initialDraft: stashed.initialDraft,
            initialAnchors: anchors,
            initialTurns: stashed.initialTurns,
          });
          store.setNoteCapturePending(false);
          return;
        }
        setInlineAsk({
          anchor: pending.anchor,
          selection,
          before: typeof mr.before === "string" ? mr.before : "",
          after: typeof mr.after === "string" ? mr.after : "",
          language: "html",
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // ScrollTo (voice): match the request against the page's sections, move, answer the tool.
  const pendingScrollAnchor = useStore((s) => s.pendingScrollAnchor);
  useEffect(() => {
    const req = pendingScrollAnchor;
    if (!req || !path || req.path !== path) return;
    useStore.getState().clearScrollAnchor();
    void scrollHtml(() => iframeRef.current, req.anchor, path).then((outcome) => reportScroll(path, outcome));
  }, [pendingScrollAnchor, path]);

  // Marquee drag over the iframe. The overlay div sits on top of the
  // iframe while marqueeOn is true and eats pointer events so the drag
  // stays in our code rather than reaching page content.
  useEffect(() => {
    if (!marqueeOn) return;
    const host = hostRef.current;
    if (!host) return;

    let lastMove: { x: number; y: number } | null = null;
    let capturedPointerId: number | null = null;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      marqueeStartRef.current = { x: e.clientX, y: e.clientY };
      lastMove = { x: e.clientX, y: e.clientY };
      setMarquee({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY });
      try {
        host.setPointerCapture(e.pointerId);
        capturedPointerId = e.pointerId;
      } catch {
        /* older platforms — fall back to window-level listeners */
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!marqueeStartRef.current) return;
      lastMove = { x: e.clientX, y: e.clientY };
      setMarquee({
        x1: marqueeStartRef.current.x,
        y1: marqueeStartRef.current.y,
        x2: e.clientX,
        y2: e.clientY,
      });
    };

    const onUp = (e: PointerEvent) => {
      const start = marqueeStartRef.current;
      marqueeStartRef.current = null;
      if (capturedPointerId !== null) {
        try {
          host.releasePointerCapture(capturedPointerId);
        } catch {
          /* already released */
        }
        capturedPointerId = null;
      }
      if (!start) return;
      const endX = lastMove?.x ?? e.clientX;
      const endY = lastMove?.y ?? e.clientY;
      lastMove = null;
      const clientRect = {
        left: Math.min(start.x, endX),
        top: Math.min(start.y, endY),
        right: Math.max(start.x, endX),
        bottom: Math.max(start.y, endY),
      };
      setMarquee(null);
      if (clientRect.right - clientRect.left < 3 || clientRect.bottom - clientRect.top < 3) return;

      const iframe = iframeRef.current;
      if (!iframe) return;
      const ifr = iframe.getBoundingClientRect();
      // Convert viewport-client rect to iframe-local client rect.
      const iframeRect = {
        left: clientRect.left - ifr.left,
        top: clientRect.top - ifr.top,
        right: clientRect.right - ifr.left,
        bottom: clientRect.bottom - ifr.top,
      };

      const dirX = endX === start.x ? 1 : Math.sign(endX - start.x);
      const dirY = endY === start.y ? 1 : Math.sign(endY - start.y);
      pendingCaptureRef.current = {
        anchor: {
          left: clientRect.left,
          top: clientRect.top,
          right: clientRect.right,
          bottom: clientRect.bottom,
          dirX,
          dirY,
        },
      };
      setMarqueeOn(false);
      try {
        iframe.contentWindow?.postMessage(
          { __vc_marquee_capture: iframeRect },
          "*",
        );
      } catch (err) {
        console.error("[marquee] postMessage failed:", err);
        pendingCaptureRef.current = null;
      }
    };

    const onKeyEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        marqueeStartRef.current = null;
        setMarquee(null);
        setMarqueeOn(false);
        const s = useStore.getState();
        s.setChatPaneCapturePending(false);
        s.setEditPromptCapturePending(false);
        s.setNoteCapturePending(false);
        s.setVoiceCapturePending(false);
      }
    };

    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKeyEsc);
    return () => {
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKeyEsc);
    };
  }, [marqueeOn]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background relative">
      <div className="flex-1 relative">
        {srcDoc !== null && <iframe
          ref={iframeRef}
          data-look-frame
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          // Pages render as authored for a normal (light) browser: the app's dark
          // theme must not flip a page's own `prefers-color-scheme: dark` styles,
          // and a page with no background shows white, not the app's colour.
          style={{ colorScheme: "light" }}
          className="absolute inset-0 w-full h-full bg-white"
          title="HTML preview"
        />}
        {marqueeOn && (
          <div
            ref={hostRef}
            className="absolute inset-0 z-20 cursor-crosshair select-none"
          />
        )}
        {marqueeOn && (
          <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 z-30 rounded-full bg-card border border-border shadow px-3 py-1 text-[10.5px] text-muted-foreground">
            drag a box over content · Esc to cancel
          </div>
        )}
      </div>
      {marquee && (
        <div
          className="pointer-events-none fixed z-40 border border-primary/80 bg-primary/15 rounded-sm"
          style={{
            left: Math.min(marquee.x1, marquee.x2),
            top: Math.min(marquee.y1, marquee.y2),
            width: Math.abs(marquee.x2 - marquee.x1),
            height: Math.abs(marquee.y2 - marquee.y1),
          }}
        />
      )}
      {inlineAsk && (
        <InlineEditPrompt
          request={inlineAsk}
          initialMode="ask"
          askOnly
          onAccept={() => setInlineAsk(null)}
          onCancel={() => setInlineAsk(null)}
        />
      )}
    </div>
  );
}
