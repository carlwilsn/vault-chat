// Stand-in for server/bus.ts when server/commands/fs.ts runs in the preview:
// a "file-changed" emit goes to the page's Tauri event system, as the desktop
// watcher would.
import { emitFromBackend } from "../ipc";

export function emitLocal(event: string, payload: unknown): boolean {
  emitFromBackend(event, payload);
  return true;
}
export function on(): () => void {
  return () => {};
}
export function hasListener(): boolean {
  return false;
}
export function respondTo(): boolean {
  return false;
}
