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

function injectScrollbarStyles(html: string): string {
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + SCROLLBAR_INJECT);
  }
  return SCROLLBAR_INJECT + html;
}

export function HtmlView({ content }: { content: string }) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <iframe
        sandbox="allow-scripts"
        srcDoc={injectScrollbarStyles(content)}
        className="flex-1 w-full bg-background"
        title="HTML preview"
      />
    </div>
  );
}
