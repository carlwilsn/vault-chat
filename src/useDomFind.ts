import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { clearMatches, findMatches, setCurrent } from "./find";

export interface UseDomFindResult {
  open: boolean;
  query: string;
  matchCount: number;
  currentIndex: number;
  setQuery: (q: string) => void;
  openBar: () => void;
  close: () => void;
  next: () => void;
  prev: () => void;
}

// Attaches a DOM-based find behavior to a container. Ctrl+F / Cmd+F (while
// focus is inside containerRef, or when openWhen returns true) opens the
// find bar. Highlights all matches in the container and can step through
// them.
export function useDomFind(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): UseDomFindResult {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const matchesRef = useRef<HTMLElement[]>([]);

  const recompute = useCallback(
    (q: string) => {
      const root = containerRef.current;
      if (!root) {
        matchesRef.current = [];
        setMatchCount(0);
        setCurrentIndex(0);
        return;
      }
      if (!q) {
        clearMatches(root);
        matchesRef.current = [];
        setMatchCount(0);
        setCurrentIndex(0);
        return;
      }
      const ms = findMatches(root, q);
      matchesRef.current = ms;
      setMatchCount(ms.length);
      const idx = ms.length > 0 ? 0 : 0;
      setCurrentIndex(idx);
      if (ms.length > 0) setCurrent(ms, idx);
    },
    [containerRef],
  );

  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q);
      recompute(q);
    },
    [recompute],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQueryState("");
    const root = containerRef.current;
    if (root) clearMatches(root);
    matchesRef.current = [];
    setMatchCount(0);
    setCurrentIndex(0);
  }, [containerRef]);

  const openBar = useCallback(() => {
    setOpen(true);
  }, []);

  const step = useCallback((delta: number) => {
    const ms = matchesRef.current;
    if (ms.length === 0) return;
    setCurrentIndex((prev) => {
      const next = (prev + delta + ms.length) % ms.length;
      setCurrent(ms, next);
      return next;
    });
  }, []);

  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);

  // Ctrl+F / Cmd+F — open the bar. Scoped to when `enabled` is true (the
  // viewer owning this hook is the visible/active one) so two panes don't
  // both grab the keystroke.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() !== "f") return;
      // Don't hijack Ctrl+F while focus is in an editor that has its
      // own find (CodeMirror, Monaco, plain inputs/textareas).
      const active = document.activeElement as HTMLElement | null;
      if (active) {
        const tag = active.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (active.isContentEditable) return;
        if (active.closest(".cm-editor")) return;
        if (active.closest(".monaco-editor")) return;
      }
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  // If the container goes away (different viewer mounted), drop matches.
  useEffect(() => {
    return () => {
      const root = containerRef.current;
      if (root) clearMatches(root);
      matchesRef.current = [];
    };
  }, [containerRef]);

  return {
    open,
    query,
    matchCount,
    currentIndex,
    setQuery,
    openBar,
    close,
    next,
    prev,
  };
}
