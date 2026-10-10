// In-process event bus standing in for Tauri's `listen`/`emit`, plus the
// request/response relay the Rust phone server used (voice_server.rs:1476
// relay_request): the HTTP layer emits `phone:*` with a reqId, the app's
// handler answers through the `voice_tool_respond` command, and the waiting
// request resolves.

export type BusEvent<T = unknown> = { event: string; id: number; payload: T };
type Handler = (e: BusEvent<any>) => unknown;

const handlers = new Map<string, Set<Handler>>();
let nextId = 1;

export function on(event: string, h: Handler): () => void {
  let set = handlers.get(event);
  if (!set) handlers.set(event, (set = new Set()));
  set.add(h);
  return () => {
    set!.delete(h);
  };
}

export function hasListener(event: string): boolean {
  return (handlers.get(event)?.size ?? 0) > 0;
}

/** Deliver to every listener. Handler errors are logged, never thrown at the
 * emitter (Tauri's emit is fire-and-forget too). */
export function emitLocal(event: string, payload: unknown): boolean {
  const set = handlers.get(event);
  if (!set || set.size === 0) return false;
  const e: BusEvent = { event, id: nextId++, payload };
  for (const h of [...set]) {
    try {
      const r = h(e);
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        (r as Promise<unknown>).catch((err) => console.warn(`[bus] ${event} handler failed:`, err));
      }
    } catch (err) {
      console.warn(`[bus] ${event} handler threw:`, err);
    }
  }
  return true;
}

// ---- relay (request id → reply) ----

const pending = new Map<string, (s: string) => void>();
let reqCounter = 1;

/** Answer a relayed request (the `voice_tool_respond` command, lib.rs:6760). */
export function respondTo(reqId: string, result: string): void {
  const r = pending.get(String(reqId));
  if (r) {
    pending.delete(String(reqId));
    r(result);
  }
}

/** voice_server.rs:1476 relay_request — emit with a reqId merged into the
 * payload, wait for the reply. Resolves null on no listener or timeout. */
export function relay(event: string, payload: Record<string, unknown>, timeoutMs: number): Promise<string | null> {
  const id = String(reqCounter++);
  if (!hasListener(event)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, timeoutMs);
    pending.set(id, (s) => {
      clearTimeout(timer);
      resolve(s);
    });
    emitLocal(event, { ...payload, reqId: id });
  });
}
