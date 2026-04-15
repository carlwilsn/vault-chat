import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";

type Block = { kind: "line" | "fenced" | "math" | "table" | "blockquote"; text: string };

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function isTableRow(line: string): boolean {
  return /\|/.test(line) && !/^\s*$/.test(line);
}

function parseBlocks(content: string): Block[] {
  const lines = content.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = /^(\s*)(```|~~~)/.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[2];
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^\\s*${fence}\\s*$`).test(lines[j])) j++;
      const end = j < lines.length ? j : lines.length - 1;
      out.push({ kind: "fenced", text: lines.slice(i, end + 1).join("\n") });
      i = end + 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      let j = i + 1;
      while (j < lines.length && /^\s*>/.test(lines[j])) j++;
      out.push({ kind: "blockquote", text: lines.slice(i, j).join("\n") });
      i = j;
      continue;
    }
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) j++;
      out.push({ kind: "table", text: lines.slice(i, j).join("\n") });
      i = j;
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line) || /^\s*\$\$/.test(line)) {
      const sameLineClose = /^\s*\$\$.+\$\$\s*$/.test(line);
      if (sameLineClose) {
        out.push({ kind: "math", text: line });
        i++;
        continue;
      }
      let j = i + 1;
      while (j < lines.length && !/\$\$\s*$/.test(lines[j])) j++;
      const end = j < lines.length ? j : lines.length - 1;
      out.push({ kind: "math", text: lines.slice(i, end + 1).join("\n") });
      i = end + 1;
      continue;
    }
    out.push({ kind: "line", text: line });
    i++;
  }
  return out;
}

function serialize(blocks: Block[]): string {
  return blocks.map((b) => b.text).join("\n");
}

export function BlockEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const blocks = useMemo(() => parseBlocks(value), [value]);
  const [active, setActive] = useState<number | null>(null);
  const [draft, setDraft] = useState<string>("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (active != null && textareaRef.current) {
      textareaRef.current.focus();
      const t = textareaRef.current;
      t.setSelectionRange(t.value.length, t.value.length);
      autosize(t);
    }
  }, [active]);

  const enterBlock = (i: number) => {
    if (active === i) return;
    if (active != null) commitDraft(active, draft);
    setDraft(blocks[i].text);
    setActive(i);
  };

  const commitDraft = (i: number, text: string) => {
    if (text === blocks[i].text) return;
    const next = blocks.map((b, idx) => (idx === i ? { ...b, text } : b));
    onChange(serialize(next));
  };

  const commitActive = () => {
    if (active != null) commitDraft(active, draft);
    setActive(null);
  };

  return (
    <div className="prose-md">
      {blocks.map((b, i) => {
        const isActive = i === active;
        if (isActive) {
          return (
            <textarea
              key={i}
              ref={textareaRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                autosize(e.currentTarget);
              }}
              onBlur={commitActive}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  commitActive();
                }
                if (e.key === "ArrowDown" && atLastLine(e.currentTarget)) {
                  if (i < blocks.length - 1) {
                    e.preventDefault();
                    enterBlock(i + 1);
                  }
                }
                if (e.key === "ArrowUp" && atFirstLine(e.currentTarget)) {
                  if (i > 0) {
                    e.preventDefault();
                    enterBlock(i - 1);
                  }
                }
              }}
              className="w-full resize-none bg-muted/40 border border-border/60 rounded px-2 py-1 my-1 font-mono text-[13px] leading-relaxed outline-none focus:border-primary/60"
              rows={Math.max(1, draft.split("\n").length)}
              spellCheck={false}
            />
          );
        }
        if (b.text === "") {
          return (
            <div
              key={i}
              onClick={() => enterBlock(i)}
              className="h-4 cursor-text"
            />
          );
        }
        return (
          <div
            key={i}
            onClick={() => enterBlock(i)}
            className="cursor-text rounded hover:bg-accent/20 transition-colors"
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex, rehypeHighlight]}
            >
              {b.text}
            </ReactMarkdown>
          </div>
        );
      })}
    </div>
  );
}

function autosize(t: HTMLTextAreaElement) {
  t.style.height = "auto";
  t.style.height = t.scrollHeight + "px";
}

function atLastLine(t: HTMLTextAreaElement): boolean {
  const pos = t.selectionStart;
  return t.value.indexOf("\n", pos) === -1;
}

function atFirstLine(t: HTMLTextAreaElement): boolean {
  const pos = t.selectionStart;
  return t.value.lastIndexOf("\n", pos - 1) === -1;
}
