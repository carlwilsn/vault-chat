// A note addressed to the agent wakes it (reports/21-design, Carl's decision 3): the phone is now only notifications
// and notes, so a note is how Carl reaches the agent from it. A new open note whose text starts by naming the agent
// ("@agent …", "agent: …", "claude, …") becomes an ask in the work ledger and starts a fresh short session with it,
// once. Other notes stay notes. Which notes were already seen is kept beside the ledger
// (<vault>/.vault-chat/local/notes-to-agent.json); the first look only marks what exists, so old notes never fire.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ADDRESSED = /^\s*(?:@agent|@claude|agent|claude|hey,?\s+(?:agent|claude))\b\s*[,:\-–—]?\s*/i;

export type NoteLike = { id: string; status: string; user_draft?: string | null; turns?: { content?: string }[]; title?: string | null; timestamp?: string };

/** The note's own words. */
export const noteWords = (n: NoteLike): string => (n.user_draft || (n.turns ?? []).map((t) => t.content ?? "").join(" ") || n.title || "").trim();

/** Whether a note speaks to the agent, and what it asks (the words after the name). */
export function addressedAsk(n: NoteLike): string | null {
  if (n.status !== "open") return null;
  const w = noteWords(n);
  const m = ADDRESSED.exec(w);
  if (!m) return null;
  const ask = w.slice(m[0].length).trim();
  return ask || null;
}

const fileOf = (vault: string) => join(vault, ".vault-chat", "local", "notes-to-agent.json");

/** The notes that newly ask the agent something, marking every note seen. The first call only marks. */
export function newNotesForAgent(vault: string, notes: NoteLike[]): { id: string; ask: string }[] {
  let seen: Set<string> | null = null;
  try {
    seen = new Set((JSON.parse(readFileSync(fileOf(vault), "utf8")).seen ?? []) as string[]);
  } catch {
    seen = null;
  }
  const first = seen === null;
  const s = seen ?? new Set<string>();
  const out: { id: string; ask: string }[] = [];
  for (const n of notes) {
    if (s.has(n.id)) continue;
    s.add(n.id);
    const ask = first ? null : addressedAsk(n);
    if (ask) out.push({ id: n.id, ask });
  }
  if (first || out.length || s.size !== (seen?.size ?? -1)) {
    mkdirSync(join(vault, ".vault-chat", "local"), { recursive: true });
    writeFileSync(fileOf(vault), JSON.stringify({ seen: [...s].slice(-2000) }));
  }
  return out;
}
