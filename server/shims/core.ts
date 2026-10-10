// Node stand-in for `@tauri-apps/api/core`. `invoke` dispatches to the node
// command table in server/commands; an unknown command throws loudly.
import { dispatch } from "../commands/registry";

export async function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await dispatch(cmd, args ?? {})) as T;
}

/** No asset protocol headless: hand back the raw path. */
export function convertFileSrc(path: string): string {
  return path;
}

export function isTauri(): boolean {
  return false;
}

export class Channel<T = unknown> {
  onmessage: (m: T) => void = () => {};
}
