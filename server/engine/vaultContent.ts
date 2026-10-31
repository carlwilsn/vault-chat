// A projection of the server's registered vaults into the existing folder
// capabilities, not a second registry or an agent-supplied path grant.
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { VaultRef } from "./index";

/** Pin the directory identity while registered. A replaced root must not turn
 * a content capability into a bind of arbitrary home/server files. Removal
 * drops the pin; a subsequent trusted registration can establish a new one. */
export function registeredVaultContent(own: VaultRef, registered: () => VaultRef[], walls: (v: VaultRef) => string[]) {
  const identities = new Map<string, string>();
  return () => {
    const all = registered();
    const present = new Set(all.map(v => v.path));
    for (const p of identities.keys()) if (!present.has(p)) identities.delete(p);
    const folders: string[] = [];
    const hidden: string[] = [];
    for (const v of all) {
      if (v.path === own.path) continue;
      hidden.push(...(v.bare ? [v.bare] : []), ...walls(v));
      try {
        const st = lstatSync(v.path);
        const id = `${st.dev}:${st.ino}`;
        if (!st.isDirectory() || realpathSync(v.path) !== resolve(v.path)) throw new Error("noncanonical root");
        const previous = identities.get(v.path);
        if (previous && previous !== id) throw new Error("replaced root");
        identities.set(v.path, id);
        folders.push(v.path);
        hidden.push(join(v.path, ".git"), join(v.path, ".vault-chat"));
      } catch {
        hidden.push(v.path); // fail closed, including unsafe-mode native guards
      }
    }
    return { folders, hidden };
  };
}
