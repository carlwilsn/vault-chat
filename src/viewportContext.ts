// What Carl is looking at, as text for the agent (a typed turn's context, src/ChatPane.tsx): the active file's page or
// visible part, and in a split view the layout and the other pane.
import { useStore, type Viewport } from "./store";
import { layoutLine, sideOf } from "./paneLayout";

const VIEWPORT_TEXT_CAP = 4000;

export function buildViewportContextText(state: ReturnType<typeof useStore.getState>): string {
  if (!state.followAlong) return "";
  const activeFile = state.currentFile;
  if (!activeFile) return "";

  const sections: string[] = [activeSectionFor(state, activeFile)];

  // Split view: the layout first, in Show's names (left / right pane; src/paneLayout.ts), then the OTHER pane too so
  // the agent knows both files are visible. Marked OTHER vs ACTIVE so it can pick the right one when Carl says "this"
  // or "that one".
  if (state.panes.length > 0) {
    sections.unshift(`${layoutLine(state, state.vaultPath)} (Show's pane: "left" / "right" puts a file in one)`);
    for (const pane of state.panes) {
      if (pane.id === state.activePaneId) continue;
      const content = (pane.content ?? "").trim();
      const otherCap = 2000;
      const side = sideOf(state, pane.id);
      const label = `OTHER pane${side ? ` (${side})` : ""} document`;
      sections.push(content ? `${label}: ${pane.file}\nContent:\n${truncate(content, otherCap)}` : `${label}: ${pane.file} (no text content)`);
    }
  }

  return sections.join("\n\n---\n\n");
}

function activeSectionFor(state: ReturnType<typeof useStore.getState>, activeFile: string): string {
  const v: Viewport | null = state.viewport;
  if (v && v.path === activeFile) {
    if (v.page !== undefined && v.pageText) {
      const total = v.totalPages ?? "?";
      return `>>> USER IS CURRENTLY ON PAGE ${v.page} of ${total} of ${activeFile} <<<\nAny ambiguous reference ("this", "that", "this math", "what does this say") refers to PAGE ${v.page}, not other pages.\nPage ${v.page} text content:\n${truncate(v.pageText, VIEWPORT_TEXT_CAP)}`;
    }
    if (v.visibleText) {
      const pct = v.scrollRatio !== undefined ? Math.round(v.scrollRatio * 100) : null;
      const loc = pct !== null ? ` (scrolled ~${pct}%)` : "";
      return `>>> USER IS CURRENTLY VIEWING ${activeFile}${loc} <<<\nAny ambiguous reference refers to the visible portion below, not other parts of the document.\nVisible content:\n${truncate(v.visibleText, VIEWPORT_TEXT_CAP)}`;
    }
  }
  const fallback = (state.currentContent ?? "").trim();
  if (!fallback) return `>>> USER IS CURRENTLY VIEWING ${activeFile} <<< (no text content available; call Read for contents)`;
  return `>>> USER IS CURRENTLY VIEWING ${activeFile} <<<\nContent:\n${truncate(fallback, VIEWPORT_TEXT_CAP)}`;
}

function truncate(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}
