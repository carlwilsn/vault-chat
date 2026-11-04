import { EditorWrites } from "./editorWrites";
import { isBoxPath, readTextAt, writeTextAt } from "./boxFiles";
import { boxLinkFor, boxPost } from "./boxChat";
import { pushEditorWrites } from "./vaultSync";

export const editorWrites = new EditorWrites({ read: readTextAt, write: writeTextAt });

/** Drain only this viewer's editor work. The conversation's owner is unrelated
 * to its file workspace. Git remains the transport/merge authority for vaults;
 * the existing server flush brings the pushed branch into its working tree. */
export async function saveBeforeSend(vault: string): Promise<void> {
  const writes = await editorWrites.flush(vault);
  if (!writes.length) return;
  const local = writes.filter(w => !isBoxPath(w.path));
  if (local.length) {
    const link = await boxLinkFor(vault);
    if (!link) throw new Error("Edited files are saved locally, but no box is connected");
    await pushEditorWrites(vault);
    const root = vault.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    const files = await Promise.all(local.map(async w => {
      const path = w.path.replace(/\\/g, "/");
      if (!path.startsWith(root)) throw new Error("Edited file is outside this viewer vault");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(w.text));
      const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
      return { path: path.slice(root.length), sha256 };
    }));
    const result = await boxPost(link, "/api/v1/sync/flush", { files });
    if (!result.ok) throw new Error(result.error || "Edited files have not reached the box reader");
  }
  editorWrites.acknowledge(writes);
}
