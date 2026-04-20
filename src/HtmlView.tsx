import { Eye } from "lucide-react";

const SCROLLBAR_CSS = `<style>
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.35); border-radius: 9999px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.55); }
  html { scrollbar-width: thin; scrollbar-color: rgba(128,128,128,0.35) transparent; }
</style>`;

function injectScrollbarStyles(html: string): string {
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + SCROLLBAR_CSS);
  }
  return SCROLLBAR_CSS + html;
}

export function HtmlView({ content }: { content: string }) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <div className="sticky top-0 z-10 bg-muted/80 backdrop-blur border-b border-border/60 px-6 py-1.5 flex items-center gap-2 text-[11px] text-muted-foreground shrink-0">
        <Eye className="h-3 w-3" />
        <span>Read-only HTML (sandboxed)</span>
      </div>
      <iframe
        sandbox="allow-scripts"
        srcDoc={injectScrollbarStyles(content)}
        className="flex-1 w-full bg-white"
        title="HTML preview"
      />
    </div>
  );
}
