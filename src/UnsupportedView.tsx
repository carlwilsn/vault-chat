import { File as FileIcon, FolderOpen, ExternalLink } from "lucide-react";
import { revealInFileExplorer, openPathWithDefaultApp } from "./opener";

export function UnsupportedView({ path }: { path: string }) {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : "";

  const reveal = () => {
    revealInFileExplorer(path).catch((e) =>
      console.error("[opener] reveal failed:", e),
    );
  };
  const openWith = () => {
    openPathWithDefaultApp(path).catch((e) =>
      console.error("[opener] open failed:", e),
    );
  };

  return (
    <div className="flex-1 flex items-center justify-center p-8 bg-muted/10">
      <div className="max-w-md w-full flex flex-col items-center gap-4 text-center">
        <div className="h-16 w-16 rounded-lg bg-muted/60 border border-border flex items-center justify-center">
          <FileIcon className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <div className="text-[14px] font-medium text-foreground break-all">
            {name}
          </div>
          {ext && (
            <div className="text-[11px] text-muted-foreground font-mono uppercase">
              {ext} file
            </div>
          )}
          <div className="text-[12px] text-muted-foreground pt-1">
            No built-in viewer for this file type.
          </div>
        </div>
        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={openWith}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border bg-card hover:bg-accent/60 text-[12px] text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open with default app
          </button>
          <button
            onClick={reveal}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border bg-card hover:bg-accent/60 text-[12px] text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" /> File Explorer
          </button>
        </div>
      </div>
    </div>
  );
}
