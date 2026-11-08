// The sandbox the agent's work happens inside: the bubblewrap layers, what
// they hide, and the project folders they bind.
//
// This was pi's (server/engine/pi/backend.ts) and outlived it: Claude Code's
// sessions and every shell command the agent runs are wrapped in exactly the
// same layers, so when pi went this came here whole rather than being deleted
// with it.
import { statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export type Sandbox = {
  /** Own vault root (separate from the project cwd). */
  vault?: string;
  /** bubblewrap argv for the engine itself (ends with "--"), or null (no sandbox). */
  outer: string[] | null;
  /** bubblewrap argv for each shell command (ends with "--"), or null. */
  shell: string[] | null;
  /** Paths the agent's own file tools may not read or write / may not write. */
  denyRead: string[];
  denyWrite: string[];
  /** Private paths (other vault metadata, bare repos and engine state), read at each
   * spawn: hidden in the outer layer and denied to the native file guard. */
  others?: () => string[];
  /** Ordinary content of server-registered vaults, never their private metadata. */
  vaultContent?: () => string[];
  /** The vault roots the sandbox empties (tmpfs): another vault under one is already gone, never re-walled. */
  roots?: string[];
  /** The project folders Carl chose outside the vault (server/projectFolders.ts), read at each spawn: each is
   * bound read-write, and nothing else new. */
  projects?: () => string[];
  /** Project folders that are git repos (server/projectChanges.ts): read-only, even where the home is not (the
   * agent works in its clone; only Carl's Keep changes the project). */
  readOnly?: () => string[];
  /** What the layers hide (credentials, the key store, tokens): hidden again inside a project folder's bind. */
  hidden?: string[];
};

/** bubblewrap args hiding each path that exists (a dir behind an empty tmpfs, a file behind /dev/null). */
export function hideArgs(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    try {
      const st = statSync(p);
      if (st.isDirectory()) out.push("--tmpfs", p, "--remount-ro", p);
      else if (st.isFile()) out.push("--ro-bind", "/dev/null", p);
    } catch {
      /* missing: nothing to hide */
    }
  }
  return out;
}

/** The outer bubblewrap argv with the other vaults hidden and the project folders bound (null without a sandbox). */
export function outerWith(sb: Sandbox): string[] | null {
  return withExtras(sb, sb.outer);
}

/** The per-command shell layer, the same way: a command in a project folder writes there too. */
export function shellWith(sb: Sandbox): string[] | null {
  return withExtras(sb, sb.shell);
}

const inside = (p: string, d: string) => {
  const rel = relative(d, p);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
};

function withExtras(sb: Sandbox, base: string[] | null): string[] | null {
  if (!base) return null;
  // A path under an emptied vault root does not exist in the sandbox; a --tmpfs on it would create an
  // empty stub named after that vault. Only what lies elsewhere (e.g. its engine state) is walled.
  const gone = (p: string) => (sb.roots ?? []).some((r) => inside(p, r));
  const content = sb.vaultContent?.() ?? [];
  const others = sb.others?.() ?? [];
  const readOnly = sb.readOnly?.() ?? [];
  // Carl's project folders: read-write, after the read-only home. Anything hidden that lies inside one is
  // hidden again after it (a later mount wins), as are the other vaults.
  const binds: string[] = [];
  const folders: string[] = [];
  for (const p of content) {
    folders.push(p);
    binds.push("--bind", p, p);
  }
  for (const p of sb.projects?.() ?? []) {
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    folders.push(p);
    binds.push("--bind", p, p);
  }
  for (const p of readOnly) {
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    folders.push(p);
    binds.push("--ro-bind", p, p);
  }
  // A read-only project folder (a git repo the agent works on in its clone): its own files — memory, rules in
  // <folder>/.vault-chat (server/context/projects.ts) — stay the agent's to write.
  for (const p of readOnly) {
    const own = join(p, ".vault-chat");
    try {
      if (statSync(own).isDirectory()) binds.push("--bind", own, own);
    } catch {
      /* none yet */
    }
  }
  for (const p of readOnly) {
    for (const d of ["conversations", "events", "local"]) {
      const path = join(p, ".vault-chat", d);
      try { if (statSync(path).isDirectory()) binds.push("--tmpfs", path, "--remount-ro", path); } catch { /* absent */ }
    }
  }
  const rehide = folders.length ? (sb.hidden ?? []).filter((h) => folders.some((f) => inside(h, f))) : [];
  const metadata = content.flatMap(p => [join(p, ".vault-chat"), join(p, ".git")]);
  const extra = [...binds, ...hideArgs([...rehide, ...others.filter((p) => !metadata.includes(p) && (!gone(p) || folders.some((f) => inside(p, f))))]),
    ...metadata.flatMap(p => {
      try { if (statSync(p).isFile()) return ["--ro-bind", "/dev/null", p]; } catch { /* create an empty wall */ }
      return ["--tmpfs", p, "--remount-ro", p];
    }),
    // The masked roots are namespaces, not scratch folders: a write creates
    // missing parents. Make them read-only so an unregistered destination (or
    // a symlink into one) cannot report a successful edit of an ephemeral copy.
    ...(sb.vaultContent ? (sb.roots ?? []).flatMap(p => ["--remount-ro", p]) : [])];
  return extra.length ? [...base.slice(0, -1), ...extra, "--"] : base;
}
