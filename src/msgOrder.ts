// Message identity and order for a conversation shown from more than one
// source (the box's /conversation, its /poll events, the git-synced file on
// this disk). The rule every merge keeps: once a message has been shown it
// never disappears — a source may replace it in place with an equal or newer
// copy, and a snapshot older than what is shown never wins.
//
// A message's identity is its `mid` (every message the box stores has one);
// a copy without one falls back to role + text.
import type { ChatMessage } from "./store";

export const msgKey = (m: { role?: string; content?: string }): string =>
  `${m.role === "user" ? "user" : "assistant"}\u0000${(m.content ?? "").slice(0, 20_000)}`;

/** Shown only here, never on the box or the disk: an optimistic user turn, a
 *  reply landed from a live event or closed by a steer, a local notice. */
export const isLocalOnly = (m: ChatMessage): boolean => !!m.boxPending || !!m.boxLocal;

/** Which messages of a list carry which identities. */
export class Ids {
  private mids = new Set<string>();
  private keys = new Map<string, number>();
  private bareKeys = new Map<string, number>();
  constructor(list: ChatMessage[]) {
    for (const m of list) {
      if (m.mid) this.mids.add(m.mid);
      const k = msgKey(m);
      this.keys.set(k, (this.keys.get(k) ?? 0) + 1);
      if (!m.mid) this.bareKeys.set(k, (this.bareKeys.get(k) ?? 0) + 1);
    }
  }
  /** Is `m` in the list: by its mid, or by its text where one side has no mid. */
  has(m: ChatMessage): boolean {
    if (m.mid && this.mids.has(m.mid)) return true;
    const k = msgKey(m);
    return m.mid ? (this.bareKeys.get(k) ?? 0) > 0 : (this.keys.get(k) ?? 0) > 0;
  }
}

/** A reply shown before the box's copy landed (`p`) is that copy (`b`): the same
 *  mid, or the box's text holds what was shown (a streamed tail starts with "…";
 *  a live event's text is capped, the stored one is whole). */
export function settles(p: ChatMessage, b: ChatMessage): boolean {
  if (p.mid && b.mid) return p.mid === b.mid;
  if ((p.role === "user") !== (b.role === "user")) return false;
  const shown = (p.content ?? "").replace(/^…/, "").trim();
  const have = (b.content ?? "").trim();
  if (shown === have) return true;
  if (!shown) return !!b.toolCalls?.length && (p.toolCalls?.length ?? 0) <= b.toolCalls.length;
  return have.includes(shown.slice(-500));
}

/** Does `next` hold every message `cur` shows (hidden ones count: hiding is an
 *  update, not a removal)? Local-only messages count when one of `next`'s
 *  settles them; a local notice is never in `next`. */
export function coversShown(cur: ChatMessage[], next: ChatMessage[]): boolean {
  const ids = new Ids(next);
  for (const m of cur) {
    if (m.hidden) continue;
    if (m.boxLocal) return false;
    if (m.boxPending) {
      if (!next.some((b) => settles(m, b))) return false;
      continue;
    }
    if (!ids.has(m)) return false;
  }
  return true;
}

/** `next` is a newer copy of `cur`: it shows everything `cur` shows, and more
 *  (or the same messages changed in place). */
export function isNewerCopy(cur: ChatMessage[], next: ChatMessage[]): boolean {
  if (!coversShown(cur, next)) return false;
  const shown = cur.filter((m) => !isLocalOnly(m));
  if (next.length !== shown.length) return next.length > shown.length;
  return next.some((m, i) => m.content !== shown[i]!.content || (m.toolCalls?.length ?? 0) !== (shown[i]!.toolCalls?.length ?? 0) || !!m.hidden !== !!shown[i]!.hidden);
}

/**
 * The box's window of a conversation (its last `windowN` messages, hidden
 * included) laid over what this laptop shows (`local`, local-only messages
 * removed):
 *  - history older than the window stays (the window slides; nothing scrolls away);
 *  - a snapshot older than what is shown (taken before the newest reply was
 *    stored, or answered slowly) keeps the newer messages after it: `stale`.
 */
export function overlayWindow(local: ChatMessage[], box: ChatMessage[], windowN: number): { messages: ChatMessage[]; stale: boolean } {
  const L = local.filter((m) => !isLocalOnly(m));
  let prefix: ChatMessage[] = [];
  if (box.length >= windowN && L.length && box.length) {
    const first = box[0]!;
    let at = first.mid ? L.findIndex((m) => m.mid === first.mid) : -1;
    if (at < 0) {
      // No mids to go by: the first place where the window's first three messages line up.
      const k = Math.min(3, box.length);
      outer: for (let i = 0; i + k <= L.length; i++) {
        for (let t = 0; t < k; t++) if (msgKey(L[i + t]!) !== msgKey(box[t]!)) continue outer;
        at = i;
        break;
      }
    }
    if (at > 0) prefix = L.slice(0, at);
    else if (at < 0) {
      // The window shares nothing with what is shown: all of it is newer.
      const ids = new Ids(box);
      prefix = L.filter((m) => !ids.has(m));
    }
  }
  let messages = prefix.length ? [...prefix, ...box] : box;
  // What is shown past the snapshot's newest message it also has.
  const ids = new Ids(messages);
  let last = -1;
  for (let i = L.length - 1; i >= 0; i--) {
    if (ids.has(L[i]!)) {
      last = i;
      break;
    }
  }
  const tail = L.slice(last + 1).filter((m) => !ids.has(m));
  // Nothing in common at all and a window that is the whole conversation: the
  // box's copy replaced this one (another conversation's id, a re-created thread).
  if (last < 0 && box.length && box.length < windowN) return { messages, stale: false };
  if (tail.length) messages = [...messages, ...tail];
  return { messages, stale: tail.length > 0 };
}
