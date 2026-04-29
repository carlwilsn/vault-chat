import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { Eye } from "lucide-react";
import "katex/dist/katex.min.css";

const KATEX_OPTIONS = { strict: "ignore", errorColor: "currentColor" } as const;

type NbCell =
  | { cell_type: "markdown"; source: string | string[] }
  | {
      cell_type: "code";
      source: string | string[];
      execution_count: number | null;
      outputs: NbOutput[];
    }
  | { cell_type: "raw"; source: string | string[] };

type NbOutput =
  | { output_type: "stream"; name: string; text: string | string[] }
  | {
      output_type: "execute_result" | "display_data";
      data: Record<string, string | string[]>;
      execution_count?: number | null;
    }
  | { output_type: "error"; ename: string; evalue: string; traceback: string[] };

type Notebook = {
  cells: NbCell[];
  metadata?: { kernelspec?: { name?: string; display_name?: string }; language_info?: { name?: string } };
};

const joinSource = (s: string | string[]): string =>
  Array.isArray(s) ? s.join("") : s;

const pickMime = (data: Record<string, string | string[]>): { mime: string; value: string } | null => {
  const prefer = ["text/html", "image/svg+xml", "image/png", "image/jpeg", "text/markdown", "text/plain"];
  for (const m of prefer) if (m in data) return { mime: m, value: joinSource(data[m]) };
  const keys = Object.keys(data);
  if (keys.length > 0) return { mime: keys[0], value: joinSource(data[keys[0]]) };
  return null;
};

const stripAnsi = (s: string): string =>
  s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");

export function NotebookView({ content }: { content: string }) {
  const nb = useMemo<Notebook | { error: string }>(() => {
    try {
      return JSON.parse(content) as Notebook;
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [content]);

  if ("error" in nb) {
    return (
      <div className="flex-1 overflow-auto p-8 text-destructive text-sm font-mono">
        Failed to parse notebook: {nb.error}
      </div>
    );
  }

  const lang =
    nb.metadata?.language_info?.name ??
    nb.metadata?.kernelspec?.name ??
    "python";

  return (
    <div className="flex-1 overflow-auto">
      <div className="sticky top-0 z-10 bg-muted/80 backdrop-blur border-b border-border/60 px-6 py-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Eye className="h-3 w-3" />
        <span>Read-only notebook view</span>
        <span className="opacity-60">·</span>
        <span className="font-mono">{nb.metadata?.kernelspec?.display_name ?? lang}</span>
      </div>
      <div className="max-w-[980px] mx-auto px-6 py-6 space-y-4">
        {nb.cells.map((cell, i) => (
          <Cell key={i} cell={cell} lang={lang} />
        ))}
      </div>
    </div>
  );
}

function Cell({ cell, lang }: { cell: NbCell; lang: string }) {
  if (cell.cell_type === "markdown") {
    return (
      <div className="prose-md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[[rehypeKatex, KATEX_OPTIONS], rehypeHighlight]}
        >
          {joinSource(cell.source)}
        </ReactMarkdown>
      </div>
    );
  }
  if (cell.cell_type === "raw") {
    return (
      <pre className="text-[12.5px] font-mono bg-muted/40 rounded p-3 overflow-x-auto whitespace-pre-wrap">
        {joinSource(cell.source)}
      </pre>
    );
  }
  const src = joinSource(cell.source);
  const fenced = "```" + lang + "\n" + src + "\n```";
  const count = cell.execution_count == null ? " " : String(cell.execution_count);
  return (
    <div className="border border-border/50 rounded overflow-hidden">
      <div className="flex">
        <div className="shrink-0 w-16 bg-muted/40 px-2 py-2 text-right text-[10.5px] font-mono text-muted-foreground/80 border-r border-border/50 select-none">
          In [{count}]:
        </div>
        <div className="flex-1 min-w-0">
          <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{fenced}</ReactMarkdown>
        </div>
      </div>
      {cell.outputs.length > 0 && (
        <div className="border-t border-border/40">
          {cell.outputs.map((out, j) => (
            <OutputView key={j} out={out} />
          ))}
        </div>
      )}
    </div>
  );
}

function OutputView({ out }: { out: NbOutput }) {
  if (out.output_type === "stream") {
    const cls = out.name === "stderr" ? "text-destructive/90" : "text-foreground/85";
    return (
      <pre className={`text-[12px] font-mono px-3 py-2 overflow-x-auto whitespace-pre-wrap ${cls}`}>
        {joinSource(out.text)}
      </pre>
    );
  }
  if (out.output_type === "error") {
    const tb = out.traceback.map(stripAnsi).join("\n");
    return (
      <pre className="text-[12px] font-mono px-3 py-2 overflow-x-auto whitespace-pre-wrap text-destructive/90 bg-destructive/5">
        {tb || `${out.ename}: ${out.evalue}`}
      </pre>
    );
  }
  const picked = pickMime(out.data);
  if (!picked) return null;
  const count = "execution_count" in out && out.execution_count != null ? String(out.execution_count) : " ";
  const inner = renderMime(picked.mime, picked.value);
  return (
    <div className="flex">
      <div className="shrink-0 w-16 bg-muted/20 px-2 py-2 text-right text-[10.5px] font-mono text-muted-foreground/70 border-r border-border/40 select-none">
        Out[{count}]:
      </div>
      <div className="flex-1 min-w-0 px-3 py-2 overflow-x-auto">{inner}</div>
    </div>
  );
}

function renderMime(mime: string, value: string) {
  if (mime === "image/png" || mime === "image/jpeg") {
    const src = value.startsWith("data:") ? value : `data:${mime};base64,${value.trim()}`;
    return <img src={src} alt="output" className="max-w-full h-auto" />;
  }
  if (mime === "image/svg+xml") {
    return <div dangerouslySetInnerHTML={{ __html: value }} />;
  }
  if (mime === "text/html") {
    return <div className="nb-html" dangerouslySetInnerHTML={{ __html: value }} />;
  }
  if (mime === "text/markdown") {
    return (
      <div className="prose-md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[[rehypeKatex, KATEX_OPTIONS], rehypeHighlight]}
        >
          {value}
        </ReactMarkdown>
      </div>
    );
  }
  return (
    <pre className="text-[12px] font-mono whitespace-pre-wrap">{value}</pre>
  );
}
