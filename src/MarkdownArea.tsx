import { useRef, useState } from "react";
import { Allotment } from "allotment";
import { invoke } from "@tauri-apps/api/core";
import { useStore, type DropSide } from "./store";
import { MarkdownView } from "./MarkdownView";
import { VAULT_PATH_MIME, VAULT_PANE_MIME } from "./dnd";

type DropMode = { kind: "edge"; side: DropSide } | { kind: "fill" } | null;

export function MarkdownArea() {
  const panes = useStore((s) => s.panes);
  const splitDirection = useStore((s) => s.splitDirection);
  const currentFile = useStore((s) => s.currentFile);

  const [drop, setDrop] = useState<DropMode>(null);
  const dragDepth = useRef(0);

  const computeSide = (e: React.DragEvent<HTMLDivElement>): DropSide => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const dx = Math.min(x, 1 - x);
    const dy = Math.min(y, 1 - y);
    if (dx < dy) return x < 0.5 ? "left" : "right";
    return y < 0.5 ? "top" : "bottom";
  };

  const dragKind = (e: React.DragEvent<HTMLDivElement>): "file" | "pane" | null => {
    const types = e.dataTransfer.types;
    if (types.includes(VAULT_PANE_MIME)) return "pane";
    if (types.includes(VAULT_PATH_MIME)) return "file";
    return null;
  };

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!dragKind(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = kind === "pane" ? "move" : "copy";

    if (kind === "file" && !currentFile && panes.length === 0) {
      setDrop({ kind: "fill" });
      return;
    }
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

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    const kind = dragKind(e);
    dragDepth.current = 0;
    setDrop(null);
    if (!kind) return;
    e.preventDefault();
    const s = useStore.getState();
    const side = computeSide(e);

    if (kind === "pane") {
      const draggedId = e.dataTransfer.getData(VAULT_PANE_MIME);
      if (s.panes.length !== 2 || !draggedId) return;
      const other = s.panes.find((p) => p.id !== draggedId);
      if (!other) return;
      const newDir = side === "left" || side === "right" ? "horizontal" : "vertical";
      const draggedIdx = s.panes.findIndex((p) => p.id === draggedId);
      const targetIdx = side === "left" || side === "top" ? 0 : 1;
      if (newDir === s.splitDirection && draggedIdx === targetIdx) return;
      s.rearrangePanes(draggedId, other.id, side);
      return;
    }

    const path = e.dataTransfer.getData(VAULT_PATH_MIME);
    if (!path) return;
    try {
      const text = await invoke<string>("read_text_file", { path });
      s.placeFileAtEdge(path, text, side);
    } catch (err) {
      console.error("[drop] failed:", err);
    }
  };

  return (
    <div
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
      <DropOverlay drop={drop} />
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
