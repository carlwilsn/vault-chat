// A vault's work area outside the vault (code checkouts, builds, scratch): `~/agent-work/<vault>/`, writable in the
// sandbox. The name is the vault's own when it is the box's vault of that name (~/vaults/<name>); any other vault
// with that name — a test instance's copy in /tmp, a second checkout — gets its own area (`<name>-<hash of its path>`),
// never the live vault's: a throwaway instance's worker wrote its build scratch into ~/agent-work/school2/, the live
// school2's area (the voice roleplay, 2026-10-25).
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

export function agentWorkDir(home: string, vault: string): string {
  const path = resolve(vault.replace(/[\/]+$/, ""));
  const name = basename(path);
  if (path === resolve(join(home, "vaults", name))) return join(home, "agent-work", name);
  return join(home, "agent-work", `${name}-${createHash("sha1").update(path).digest("hex").slice(0, 8)}`);
}
