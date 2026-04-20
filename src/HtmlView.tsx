import { Eye } from "lucide-react";

function buildScrollbarCss(): string {
  const styles = getComputedStyle(document.documentElement);
  const border = styles.getPropertyValue("--border").trim() || "0 0% 22%";
  const mutedFg = styles.getPropertyValue("--muted-foreground").trim() || "0 0% 60%";
  const thumb = `hsl(${border})`;
  const thumbHover = `hsla(${mutedFg} / 0.55)`;
  return `<style>
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: ${thumb}; border-radius: 9999px; }
  ::-webkit-scrollbar-thumb:hover { background: ${thumbHover}; }
  html { scrollbar-width: thin; scrollbar-color: ${thumb} transparent; }
</style>`;
}

function injectScrollbarStyles(html: string): string {
  const css = buildScrollbarCss();
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + css);
  }
  return css + html;
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
