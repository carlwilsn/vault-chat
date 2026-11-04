// A path inside the vault (the vault file route, http.ts): vault-relative or absolute, resolved through symlinks,
// never outside the vault and never into .git.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The real path of `p`, or of its deepest existing ancestor plus the rest (a file not yet written). */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      rest.push(cur.slice(up.length).replace(/^[\\/]+/, ""));
      cur = up;
    }
  }
}

function relIn(root: string, abs: string): string | null {
  const r = relative(root, abs);
  if (r === "") return "";
  if (r.startsWith("..") || isAbsolute(r)) return null;
  return r.split(sep).join("/");
}

const under = (rel: string, entry: string) => rel === entry || rel.startsWith(entry + "/");

/** Resolve a path (vault-relative or absolute) to an absolute path inside the vault, or throw the refusal. */
export function vaultPath(vault: string, p: unknown, mode: "read" | "write"): { abs: string; rel: string } {
  const raw = (typeof p === "string" ? p : p == null ? "" : String(p)).trim();
  const root = realish(resolve(vault));
  const abs = realish(resolve(raw ? (isAbsolute(raw) ? raw : join(vault, raw)) : vault));
  const rel = relIn(root, abs);
  if (rel === null) throw `Refused: ${raw || "(empty path)"} is outside the vault.`;
  const parts = rel.split("/");
  if (parts.includes(".git")) throw `Refused: the .git folder is off limits.`;
  if (mode === "write" && (under(rel, ".vault-chat/conversations") || under(rel, ".vault-chat/local"))) {
    throw `Refused: ${rel} belongs to the server (conversations and local state are not written by tools).`;
  }
  return { abs, rel };
}
