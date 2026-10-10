// History, style C — "Inline in the editor": no modal for notes. Ctrl+H on an
// open note shows a thin version strip above it (today's version pills,
// grouped by session); a click shows that version read-only in the pane with
// a "Viewing … · Restore · Back to current" bar (the breadcrumb strip style).
// Vault-wide entries live in style B's sheet ("Everything").
//
// Also: HistoryRoot, which mounts the style the preview/setting picks.

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { create } from "zustand";
import { X } from "lucide-react";
import { useStore } from "./store";
import { cn } from "./lib/utils";
import { preprocessMarkdownMath } from "./mdMath";
import { fullTime, historyFileAt, historyStyle, relTime, restoreNote, type NoteVersion } from "./history";
import { actorDot, useNoteVersions, versionLabel } from "./historyParts";
import { HistoryModal, relInVault, useEscape } from "./HistoryModal";
import { HistorySheet } from "./HistorySheet";

const KATEX_OPTIONS = { strict: "ignore", errorColor: "currentColor" } as const;
const norm = (p: string) => p.replace(/\\/g, "/");

type InlineState = {
  /** absolute path of the note showing its strip */
  file: string | null;
  viewing: NoteVersion | null;
  sheet: boolean;
  toggle: (file: string) => void;
  view: (v: NoteVersion | null) => void;
  close: () => void;
  setSheet: (b: boolean) => void;
};

export const useHistoryInline = create<InlineState>((set, get) => ({
  file: null,
  viewing: null,
  sheet: false,
  toggle: (file) => set(get().file && norm(get().file!) === norm(file) ? { file: null, viewing: null } : { file, viewing: null }),
  view: (v) => set({ viewing: v }),
  close: () => set({ file: null, viewing: null }),
  setSheet: (b) => set({ sheet: b }),
}));

/** Mounted by the Titlebar in place of today's HistoryModal. */
export function HistoryRoot({ open, onClose }: { open: boolean; onClose: () => void }) {
  const style = historyStyle();
  const currentFile = useStore((s) => s.currentFile);
  const sheet = useHistoryInline((s) => s.sheet);
  const setSheet = useHistoryInline((s) => s.setSheet);
  const toggle = useHistoryInline((s) => s.toggle);

  // Style C: Ctrl+H toggles the strip on the open note (or, with no note,
  // opens the vault-wide sheet).
  useEffect(() => {
    if (!open || style !== "inline") return;
    if (currentFile && /\.(md|markdown)$/i.test(currentFile)) toggle(currentFile);
    else setSheet(true);
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, style]);

  if (style === "modal") return <HistoryModal open={open} onClose={onClose} />;
  if (style === "sheet") return <HistorySheet open={open} onClose={onClose} />;
  return <HistorySheet open={sheet} onClose={() => setSheet(false)} startIn="all" />;
}

/** The version strip above a note (style C). Renders nothing unless open. */
export function HistoryStrip({ file }: { file: string | null }) {
  const st = useHistoryInline();
  const vault = useStore((s) => s.vaultPath);
  const active = !!file && !!st.file && norm(st.file) === norm(file);
  const rel = active ? relInVault(vault, file) : null;
  const { versions, loaded, hasMore, more } = useNoteVersions(vault, rel);
  useEscape(active, () => (st.viewing ? st.view(null) : st.close()));
  if (!active) return null;
  return (
    <div className="border-b border-border/60 px-6 py-1.5 flex items-center gap-2 shrink-0 min-w-0">
      <div className="flex gap-1 overflow-x-auto min-w-0 flex-1">
        {!loaded && <span className="text-[10.5px] text-muted-foreground">Loading…</span>}
        {loaded && versions.length === 0 && <span className="text-[10.5px] text-muted-foreground">No saved versions yet.</span>}
        {versions.map((v, i) => {
          const sel = st.viewing ? st.viewing.hash === v.hash : i === 0;
          return (
            <button
              key={v.hash}
              onClick={() => st.view(i === 0 ? null : v)}
              title={`${versionLabel(v)}${v.summary ? ` · ${v.summary}` : ""} · ${fullTime(v.time)}`}
              className={cn(
                "px-2 py-0.5 rounded text-[10.5px] font-mono border whitespace-nowrap inline-flex items-center gap-1.5 shrink-0",
                sel ? "bg-primary text-primary-foreground border-primary" : "border-border bg-muted/40 hover:bg-accent/60",
              )}
            >
              <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full shrink-0", actorDot(v.actor))} />
              {i === 0 ? "now" : relTime(v.time)}
            </button>
          );
        })}
        {hasMore && (
          <button onClick={more} className="text-[10.5px] text-muted-foreground hover:text-foreground whitespace-nowrap px-1">
            earlier…
          </button>
        )}
      </div>
      <button onClick={() => st.setSheet(true)} className="text-[10.5px] text-muted-foreground hover:text-foreground whitespace-nowrap">
        Everything ›
      </button>
      <button onClick={st.close} className="text-muted-foreground hover:text-foreground" title="Close (Esc)">
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/** True when the pane should show a past version instead of the note. */
export function useViewingVersion(file: string | null): NoteVersion | null {
  const st = useHistoryInline();
  return file && st.file && norm(st.file) === norm(file) ? st.viewing : null;
}

/** A past version, read-only, in the note's own pane. */
export function HistoryVersionView({ file }: { file: string }) {
  const st = useHistoryInline();
  const vault = useStore((s) => s.vaultPath);
  const v = st.viewing!;
  const rel = relInVault(vault, file);
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!vault || !rel) return;
    setContent(null);
    historyFileAt(vault, v.hash, rel).then(setContent).catch((e) => setError(String(e)));
  }, [vault, rel, v.hash]);
  const md = useMemo(() => preprocessMarkdownMath(content ?? ""), [content]);
  const restore = async () => {
    if (!vault || !rel) return;
    setBusy(true);
    try {
      await restoreNote(vault, rel, v.hash);
      st.close();
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="border-b border-border/60 px-6 py-1.5 shrink-0 bg-muted/30 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="truncate flex-1">
          Viewing {fullTime(v.time)} · {versionLabel(v)}
          {v.summary ? ` · ${v.summary}` : ""}
          {error && <span className="text-destructive"> · {error}</span>}
        </span>
        <button onClick={restore} disabled={busy} className="hover:text-foreground disabled:opacity-40">
          {busy ? "Restoring…" : "Restore"}
        </button>
        <span aria-hidden>·</span>
        <button onClick={() => st.view(null)} className="hover:text-foreground">
          Back to current
        </button>
      </div>
      <div className="flex-1 overflow-auto py-10 px-8">
        {content === null ? (
          <div className="text-[12px] text-muted-foreground">Loading…</div>
        ) : content === "" ? (
          <div className="text-[12px] text-muted-foreground italic">(the note did not exist in this version)</div>
        ) : (
          <div className="prose-md mx-auto opacity-90">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]} rehypePlugins={[rehypeRaw, [rehypeKatex, KATEX_OPTIONS], rehypeHighlight]}>
              {md}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
