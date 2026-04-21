import { useEffect, useRef } from "react";
import { openUrl, isExternalHref } from "./opener";

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
  const payload = SCROLLBAR_INJECT + LINK_INTERCEPT;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + payload);
  }
  return payload + html;
}

export function HtmlView({ content }: { content: string }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data as { __vc_open_url?: unknown } | null;
      const href = data?.__vc_open_url;
      if (typeof href !== "string" || !isExternalHref(href)) return;
      openUrl(href).catch((err) => console.error("[opener] failed:", err));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        srcDoc={injectHeadScripts(content)}
        className="flex-1 w-full bg-background"
        title="HTML preview"
      />
    </div>
  );
}
