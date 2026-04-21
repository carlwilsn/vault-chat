import { useEffect, useRef } from "react";
import { ChevronUp, ChevronDown, X } from "lucide-react";

export interface FindBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  matchCount: number;
  currentIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  autoFocus?: boolean;
}

export function FindBar(props: FindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { autoFocus } = props;
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [autoFocus]);

  return (
    <div className="absolute top-2 right-2 z-30 flex items-center gap-1 rounded-md border border-border bg-card/95 backdrop-blur shadow-lg px-1.5 py-1">
      <input
        ref={inputRef}
        value={props.query}
        onChange={(e) => props.onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) props.onPrev();
            else props.onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            props.onClose();
          }
        }}
        placeholder="Find…"
        className="bg-transparent outline-none text-[12px] text-foreground placeholder:text-muted-foreground/70 w-44 px-1"
      />
      <span className="text-[10.5px] font-mono text-muted-foreground tabular-nums min-w-[46px] text-right px-1">
        {props.matchCount === 0
          ? props.query
            ? "0/0"
            : ""
          : `${props.currentIndex + 1}/${props.matchCount}`}
      </span>
      <button
        onClick={props.onPrev}
        disabled={props.matchCount === 0}
        className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
        title="Previous (Shift+Enter)"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={props.onNext}
        disabled={props.matchCount === 0}
        className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
        title="Next (Enter)"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={props.onClose}
        className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground"
        title="Close (Esc)"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
