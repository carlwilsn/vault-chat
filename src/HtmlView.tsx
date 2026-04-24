import { useEffect, useRef, useState } from "react";
import { openUrl, isExternalHref } from "./opener";
import { InlineEditPrompt, type InlineEditRequest } from "./InlineEditPrompt";
import { useStore } from "./store";

const LINK_INTERCEPT = `<script>(function(){
  function isExternal(href){ return /^(https?:|mailto:)/i.test(href); }
  function handle(e){
    var btn = e.button || 0;
    if (btn !== 0 && btn !== 1) return;
    var el = e.target;
    while (el && el.tagName !== 'A') el = el.parentElement;
    if (!el) return;
    var href = el.getAttribute('href');
    if (!href || !isExternal(href)) return;
    e.preventDefault();
    e.stopPropagation();
    try { parent.postMessage({ __vc_open_url: href }, '*'); } catch(_) {}
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

function injectHeadScripts(html: string): string {
  const payload = SCROLLBAR_INJECT + LINK_INTERCEPT + MARQUEE_BRIDGE;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + payload);
  }
  return payload + html;
}

export function HtmlView({ content }: { content: string }) {
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
      const data = e.data as {
        __vc_open_url?: unknown;
        __vc_marquee_result?: { text?: unknown; before?: unknown; after?: unknown };
      } | null;
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
        if (curPath) {
          useStore.getState().setLastCapture({
            path: curPath,
            source_anchor: null,
            selection: selection || null,
            imageDataUrl: null,
            timestamp: Date.now(),
          });
        }
        const store = useStore.getState();
        if (store.noteCapturePending && curPath) {
          // HTML doesn't snapshot pixels — just pipe the selection text
          // into the note's primary anchor and come back.
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
        <iframe
          ref={iframeRef}
          sandbox="allow-scripts"
          srcDoc={injectHeadScripts(content)}
          className="absolute inset-0 w-full h-full bg-background"
          title="HTML preview"
        />
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
