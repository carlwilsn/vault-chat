// Node stand-in for `@tauri-apps/api/window` and `webviewWindow`: there are no
// windows headless. Every method is an inert no-op so UI-only code paths that
// are reachable through shared modules don't crash.
const inert: any = new Proxy(function () {}, {
  get: (_t, prop) => (prop === "then" ? undefined : inert),
  apply: () => Promise.resolve(undefined),
});

export function getCurrentWindow(): any {
  return inert;
}
export function getCurrentWebviewWindow(): any {
  return inert;
}
export class WebviewWindow {
  constructor(..._args: unknown[]) {}
  static getByLabel(): null {
    return null;
  }
  once(): Promise<() => void> {
    return Promise.resolve(() => {});
  }
  listen(): Promise<() => void> {
    return Promise.resolve(() => {});
  }
}
/** A plain point (src/sync.ts places the Mac popout's traffic lights with one). */
export class LogicalPosition {
  readonly type = "Logical";
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}
}
