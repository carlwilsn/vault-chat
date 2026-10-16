// An agent's file edits reach the laptop's open file within a few seconds,
// not at the end of its turn: after a Write/Edit/NotebookEdit the vault is
// committed and published (a sync cycle: commit box, push it to the bare repo
// the laptop fetches), then the clients hear `vault_changed` on /poll and run
// their own sync at once. A burst of edits is one cycle (debounced).
// Before any of that, each write is announced at once as `file_changed`
// {vault, type, path}: a laptop showing that file fetches the box's bytes
// (GET /api/v1/vault/file) and shows them in place — display only, the sync
// catches the disk up behind it.
import { isAbsolute, relative, resolve } from "node:path";

/** The tools whose success means a file in the vault changed. */
export const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/** The vault-relative path a write tool's input names, or null (outside the vault / no path). */
export function writtenPath(vault: string, input: unknown): string | null {
  const a = (input ?? {}) as Record<string, unknown>;
  const p = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "";
  if (!p.trim()) return null;
  const abs = isAbsolute(p) ? p : resolve(vault, p);
  const rel = relative(resolve(vault), abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return null;
  return rel;
}

export type LiveEditsDeps = {
  /** Commit and publish the vault now (resolves when the cycle is done). */
  flush: (vault: string) => Promise<void>;
  broadcast: (ev: Record<string, unknown>) => void;
  /** Quiet time after the last write before the cycle runs. */
  delayMs?: number;
  /** A steady stream of writes still publishes this often. */
  maxWaitMs?: number;
};

type Pending = { paths: Set<string>; timer: ReturnType<typeof setTimeout>; first: number };

export class LiveEdits {
  private pending = new Map<string, Pending>();
  constructor(private d: LiveEditsDeps) {}

  /** `vault`: the vault's name on the box; `paths` vault-relative. */
  note(vault: string, paths: string[]): void {
    // No debounce, no commit to wait for: the open pane shows the edit now.
    for (const path of new Set(paths)) this.d.broadcast({ vault, type: "file_changed", path });
    const delay = this.d.delayMs ?? 1000;
    const maxWait = this.d.maxWaitMs ?? 3000;
    const p = this.pending.get(vault);
    const now = Date.now();
    if (p) {
      clearTimeout(p.timer);
      for (const x of paths) p.paths.add(x);
      p.timer = setTimeout(() => void this.fire(vault), Math.max(0, Math.min(delay, p.first + maxWait - now)));
      return;
    }
    this.pending.set(vault, { paths: new Set(paths), first: now, timer: setTimeout(() => void this.fire(vault), delay) });
  }

  private async fire(vault: string): Promise<void> {
    const p = this.pending.get(vault);
    if (!p) return;
    this.pending.delete(vault);
    try {
      await this.d.flush(vault);
    } catch (e) {
      console.warn(`[live-edits] ${vault}: sync failed:`, (e as Error)?.message ?? e);
    }
    // The vault's name first: /poll scopes events by it (http.ts eventVault).
    this.d.broadcast({ vault, type: "vault_changed", paths: [...p.paths].sort() });
  }

  stop(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
