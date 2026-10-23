import { useEffect, useRef, useState } from "react";
import { Allotment } from "allotment";
import { invoke } from "@tauri-apps/api/core";
import { useStore, type DropSide } from "./store";
import { MarkdownView } from "./MarkdownView";
import { VAULT_PANE_MIME, treeDrag } from "./dnd";
import { isUnreadableAsText } from "./fileKind";

type DropMode = { kind: "edge"; side: DropSide } | { kind: "fill" } | null;

export function MarkdownArea() {
  const panes = useStore((s) => s.panes);
  const splitDirection = useStore((s) => s.splitDirection);

  const [drop, setDrop] = useState<DropMode>(null);
  // A file dragged from the tree (a pointer drag, see dnd.ts treeDrag).
  const [treeDrop, setTreeDrop] = useState<DropMode>(null);
  const dragDepth = useRef(0);
  const areaRef = useRef<HTMLDivElement | null>(null);

  const sideAt = (r: DOMRect, cx: number, cy: number): DropSide => {
    const x = (cx - r.left) / r.width;
    const y = (cy - r.top) / r.height;
    const dx = Math.min(x, 1 - x);
    const dy = Math.min(y, 1 - y);
    if (dx < dy) return x < 0.5 ? "left" : "right";
    return y < 0.5 ? "top" : "bottom";
  };
  const computeSide = (e: React.DragEvent<HTMLDivElement>): DropSide =>
    sideAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);

  const dragKind = (e: React.DragEvent<HTMLDivElement>): "pane" | null =>
    e.dataTransfer.types.includes(VAULT_PANE_MIME) ? "pane" : null;

  // The tree's drag: highlight the edge (or the whole area when nothing is
  // open) under the pointer; on release there, open the file at that edge.
  useEffect(() => {
    const at = (x: number, y: number): DropMode => {
      const el = areaRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
      const s = useStore.getState();
      if (!s.currentFile && s.panes.length === 0) return { kind: "fill" };
      return { kind: "edge", side: sideAt(r, x, y) };
    };
    const same = (a: DropMode, b: DropMode) =>
      a === b || (!!a && !!b && a.kind === b.kind && (a.kind === "fill" || (b.kind === "edge" && a.side === b.side)));
    const offMove = treeDrag.subscribe(() => {
      const d = treeDrag.current();
      const next = d ? at(d.x, d.y) : null;
      setTreeDrop((prev) => (same(prev, next) ? prev : next));
    });
    const offDrop = treeDrag.onDrop((d) => {
      const mode = at(d.x, d.y);
      setTreeDrop(null);
      if (!mode) return false;
      const side: DropSide = mode.kind === "edge" ? mode.side : "right";
      (async () => {
        try {
          const text = isUnreadableAsText(d.path) ? "" : await invoke<string>("read_text_file", { path: d.path });
          useStore.getState().placeFileAtEdge(d.path, text, side);
        } catch (err) {
          console.error("[drop] failed:", err);
        }
      })();
      return true;
    });
    return () => {
      offMove();
      offDrop();
    };
  }, []);

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!dragKind(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDrop({ kind: "edge", side: computeSide(e) });
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!dragKind(e)) return;
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDrop(null);
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const kind = dragKind(e);
    dragDepth.current = 0;
    setDrop(null);
    if (!kind) return;
    e.preventDefault();
    const s = useStore.getState();
    const side = computeSide(e);

    const draggedId = e.dataTransfer.getData(VAULT_PANE_MIME);
    if (s.panes.length !== 2 || !draggedId) return;
    const other = s.panes.find((p) => p.id !== draggedId);
    if (!other) return;
    const newDir = side === "left" || side === "right" ? "horizontal" : "vertical";
    const draggedIdx = s.panes.findIndex((p) => p.id === draggedId);
    const targetIdx = side === "left" || side === "top" ? 0 : 1;
    if (newDir === s.splitDirection && draggedIdx === targetIdx) return;
    s.rearrangePanes(draggedId, other.id, side);
  };

  return (
    <div
      ref={areaRef}
      data-el="markdown-area"
      className="relative h-full w-full"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {panes.length === 2 ? (
        <Allotment key={splitDirection ?? "h"} vertical={splitDirection === "vertical"}>
          <Allotment.Pane minSize={200}>
            <MarkdownView paneId={panes[0].id} />
          </Allotment.Pane>
          <Allotment.Pane minSize={200}>
            <MarkdownView paneId={panes[1].id} />
          </Allotment.Pane>
        </Allotment>
      ) : (
        <MarkdownView />
      )}
      <DropOverlay drop={drop ?? treeDrop} />
    </div>
  );
}

function DropOverlay({ drop }: { drop: DropMode }) {
  if (!drop) return null;
  const base =
    "absolute pointer-events-none bg-primary/25 border-2 border-primary/60 transition-all z-30";
  if (drop.kind === "fill") return <div className={`${base} inset-0`} />;
  if (drop.side === "left") return <div className={`${base} top-0 bottom-0 left-0 w-1/2`} />;
  if (drop.side === "right") return <div className={`${base} top-0 bottom-0 right-0 w-1/2`} />;
  if (drop.side === "top") return <div className={`${base} left-0 right-0 top-0 h-1/2`} />;
  return <div className={`${base} left-0 right-0 bottom-0 h-1/2`} />;
}
