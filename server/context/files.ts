// Plain files under <vault>/.vault-chat/. Atomic writes, markdown sections.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomic } from "../atomic";

export const VC_DIR = ".vault-chat";

export function vcPath(vault: string, ...parts: string[]): string {
  return join(vault, VC_DIR, ...parts);
}

export function readOr(path: string, fallback = ""): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

export function writeFile(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, body, `${path}.${process.pid}.tmp`);
}

export function exists(path: string): boolean {
  return existsSync(path);
}

/** "Coconut Detector!" → "coconut-detector". */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Cap text at `max` chars, keeping the head (or the tail), with a pointer to the rest. */
export function cap(text: string, max: number, pointer: string, keep: "head" | "tail" = "head"): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.length - max;
  const note = `[… ${cut} more characters — ${pointer}]`;
  return keep === "head" ? `${t.slice(0, max)}\n${note}` : `${note}\n${t.slice(t.length - max)}`;
}

// ---- `## Section` editing ----

type Span = { start: number; bodyStart: number; end: number };

function findSection(lines: string[], section: string): Span | null {
  const want = section.trim().toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(.*?)\s*$/.exec(lines[i]!);
    if (!m || m[1]!.toLowerCase() !== want) continue;
    let end = i + 1;
    while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++;
    return { start: i, bodyStart: i + 1, end };
  }
  return null;
}

/** The body of `## section`, or null when absent. */
export function getSection(doc: string, section: string): string | null {
  const lines = doc.split(/\r?\n/);
  const s = findSection(lines, section);
  return s ? lines.slice(s.bodyStart, s.end).join("\n").trim() : null;
}

/** Replace (or create at the end) the body of `## section`. */
export function setSection(doc: string, section: string, body: string): string {
  const lines = doc.replace(/\s+$/, "").split(/\r?\n/);
  const s = findSection(lines, section);
  const block = body.trim() ? ["", body.trim(), ""] : [""];
  if (!s) return `${lines.join("\n")}\n\n## ${section.trim()}\n${block.join("\n")}`.replace(/^\n+/, "") + "\n";
  const out = [...lines.slice(0, s.bodyStart), ...block, ...lines.slice(s.end)];
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

/** Append `text` to the end of `## section` (created if missing). */
export function appendSection(doc: string, section: string, text: string): string {
  const cur = getSection(doc, section) ?? "";
  return setSection(doc, section, cur ? `${cur}\n${text.trim()}` : text.trim());
}
