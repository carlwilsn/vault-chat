// Which collapsible chat rows are open (a reply's tool calls and its Thought, a voice-ask's work, a job's output, a
// summary divider): state, not the DOM's <details> (report 28: the rows' toggle wrote the DOM only). The rows draw it
// (src/plugins/chat-rows/rows.tsx OpenRow) and Carl's click sets it; app/chat-rows reads it in `rows` and its toolRows
// action sets the same state.
import { create } from "zustand";
import { createElement, type ReactNode } from "react";

/** A row part's key: the message's index in the chat and which part ("tools", "thought", "voice-ask", "job", "divider"). */
export const rowKey = (index: number | undefined, part: string): string | null => (typeof index === "number" ? `${index}:${part}` : null);

export const useRowOpen = create<{ open: Record<string, boolean> }>(() => ({ open: {} }));

export function setRowOpen(key: string, open: boolean): void {
  if (!!useRowOpen.getState().open[key] === open) return;
  useRowOpen.setState((s) => ({ open: { ...s.open, [key]: open } }));
}

/** The parts of the row at `index` that are open now. */
export function rowOpenParts(index: number): string[] {
  const o = useRowOpen.getState().open;
  return Object.keys(o).filter((k) => o[k] && k.startsWith(`${index}:`)).map((k) => k.slice(String(index).length + 1));
}

/** A collapsible row part: a <details> whose open is this state (a click sets it; the state opens it). */
export function OpenRow({ index, part, className, attrs, children }: { index?: number; part: string; className?: string; attrs?: Record<string, unknown>; children: ReactNode }) {
  const key = rowKey(index, part);
  const open = useRowOpen((s) => (key ? !!s.open[key] : false));
  return createElement(
    "details",
    {
      className,
      ...(attrs ?? {}),
      ...(key ? { open } : {}),
      onToggle: (e: { currentTarget: HTMLDetailsElement }) => key && setRowOpen(key, e.currentTarget.open),
    },
    children,
  );
}
