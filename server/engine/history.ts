// SearchHistory: the agent's read-only search over a thread's full raw history — pi's own session
// files, which keep every entry for good (compaction and Clear change only what the model sees).
// Letta's "a filesystem is enough" result, as a tool: the session files live in the server's state,
// which the agent's sandbox may not read, so the search runs here (reports/Continuous conversation
// SOTA research.md, section 7, item 4: the fallback it names).
import { existsSync } from "node:fs";
import type { PiEntry } from "../../src/convlog/protocol";
import { readEntries } from "../convlog/piSession";
import { logOf } from "./convs";
import type { EngineConv } from "./context";

const MAX_HITS = 40;

/** The text a session entry holds, and who said it (null: not searchable — pi's bookkeeping, costs, the "you" layer). */
export function entryText(e: PiEntry): { who: string; text: string } | null {
  const flat = (c: unknown): string =>
    typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? String(b.text ?? "") : b?.type === "toolCall" ? `${b.name}(${JSON.stringify(b.arguments ?? {}).slice(0, 400)})` : "")).filter(Boolean).join("\n") : "";
  if (e.type === "message" && e.message) {
    const m = e.message;
    if (m.role === "user") return { who: "Carl", text: flat(m.content) };
    if (m.role === "assistant") return { who: "agent", text: flat(m.content) };
    if (m.role === "toolResult") return { who: `tool ${m.toolName ?? ""}`.trim(), text: flat(m.content).slice(0, 2000) };
    return null;
  }
  if (e.type === "compaction") return { who: "summary", text: String(e.summary ?? "") };
  if (e.type === "custom_message" && e.customType === "vc-voice") return { who: "voice", text: flat((e as any).content) };
  if (e.type === "custom" && e.customType === "vc-note" && e.data?.kind === "line") return { who: e.data.role === "user" ? "Carl" : "agent", text: String(e.data.text ?? "") };
  return null;
}

/** Every pi session file a conversation's feed has pointed into, and its current one. */
export function sessionFilesOf(vault: string, conv: EngineConv): string[] {
  const files = new Set(logOf(vault).sessionFilesOf(conv.id));
  if (typeof conv.threadPath === "string" && conv.threadPath) files.add(conv.threadPath);
  return [...files].filter((f) => existsSync(f));
}

/** The hits, newest first: `[time] who: …snippet…`. */
export function searchHistory(vault: string, conv: EngineConv, query: string, limit = 12): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return "SearchHistory needs a query (words that must all appear).";
  const n = Math.min(Math.max(1, Math.floor(limit)), MAX_HITS);
  const hits: { at: string; who: string; snippet: string }[] = [];
  for (const file of sessionFilesOf(vault, conv)) {
    for (const e of readEntries(file)) {
      const t = entryText(e);
      if (!t || !t.text.trim()) continue;
      const low = t.text.toLowerCase();
      if (!words.every((w) => low.includes(w))) continue;
      const i = low.indexOf(words[0]!);
      const from = Math.max(0, i - 160);
      const snippet = `${from > 0 ? "…" : ""}${t.text.slice(from, from + 360).replace(/\s+/g, " ").trim()}${from + 360 < t.text.length ? "…" : ""}`;
      hits.push({ at: String(e.timestamp ?? ""), who: t.who, snippet });
    }
  }
  if (!hits.length) return `No match for "${query}" in "${conv.title}"'s history.`;
  hits.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const shown = hits.slice(0, n);
  return `${hits.length} match(es) in "${conv.title}"'s full history${hits.length > n ? ` (newest ${n} shown)` : ""}:\n` + shown.map((h) => `[${h.at.slice(0, 16).replace("T", " ")}] ${h.who}: ${h.snippet}`).join("\n");
}
