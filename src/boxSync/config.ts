// Which box a repo syncs with (box_sync.rs box_config): the vault-chat folder's own file for a repo in that folder,
// else the vault's `.vault-chat/sync.json`. Null = no box (the old sync).
import type { Git } from "./git";
import { MASTER_FILE, NO_SYNC_MARK } from "./rules";

export type BoxConfig = {
  /** Base URL of the box, without a trailing slash. */
  boxUrl: string;
  /** The vault's name on the box, or the project's folder name. */
  vault: string;
  /** The box's display name, when Settings wrote one. */
  name: string | null;
  /** The branch this laptop writes: `master` for a vault, the project's main branch for a project. */
  branch: string;
  /** A project in the vault-chat folder (synced without the vault's own rules, pushed to its own origin). */
  project: boolean;
};

export const remoteUrl = (c: BoxConfig): string => (c.project ? `${c.boxUrl}/git/projects/${c.vault}.git` : `${c.boxUrl}/git/${c.vault}.git`);

export const joinPath = (a: string, ...rest: string[]): string => [a.replace(/[\\/]+$/, ""), ...rest].join("/");

/** The box's name for a vault: `^[A-Za-z0-9._-]{1,64}$`, not starting with a dot, not ending in .git. */
export function validBoxVaultName(n: string): boolean {
  return n.length > 0 && n.length <= 64 && !n.startsWith(".") && !n.endsWith(".git") && /^[A-Za-z0-9._-]+$/.test(n);
}

/** `<folder>/<kind>/<name>` → (folder, kind, name) when `<folder>` holds the vault-chat folder's file. */
export async function masterRepoOf(git: Git, path: string): Promise<{ master: string; kind: string; name: string } | null> {
  const p = path.replace(/[\\/]+$/, "");
  const parts = p.split(/[\\/]/);
  if (parts.length < 3) return null;
  const name = parts[parts.length - 1]!;
  const kind = parts[parts.length - 2]!;
  if (kind !== "vaults" && kind !== "projects") return null;
  const master = p.slice(0, p.length - name.length - 1 - kind.length - 1);
  if (!validBoxVaultName(name) || !(await git.exists(joinPath(master, MASTER_FILE)))) return null;
  return { master, kind, name };
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw.replace(/^﻿/, ""));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const nonEmpty = (v: unknown): string | null => {
  const s = str(v)?.trim();
  return s ? s : null;
};

async function masterBoxConfig(git: Git, m: { master: string; kind: string; name: string }): Promise<BoxConfig | null> {
  const v = parseJson(await git.readText(joinPath(m.master, MASTER_FILE)));
  const box = str(v?.box);
  if (!v || box === null) return null;
  const boxUrl = box.trim().replace(/\/+$/, "");
  if (!boxUrl) return null;
  const project = m.kind === "projects";
  let branch = "master";
  if (project) {
    const projects = v.projects as Record<string, { branch?: unknown }> | undefined;
    const b = str(projects && typeof projects === "object" ? projects[m.name]?.branch : null);
    branch = b && b !== "box" ? b : "main";
  }
  return { boxUrl, vault: m.name, name: nonEmpty(v.name), branch, project };
}

async function syncJsonConfig(git: Git, vault: string): Promise<BoxConfig | null> {
  const v = parseJson(await git.readText(joinPath(vault, ".vault-chat", "sync.json")));
  const box = str(v?.box);
  if (!v || box === null) return null;
  const boxUrl = box.trim().replace(/\/+$/, "");
  if (!boxUrl) return null;
  const name = nonEmpty(v.vault) ?? (vault.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || null);
  if (!name) return null;
  return { boxUrl, vault: name, name: nonEmpty(v.name), branch: "master", project: false };
}

/** The box this repo syncs with, or null. A repo in the vault-chat folder: the folder's file (it wins over a
 *  sync.json the vault carries). A copy being brought in (its .git marked) never syncs. */
export async function boxConfig(git: Git, vault: string): Promise<BoxConfig | null> {
  if (await git.exists(joinPath(vault, ".git", NO_SYNC_MARK))) return null;
  const m = await masterRepoOf(git, vault);
  if (m) return masterBoxConfig(git, m);
  return syncJsonConfig(git, vault);
}

/** Is this a project in the vault-chat folder (synced without the vault's own rules)? */
export async function isMasterProject(git: Git, vault: string): Promise<boolean> {
  return (await masterRepoOf(git, vault))?.kind === "projects";
}
