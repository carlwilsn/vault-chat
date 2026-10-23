// Unsaved work, kept on the iPad (IndexedDB) until the box has it: nothing on a board exists only in memory.
//
// One record per board (key: vault + slug): the whole board as JSON, the rev it was based on, and who wrote it
// (`writer`: the page's id for this board, `gen`: how far its edits had got). view.ts writes it shortly after every
// change (and at once when the page hides) and deletes it when the box acknowledges that gen. Opening a board with a
// record left behind (a reload, the app closed or killed, a save cut off by a restart) sends it to the box first
// (main.ts: the box takes it when nothing else changed the board since, or already has it; a real conflict asks).
//
// A board is about 5 MB of JSON: one string per record, no history. A refused write (storage full, private mode) is
// logged (`local.fail`) and the board goes on saving to the box as before.
import { blog } from "./log";

export type LocalRec = { key: string; slug: string; json: string; base: number; writer: string; gen: number; at: number; strokes: number; items: number };

const DB = "vc-board";
const STORE = "unsaved";
let dbp: Promise<IDBDatabase | null> | null = null;
let failedOnce = false;

function db(): Promise<IDBDatabase | null> {
  if (!dbp) {
    dbp = new Promise<IDBDatabase | null>((res) => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: "key" });
        };
        r.onsuccess = () => {
          const d = r.result;
          // Another page upgrading, or iPadOS closing it: open again next time.
          d.onversionchange = () => (d.close(), (dbp = null));
          d.onclose = () => (dbp = null);
          res(d);
        };
        r.onerror = () => (fail("open", r.error), res(null));
        r.onblocked = () => res(null);
      } catch (e) {
        fail("open", e);
        res(null);
      }
    });
    // Ask once that the browser keep this origin's storage (a Home Screen app usually is kept anyway).
    void navigator.storage?.persist?.().catch(() => {});
  }
  return dbp;
}

function fail(op: string, e: unknown): void {
  const name = (e as DOMException | null)?.name ?? "";
  blog("local.fail", { op, error: `${name}${name ? ": " : ""}${String((e as Error)?.message ?? e).slice(0, 160)}` });
  if (!failedOnce) console.warn(`[board] local ${op} failed`, e);
  failedOnce = true;
}

/** One request in a transaction on the store, as a promise (null on any failure, logged). */
async function tx<T>(mode: IDBTransactionMode, op: string, f: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<{ v: T | undefined } | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((res) => {
    try {
      const t = d.transaction(STORE, mode);
      let v: T | undefined;
      const r = f(t.objectStore(STORE));
      if (r) r.onsuccess = () => (v = r.result);
      t.oncomplete = () => res({ v });
      t.onerror = () => (fail(op, t.error), res(null));
      t.onabort = () => (fail(op, t.error ?? "aborted"), res(null));
    } catch (e) {
      fail(op, e);
      dbp = null;
      res(null);
    }
  });
}

export const localKey = (vault: string, slug: string) => `${vault}\u0000${slug}`;

/** Keep `rec` (replacing an older one of the same board). False when the device refused it. */
export async function putLocal(rec: LocalRec): Promise<boolean> {
  return !!(await tx("readwrite", "put", (s) => s.put(rec)));
}

/** The record kept for this board, if any. */
export async function getLocal(key: string): Promise<LocalRec | null> {
  const r = await tx<LocalRec>("readonly", "get", (s) => s.get(key));
  return r?.v ?? null;
}

/**
 * The box has this writer's edits up to `gen`: the record goes, unless it holds later ones (or another page's). One
 * transaction, so a newer record written meanwhile is never deleted.
 */
export async function ackLocal(key: string, writer: string, gen: number): Promise<void> {
  await tx("readwrite", "ack", (s) => {
    const g = s.get(key);
    g.onsuccess = () => {
      const rec = g.result as LocalRec | undefined;
      if (rec && rec.writer === writer && rec.gen <= gen) s.delete(key);
    };
  });
}

/** Drop the record, whatever it holds (it was sent, or set aside by choice). */
export async function dropLocal(key: string): Promise<void> {
  await tx("readwrite", "drop", (s) => s.delete(key));
}
