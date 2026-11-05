import type { Picture, RowState } from "./convlog/reduce";

export type CacheFile = { epoch: string; cursor: number; rows: RowState[]; pictures: Picture[] };
export const CACHE_MAX_BYTES = 3_000_000;

// JSON's native replacer runs BEFORE encoding a string. Refuse an oversized
// optional replica before copying/escaping megabytes of tool results. The node
// charge also bounds traversal of arrays of tiny values. No picture is sliced.
function encode(value: unknown, limit: number): string | null {
  let remaining = limit;
  const full = {};
  try {
    const body = JSON.stringify(value, (key, v: unknown) => {
      remaining -= key.length + 1 + (typeof v === "string" ? v.length : 8);
      if (remaining < 0) throw full;
      return v;
    });
    return body.length <= limit ? body : null;
  } catch (e) {
    if (e === full) return null;
    throw e;
  }
}

/** One bounded encode per picture, not repeated encodes of the whole replica.
 * Pictures arrive in active-first order. If that first picture cannot fit,
 * leave the previous exact snapshot/cursor alone; the live UI is never changed.
 */
export function encodeBoxCache(file: CacheFile): string | null {
  const head = encode({ epoch: file.epoch, cursor: file.cursor, rows: file.rows }, CACHE_MAX_BYTES);
  if (!head) return null;
  let remaining = CACHE_MAX_BYTES - head.length - 16;
  const pictures: string[] = [];
  for (const picture of file.pictures) {
    const body = encode(picture, remaining);
    if (!body) break;
    pictures.push(body);
    remaining -= body.length + 1;
  }
  if (file.pictures.length && !pictures.length) return null;
  return head.slice(0, -1) + ',"pictures":[' + pictures.join(",") + "]}";
}
