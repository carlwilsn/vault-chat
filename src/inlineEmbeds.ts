// One live copy of a page file in the chat feed (src/InlineHtmlFrame.tsx): when the same file is embedded in several
// messages, only the newest embed (last in the feed) is live; the older ones fold to a quiet static row. The registry
// is the mounted embeds' wrapper elements per file; "newest" is document order, so it holds for any feed layout.
const embeds = new Map<string, Set<HTMLElement>>();
const listeners = new Set<() => void>();
const norm = (p: string) => p.replace(/\\/g, "/");

const notify = () => listeners.forEach((f) => f());

export function subscribeEmbeds(f: () => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}

/** Add `el` as an embed of `file`; the returned function removes it. */
export function registerEmbed(file: string, el: HTMLElement): () => void {
  const k = norm(file);
  let set = embeds.get(k);
  if (!set) embeds.set(k, (set = new Set()));
  set.add(el);
  notify();
  return () => {
    set!.delete(el);
    if (!set!.size) embeds.delete(k);
    notify();
  };
}

/** The embed of `file` last in document order (null when none is mounted). */
export function newestEmbed(file: string): HTMLElement | null {
  let best: HTMLElement | null = null;
  for (const el of embeds.get(norm(file)) ?? []) {
    if (!el.isConnected) continue;
    if (!best || best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = el;
  }
  return best;
}

/** Whether `el` is the live embed of `file`: the newest, or the only one (also while it is not registered yet). */
export function isNewestEmbed(file: string, el: HTMLElement | null): boolean {
  const n = newestEmbed(file);
  return !n || n === el || !el;
}
