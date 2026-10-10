// Node stand-in for `@tauri-apps/api/event`: an in-process bus.
import { on, emitLocal, type BusEvent } from "../bus";

export type Event<T> = BusEvent<T>;
export type UnlistenFn = () => void;

export async function listen<T>(event: string, handler: (e: Event<T>) => void): Promise<UnlistenFn> {
  return on(event, handler as (e: BusEvent<any>) => unknown);
}

export async function once<T>(event: string, handler: (e: Event<T>) => void): Promise<UnlistenFn> {
  const off = on(event, (e) => {
    off();
    return handler(e as Event<T>);
  });
  return off;
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  emitLocal(event, payload);
}

export async function emitTo(_target: unknown, event: string, payload?: unknown): Promise<void> {
  emitLocal(event, payload);
}
