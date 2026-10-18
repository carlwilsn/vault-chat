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
