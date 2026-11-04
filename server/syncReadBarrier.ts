import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { vaultPath } from "./vaultPath";

/** No upload or overwrite: Git owns merging. Confirm the working-copy bytes
 * the agent's native read tool will see, not merely receipt into the bare hub. */
export async function syncReadBarrier(vault: string, files: unknown, flush: () => Promise<void>): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!Array.isArray(files) || !files.length || files.length > 128 || files.some(f => !f || typeof f.path !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256))) {
    return { status: 400, body: { error: "files: 1–128 relative paths with SHA-256 required" } };
  }
  const checked: { abs: string; sha256: string }[] = [];
  try {
    for (const f of files) checked.push({ abs: vaultPath(vault, f.path, "read").abs, sha256: f.sha256 });
  } catch {
    return { status: 403, body: { error: "Edited file is outside the viewer vault" } };
  }
  try {
    await flush();
    for (const f of checked) {
      // Re-resolve after the merge: a symlink's destination may have changed.
      const abs = vaultPath(vault, f.abs, "read").abs;
      if (createHash("sha256").update(readFileSync(abs)).digest("hex") !== f.sha256) {
        return { status: 409, body: { error: "Edited files are not yet in the box working copy; check sync/conflicts and retry" } };
      }
    }
    return { status: 200, body: { ok: true } };
  } catch {
    return { status: 409, body: { error: "Edited files could not be confirmed on the box; edits remain on this laptop" } };
  }
}
