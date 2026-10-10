// Pieces every history style shares, all cut from today's HistoryModal and
// ChatsPanel (same sizes, colours and glyphs) so the three styles differ only
// in where they put them.

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { FilePlus, FileText, FileX, Pencil } from "lucide-react";
import { preprocessMarkdownMath } from "./mdMath";
import { fileKind } from "./fileKind";
import { cn } from "./lib/utils";
import {
  bucketOf,
  historyNoteVersions,
  historyTimeline,
  relTime,
  type HistoryEntry,
  type NoteVersion,
} from "./history";

const KATEX_OPTIONS = { strict: "ignore", errorColor: "currentColor" } as const;

export function StatusGlyph({ status }: { status: string }) {
  if (status === "A") return <FilePlus className="h-3 w-3 text-emerald-500 shrink-0" />;
  if (status === "D") return <FileX className="h-3 w-3 text-destructive shrink-0" />;
  if (status === "M") return <Pencil className="h-3 w-3 text-primary/70 shrink-0" />;
  return <FileText className="h-3 w-3 text-muted-foreground/70 shrink-0" />;
}

/** Today's AuthorChip, plus "mission" in the same pattern and a machine
 *  word when the work was not done on this laptop. */
export function ActorChip({ actor, machine }: { actor: string; machine?: string | null }) {
  const label = actor === "agent" ? "agent" : actor === "mission" ? "mission" : "you";
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={cn(
          "rounded px-1.5 py-px text-[9.5px]",
          actor === "agent"
            ? "bg-amber-500/15 text-amber-600"
            : actor === "mission"
              ? "bg-sky-500/15 text-sky-600"
              : "bg-primary/10 text-primary/80",
        )}
      >
        {label}
      </span>
      {machine && machine !== "laptop" && <span className="text-[9.5px] text-muted-foreground">on {machine}</span>}
    </span>
  );
}

export function actorDot(actor: string): string {
  return actor === "agent" ? "bg-amber-500" : actor === "mission" ? "bg-sky-500" : "bg-primary/50";
}

/** A version of a note as the main view would render it. */
export function HistoricalPreview({ path, content, deleted }: { path: string; content: string; deleted?: boolean }) {
  if (deleted || content === "") {
    return <div className="text-[12px] text-muted-foreground p-4 italic">(the note did not exist in this version)</div>;
  }
  const { kind, ext } = fileKind(path);
  if (kind === "markdown") {
    return (
      <div className="prose-chat px-4 py-3">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
          rehypePlugins={[rehypeRaw, [rehypeKatex, KATEX_OPTIONS], rehypeHighlight]}
        >
          {preprocessMarkdownMath(content)}
        </ReactMarkdown>
      </div>
    );
  }
  if (kind === "code") {
    const fenced = "```" + (ext || "") + "\n" + content + "\n```";
    return (
      <div className="prose-chat px-4 py-3">
        <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{fenced}</ReactMarkdown>
      </div>
    );
  }
  return <div className="text-[12px] text-muted-foreground p-4">Preview not available for {kind}. The diff shows what would change.</div>;
}

export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <div className="text-[12px] text-muted-foreground p-4 italic">Identical to the note as it is now.</div>;
  }
  return (
    <pre className="text-[11.5px] font-mono whitespace-pre-wrap p-3 leading-relaxed">
      {diff.split("\n").map((l, i) => {
        let cls = "text-foreground/80";
        if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff --git") || l.startsWith("index ") || l.startsWith("@@")) {
          cls = "text-muted-foreground";
        } else if (l.startsWith("+")) cls = "text-emerald-500";
        else if (l.startsWith("-")) cls = "text-destructive";
        return (
          <span key={i} className={cls}>
            {l}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

export function LineCounts({ add, del }: { add: number; del: number }) {
  return (
    <span className="text-[10.5px] font-mono shrink-0 inline-flex items-center gap-1.5">
      {add > 0 && <span className="text-emerald-500">+{add}</span>}
      {del > 0 && <span className="text-destructive">-{del}</span>}
    </span>
  );
}

export function entryMeta(e: HistoryEntry): string {
  if (e.kind === "undo" || e.kind === "redo" || e.kind === "restore") return e.summary ?? e.title;
  const n = e.files.length;
  const add = e.files.reduce((s, f) => s + f.add, 0);
  const del = e.files.reduce((s, f) => s + f.del, 0);
  const parts = [`${n} ${n === 1 ? "note" : "notes"}`, `+${add} −${del}`];
  if (e.cost_usd != null) parts.push(`$${e.cost_usd.toFixed(2)}`);
  return parts.join(" · ");
}

/** An entry as a ChatsPanel-style row: dot, 12px title, time, one meta line. */
export function EntryRow({ entry, selected, onClick, compact }: { entry: HistoryEntry; selected?: boolean; onClick: () => void; compact?: boolean }) {
  const undone = !!entry.undone_by;
  const sub = entry.actor === "agent" && entry.summary ? entry.summary : entryMeta(entry);
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left flex items-start gap-2 border-b border-border/40 hover:bg-accent/40",
        compact ? "px-4 py-2" : "px-3 py-2",
        selected && "bg-accent/60",
      )}
    >
      <span className={cn("h-1.5 w-1.5 mt-[7px] shrink-0 rounded-full", actorDot(entry.actor))} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={cn("text-[12px] truncate flex-1", undone ? "line-through text-muted-foreground" : "text-foreground")}>{entry.title}</span>
          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{relTime(entry.end)}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground min-w-0">
          <ActorChip actor={entry.actor} machine={entry.machine} />
          <span className="truncate">{undone ? "undone" : sub}</span>
        </span>
      </span>
    </button>
  );
}

export function BucketLabel({ label }: { label: string }) {
  return <div className="px-3 pt-3 pb-1 text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">{label}</div>;
}

/** Entries with Today / Yesterday / This week / Earlier headers. */
export function BucketedEntries({ entries, render }: { entries: HistoryEntry[]; render: (e: HistoryEntry) => React.ReactNode }) {
  let last = "";
  const out: React.ReactNode[] = [];
  for (const e of entries) {
    const b = bucketOf(e.end);
    if (b !== last) {
      out.push(<BucketLabel key={`b-${b}-${e.id}`} label={b} />);
      last = b;
    }
    out.push(render(e));
  }
  return <>{out}</>;
}

/** The timeline, paged, reloadable. */
export function useTimeline(vault: string | null, active: boolean) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const reload = useCallback(async () => {
    if (!vault) return;
    try {
      const p = await historyTimeline(vault, { limit: 40 });
      setEntries(p.entries);
      setCursor(p.next_cursor);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    setLoaded(true);
  }, [vault]);
  const more = useCallback(async () => {
    if (!vault || !cursor || busy.current) return;
    busy.current = true;
    try {
      const p = await historyTimeline(vault, { cursor, limit: 40 });
      setEntries((x) => [...x, ...p.entries]);
      setCursor(p.next_cursor);
    } catch (e) {
      setError(String(e));
    }
    busy.current = false;
  }, [vault, cursor]);
  useEffect(() => {
    if (active) {
      setLoaded(false);
      reload();
    }
  }, [active, reload]);
  return { entries, loaded, error, hasMore: !!cursor, more, reload };
}

export function useNoteVersions(vault: string | null, path: string | null) {
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    if (!vault || !path) {
      setVersions([]);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    try {
      const p = await historyNoteVersions(vault, path);
      setVersions(p.versions);
      setCursor(p.next_cursor);
    } catch {
      setVersions([]);
    }
    setLoaded(true);
  }, [vault, path]);
  const more = useCallback(async () => {
    if (!vault || !path || !cursor) return;
    const p = await historyNoteVersions(vault, path, cursor);
    setVersions((x) => [...x, ...p.versions]);
    setCursor(p.next_cursor);
  }, [vault, path, cursor]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { versions, loaded, hasMore: !!cursor, more, reload };
}

/** Infinite scroll: call `more` when the sentinel scrolls into view. */
export function MoreSentinel({ onMore, label = "Loading earlier…" }: { onMore: () => void; label?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((xs) => {
      if (xs.some((x) => x.isIntersecting)) onMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [onMore]);
  return (
    <div ref={ref} className="px-3 py-2 text-[10.5px] text-muted-foreground">
      {label}
    </div>
  );
}

export function versionLabel(v: NoteVersion): string {
  if (v.kind === "restore") return "Restored";
  if (v.kind === "undo") return "Undo";
  if (v.kind === "redo") return "Redo";
  if (v.deleted) return "Deleted";
  return v.actor === "agent" ? "Agent edit" : v.actor === "mission" ? "Mission" : "Your edit";
}

/** One version of a note as a vertical-list row. */
export function VersionRow({ v, current, selected, onClick, trailing }: { v: NoteVersion; current: boolean; selected?: boolean; onClick: () => void; trailing?: React.ReactNode }) {
  return (
    <div className={cn("group border-b border-border/40 flex items-start gap-2 hover:bg-accent/40", selected && "bg-accent/60")}>
      <button onClick={onClick} className="flex-1 min-w-0 text-left px-3 py-2 flex items-start gap-2">
        <span className={cn("h-1.5 w-1.5 mt-[7px] shrink-0 rounded-full", actorDot(v.actor))} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[12px] text-foreground truncate flex-1">{versionLabel(v)}</span>
            {current && <span className="text-[10px] text-primary shrink-0">current</span>}
            <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{relTime(v.time)}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground min-w-0">
            <ActorChip actor={v.actor} machine={v.machine} />
            <LineCounts add={v.add} del={v.del} />
            {v.summary && <span className="truncate">{v.summary}</span>}
          </span>
        </span>
      </button>
      {trailing}
    </div>
  );
}
