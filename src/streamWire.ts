// A streamed reply travels whole over the box's /poll ring. Each live event
// (`runtime`, `chat` stream) carries the text's growth since the last event —
// `offset` (where `delta` starts) and `len` (the whole length) — so a client
// that saw the stream from its start has every character, however long the
// reply. A client that joined mid-stream (or missed an event) waits for the
// next keyframe: `offset: 0`, the whole text, sent every few seconds. `text`
// keeps the old tail for clients that predate this.

export type StreamFields = { text: string; offset: number; delta: string; len: number };

const TAIL = 6_000;

export class StreamWire {
  private sent = new Map<string, { text: string; keyAt: number }>();
  constructor(private keyframeMs = 3_000) {}

  next(id: string, text: string, now = Date.now()): StreamFields {
    const prev = this.sent.get(id);
    const extend = !!prev && text.startsWith(prev.text) && now - prev.keyAt < this.keyframeMs;
    const offset = extend ? prev!.text.length : 0;
    this.sent.set(id, { text, keyAt: extend ? prev!.keyAt : now });
    return { text: text.slice(-TAIL), offset, delta: text.slice(offset), len: text.length };
  }

  reset(id: string): void {
    this.sent.delete(id);
  }
}

/** The client side: the current text after one event. `whole` is false while
 *  only a tail is known (joined mid-stream, before the next keyframe). */
export type StreamState = { text: string; whole: boolean };

export function applyStream(
  cur: StreamState | null | undefined,
  ev: { text?: unknown; offset?: unknown; delta?: unknown; len?: unknown },
): StreamState {
  const tail = typeof ev.text === "string" ? ev.text : "";
  if (typeof ev.offset !== "number" || typeof ev.delta !== "string") return { text: tail, whole: false };
  if (ev.offset === 0) return { text: ev.delta, whole: true };
  if (cur?.whole && cur.text.length >= ev.offset) return { text: cur.text.slice(0, ev.offset) + ev.delta, whole: true };
  return { text: tail, whole: typeof ev.len === "number" && tail.length >= ev.len };
}
