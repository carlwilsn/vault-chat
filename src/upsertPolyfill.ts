// Map/WeakMap.prototype.getOrInsert and getOrInsertComputed (the TC39 "upsert" proposal), where the engine has none.
// pdf.js 5.6 calls getOrInsertComputed on its page and font maps; macOS 15's WebKit (the Mac app's webview) has no
// such method, so every page render threw "getOrInsertComputed is not a function" and no PDF ever drew on a Mac.
// Chromium (Windows' WebView2) has them; there nothing is added.

type Upsert = {
  getOrInsert?: (key: unknown, value: unknown) => unknown;
  getOrInsertComputed?: (key: unknown, make: (key: unknown) => unknown) => unknown;
};

/** Whether this engine's Map lacks getOrInsertComputed (then pdf.js needs its legacy worker too). */
export function lacksUpsert(): boolean {
  return typeof (Map.prototype as Upsert).getOrInsertComputed !== "function";
}

/** Add the two methods to a Map-like prototype that lacks them (non-enumerable, as built-ins are). Returns how many. */
export function addUpsert(proto: { has(k: unknown): boolean; get(k: unknown): unknown; set(k: unknown, v: unknown): unknown }): number {
  let n = 0;
  const define = (name: keyof Upsert, fn: (...a: never[]) => unknown) => {
    if (typeof (proto as Upsert)[name] === "function") return;
    Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true, enumerable: false });
    n++;
  };
  define("getOrInsert", function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (!this.has(key)) this.set(key, value);
    return this.get(key);
  });
  define("getOrInsertComputed", function (this: Map<unknown, unknown>, key: unknown, make: (key: unknown) => unknown) {
    if (typeof make !== "function") throw new TypeError("getOrInsertComputed needs a function");
    if (!this.has(key)) this.set(key, make(key));
    return this.get(key);
  });
  return n;
}

/** Install on Map and WeakMap (once; a second call adds nothing). */
export function installUpsert(): void {
  addUpsert(Map.prototype as never);
  addUpsert(WeakMap.prototype as never);
}
