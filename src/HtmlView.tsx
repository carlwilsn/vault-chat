import { Eye } from "lucide-react";

export function HtmlView({ content }: { content: string }) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <div className="sticky top-0 z-10 bg-muted/80 backdrop-blur border-b border-border/60 px-6 py-1.5 flex items-center gap-2 text-[11px] text-muted-foreground shrink-0">
        <Eye className="h-3 w-3" />
        <span>Read-only HTML (sandboxed)</span>
      </div>
      <iframe
        sandbox=""
        srcDoc={content}
        className="flex-1 w-full bg-white"
        title="HTML preview"
      />
    </div>
  );
}
