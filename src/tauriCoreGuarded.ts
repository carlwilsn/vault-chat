// `@tauri-apps/api/core` as the built app sees it (vite.config.ts aliases the bare specifier here, for the app's own
// code and the Tauri plugins it bundles): the real module, with `invoke` asking the Drive window's guard first
// (src/driveGuard.ts). In Carl's own windows the guard never refuses, so this is the real invoke.
// The real module is reached under a name the alias does not rewrite ("vc-tauri-core-real", src/tauriCoreReal.d.ts).
import * as real from "vc-tauri-core-real";
import type { InvokeArgs, InvokeOptions } from "vc-tauri-core-real";
import { driveCommandRefusal } from "./driveGuard";

export * from "vc-tauri-core-real";

export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  const no = driveCommandRefusal(cmd);
  if (no) return Promise.reject(new Error(no));
  return real.invoke<T>(cmd, args, options);
}

// The Drive window runs steps only when this guard is what its invokes go through (src/driveRunner.ts).
(globalThis as { __vcInvokeGuard?: boolean }).__vcInvokeGuard = true;
