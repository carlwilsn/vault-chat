// node:async_hooks for the reused server modules in the browser: one scope at a
// time is all the preview's single-threaded fake backend ever needs.
export class AsyncLocalStorage<T> {
  private store: T | undefined;
  getStore(): T | undefined {
    return this.store;
  }
  run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    const prev = this.store;
    this.store = store;
    try {
      return fn(...args);
    } finally {
      this.store = prev;
    }
  }
}
