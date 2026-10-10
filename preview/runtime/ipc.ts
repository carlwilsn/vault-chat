// A fake `window.__TAURI_INTERNALS__`, the object every @tauri-apps/* module
// (bare, relative like api/app, dynamic-import and plugin) talks through. This
// follows @tauri-apps/api/mocks (mockIPC + mockWindows + shouldMockEvents) but
// adds what the app needs from a real backend: events the backend can emit,
// emitTo, and a BroadcastChannel relay so the chat popout tab gets the main
// window's events like a second Tauri webview would.

export type InvokeHandler = (cmd: string, args: Record<string, any>) => unknown | Promise<unknown>;

type Listener = { event: string; handlerId: number; eventId: number };

const callbacks = new Map<number, (data: unknown) => unknown>();
const listeners: Listener[] = [];
let nextEventId = 1;
let nextEmitId = 1;
let label = "main";
let channel: BroadcastChannel | null = null;

function transformCallback(cb?: (data: unknown) => unknown, once = false): number {
  const id = crypto.getRandomValues(new Uint32Array(1))[0];
  callbacks.set(id, (data) => {
    if (once) callbacks.delete(id);
    return cb && cb(data);
  });
  return id;
}

function deliver(event: string, payload: unknown): void {
  for (const l of listeners.filter((x) => x.event === event)) {
    const cb = callbacks.get(l.handlerId);
    if (!cb) continue;
    try {
      cb({ event, id: nextEmitId++, payload });
    } catch (e) {
      console.error(`[preview] listener for ${event} threw`, e);
    }
  }
}

/** Fire an event into this page (and, for global events, other preview tabs). */
export function emitFromBackend(event: string, payload: unknown, target?: string): void {
  if (!target || target === label) deliver(event, payload);
  if (target !== label) channel?.postMessage({ event, payload, target: target ?? null, from: label });
}

export function listenerCount(event: string): number {
  return listeners.filter((l) => l.event === event).length;
}

export function installIpc(windowLabel: string, handler: InvokeHandler, side: string): void {
  label = windowLabel;
  const w = window as any;
  w.isTauri = true;
  w.__TAURI_INTERNALS__ = w.__TAURI_INTERNALS__ ?? {};
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = w.__TAURI_EVENT_PLUGIN_INTERNALS__ ?? {};
  const internals = w.__TAURI_INTERNALS__;

  try {
    channel = new BroadcastChannel(`vc-preview-events:${side}`);
    channel.onmessage = (m) => {
      const { event, payload, target, from } = m.data ?? {};
      if (from === label) return;
      if (target && target !== label) return;
      deliver(event, payload);
    };
  } catch {
    channel = null;
  }

  internals.metadata = {
    currentWindow: { label: windowLabel },
    currentWebview: { windowLabel, label: windowLabel },
  };
  internals.transformCallback = transformCallback;
  internals.unregisterCallback = (id: number) => callbacks.delete(id);
  internals.runCallback = (id: number, data: unknown) => callbacks.get(id)?.(data);
  internals.callbacks = callbacks;
  internals.plugins = { path: { sep: "/", delimiter: ":" } };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = (event: string, eventId: number) => {
    const i = listeners.findIndex((l) => l.event === event && l.eventId === eventId);
    if (i >= 0) {
      callbacks.delete(listeners[i].handlerId);
      listeners.splice(i, 1);
    }
  };

  internals.invoke = async (cmd: string, args: Record<string, any> = {}) => {
    switch (cmd) {
      case "plugin:event|listen": {
        const eventId = nextEventId++;
        listeners.push({ event: args.event, handlerId: args.handler, eventId });
        return eventId;
      }
      case "plugin:event|unlisten": {
        const i = listeners.findIndex((l) => l.event === args.event && l.eventId === args.eventId);
        if (i >= 0) listeners.splice(i, 1);
        return null;
      }
      case "plugin:event|emit":
        emitFromBackend(args.event, args.payload);
        return null;
      case "plugin:event|emit_to": {
        const t = args.target;
        const tl = typeof t === "string" ? t : t?.label ?? null;
        emitFromBackend(args.event, args.payload, tl ?? undefined);
        return null;
      }
    }
    return handler(cmd, args ?? {});
  };
}
