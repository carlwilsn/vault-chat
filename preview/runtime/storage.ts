// Both sides are served on the shell's one origin (/before/, /after/), so their
// frames would share one localStorage — and each boot clears and seeds it.
// Give each side its own: window.localStorage becomes a view of the real one
// under a key prefix ("vcp:before:"). The app has no storage events, no
// sessionStorage and no IndexedDB, so this is the whole of it. The chat popout
// (same side) shares the main frame's view, as on the real app.

export function namespaceLocalStorage(ns: string): void {
  const real = window.localStorage;
  const pre = `vcp:${ns}:`;
  const own = () => {
    const out: string[] = [];
    for (let i = 0; i < real.length; i++) {
      const k = real.key(i);
      if (k?.startsWith(pre)) out.push(k.slice(pre.length));
    }
    return out;
  };
  const api = {
    getItem: (k: string) => real.getItem(pre + String(k)),
    setItem: (k: string, v: string) => real.setItem(pre + String(k), String(v)),
    removeItem: (k: string) => real.removeItem(pre + String(k)),
    clear: () => {
      for (const k of own()) real.removeItem(pre + k);
    },
    key: (i: number) => own()[i] ?? null,
    get length() {
      return own().length;
    },
  };
  const view = new Proxy(api as unknown as Storage, {
    get(t, p) {
      if (typeof p === "symbol" || p in t) return (t as any)[p];
      return real.getItem(pre + p) ?? undefined;
    },
    set(t, p, v) {
      if (typeof p === "symbol" || p in t) return false;
      real.setItem(pre + p, String(v));
      return true;
    },
    deleteProperty(_t, p) {
      if (typeof p !== "symbol") real.removeItem(pre + p);
      return true;
    },
    has(t, p) {
      return typeof p === "symbol" ? p in t : p in t || real.getItem(pre + p) !== null;
    },
    ownKeys: () => own(),
    getOwnPropertyDescriptor(_t, p) {
      if (typeof p === "symbol") return undefined;
      const v = real.getItem(pre + p);
      return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
    },
  });
  Object.defineProperty(window, "localStorage", { configurable: true, get: () => view });
}
