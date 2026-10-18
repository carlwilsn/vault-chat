// The background maker behind BoardMake (board/INBOX.md, "Sending never
// blocks the conversation"): a sub-agent in the same vault (pi/subagents.ts,
// started with backend.background) that makes the files, sends them through
// the same validated BoardSend (with `make`: the entry already shown as
// "being made") and fixes refusals itself. It sends each part as soon as it is
// made (`more: true`), so the inbox fills in while it works; its last send
// (no `more`) finishes the entry.
import { readFileSync } from "node:fs";
import { entryDir } from "../../src/inboxFormat";

export const BOARD_MAKER_PROMPT = `You make things for Carl's iPad whiteboard and send them to its inbox with BoardSend. You run in the background in his vault; nobody watches you work.

What you can send (each part is addable on its own, in order):
- {kind:"math", markdown, label?}: markdown with $…$ and $$…$$ (KaTeX). A problem set is one math part per problem, labelled "Problem 1", … Real, correct mathematics; easiest first.
- {kind:"image", path, alt}: a PNG, JPEG, WebP or SVG you made (e.g. python/matplotlib saving SVG, or SVG written by hand). alt is one line saying what it shows. No script, foreignObject or outside references in an SVG. Bitmaps at most 4096 px.
- {kind:"widget", path, alt, layout?:{w,h}}: ONE TypeScript module, no package imports, exporting mount(el: HTMLElement, api) where api has size() → {w,h}, onResize(fn), theme. Draw into el with DOM, canvas or SVG. No network, no storage, no parent page. It must not throw when mounted. Default layout 640×480 css px.
- {kind:"pdf", path, pages:[…]}: pages of a PDF already in the vault (1-based, at most 20).

Put every file you make in the entry's folder you are given.
Send each part as soon as it is made, so Carl sees it while you make the rest: BoardSend {make: <entry id>, title, more: true, parts: [that part]}. Parts land in the order you send them. When everything is sent, finish with BoardSend {make, title, note: one line, parts: [the last part, or none]} without more — until then the entry shows as still being made.
If BoardSend refuses, nothing of that send landed: read every reason, fix the files, and send those parts again (up to 4 tries). Parts that already landed stay; never send them twice. If you cannot make it, end with one line saying why.
Never read, print or copy keys, tokens or the key store.`;

export function boardMakeTask(id: string, title: string, request: string): string {
  return `Make this for Carl's whiteboard. Send each part as soon as it is made with BoardSend {make: "${id}", title: ${JSON.stringify(title)}, more: true, parts}, and finish with one send without more (with a one-line note).

Request: ${request}

Write your files in ${entryDir(id)}/ (relative to the vault, your working directory).`;
}

/**
 * What the maker's time went to, from its own pi session file: model calls, the time inside them (each assistant
 * entry's write time minus its message's start), tool calls by name. Null when the file can't be read.
 */
export function makerStats(sessionFile: unknown): { calls: number; modelMs: number; tools: Record<string, number> } | null {
  if (typeof sessionFile !== "string" || !sessionFile) return null;
  let raw = "";
  try {
    raw = readFileSync(sessionFile, "utf8");
  } catch {
    return null;
  }
  let calls = 0;
  let modelMs = 0;
  const tools: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const m = e?.type === "message" ? e.message : null;
      if (m?.role !== "assistant") continue;
      calls++;
      const end = Date.parse(String(e.timestamp ?? ""));
      if (Number.isFinite(end) && typeof m.timestamp === "number" && end >= m.timestamp) modelMs += end - m.timestamp;
      for (const c of Array.isArray(m.content) ? m.content : []) if (c?.type === "toolCall" && c.name) tools[c.name] = (tools[c.name] ?? 0) + 1;
    } catch {
      /* a torn line */
    }
  }
  return { calls, modelMs, tools };
}
