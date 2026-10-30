// Projects for the clients (the laptop's folder picker and chat panel, the phone). A project is a folder with a
// conversation of its own (server/context/projects.ts); the list is the box's, whatever vault is open:
//   GET  /projects                         → {projects:[{slug, name, folder, vault, rel}]}: every vault's projects
//   POST /projects {folder}                → {ok, slug, name, convId}: "Make this a project" (a folder on the box)
//   POST /projects {name}                  → the same for a new folder of that name in the open vault ("+ New project")
//   POST /conversation/project {convId, project: name|slug|null}
//                                          → {ok, project: slug|null}
//   POST /api/v1/folders {op: rename|delete, path, name?}
//                                          → Carl's ⋯ on a folder that is not a project (server/folderOps.ts)
// and the agent's OpenProject (openProject below): Carl asked, in so many words, to start a project or to work on
// one — the same create-or-attach, then his screens and a live call follow to its thread.
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { configureContext, ctxConfig, withVault } from "./context/config";
import { allProjects, ensureProject, folderName, makeProject } from "./context/projects";
import { ensureProjectThread, patchMeta } from "./engine/convs";
import { MAIN_ID, MAIN_TITLE, projectThreadId } from "../src/threads";
import { followVoice } from "./voice";
import { masterDir } from "./master";
import { checkFolder, deletedFolders, registeredFolder, registeredFolders } from "./projectFolders";
import { ownerVault } from "./convlog/log";
import { deleteFolder, folderOpsWalls, renameFolder } from "./folderOps";

function ready(vault: string): void {
  let v = "";
  try {
    v = ctxConfig().vault;
  } catch {
    /* not configured yet */
  }
  if (!v) configureContext({ vault });
}

export type VaultRef = { name: string; path: string; main?: boolean };

const fwd = (p: string) => p.split("\\").join("/");
const under = (p: string, dir: string) => {
  const r = relative(dir, p);
  return r === "" || (!!r && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

/** A path from a client: absolute on the box, or relative to the vault-chat folder (the laptop's picker). */
export function boxPathOf(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim().replace(/\\/g, "/") : "";
  if (!s) return null;
  if (s.startsWith("/") || isAbsolute(s)) return resolve(s);
  const m = masterDir();
  if (!m) return null;
  const abs = resolve(m, s);
  return under(abs, resolve(m)) ? abs : null;
}

/** The vault that owns a project in `folder`: the (deepest) vault it is in, else the main vault. */
export function ownerOfFolder(folder: string, vaults: VaultRef[]): VaultRef {
  const inside = vaults.filter((v) => under(resolve(folder), resolve(v.path))).sort((a, b) => b.path.length - a.path.length);
  return inside[0] ?? vaults.find((v) => v.main) ?? vaults[0]!;
}

/** A slug in use anywhere on the box but `owner`'s own registry (a project, a deleted one, a thread in another log). */
function slugTaken(vaults: VaultRef[], owner: VaultRef): (slug: string) => boolean {
  return (slug) => {
    for (const v of vaults) {
      if (resolve(v.path) === resolve(owner.path)) continue;
      if (registeredFolder(v.path, slug) || Object.values(deletedFolders(v.path)).some((d) => d.slug === slug)) return true;
    }
    const at = ownerVault(projectThreadId(slug), owner.path);
    return !!at && resolve(at) !== resolve(owner.path);
  };
}

export type ProjectRow = { slug: string; name: string; folder: string; vault: string; rel: string | null };

function relOf(abs: string): string | null {
  const m = masterDir();
  return m && under(resolve(abs), resolve(m)) ? fwd(relative(resolve(m), resolve(abs))) : null;
}

/** Every project on the box: `vault` its owner's name, `rel` its folder relative to the vault-chat folder (null: outside it). */
export function projectsList(vaults: VaultRef[]): { projects: ProjectRow[] } {
  const out: ProjectRow[] = [];
  const seen = new Set<string>();
  for (const v of vaults)
    for (const e of registeredFolders(v.path)) {
      if (seen.has(e.slug) || !existsSync(e.path)) continue;
      seen.add(e.slug);
      out.push({ slug: e.slug, name: folderName(e.path), folder: fwd(e.path), vault: v.name, rel: relOf(e.path) });
    }
  return { projects: out.sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function setProject(
  vault: string,
  body: { convId?: unknown; project?: unknown },
): Promise<{ ok: true; project: string | null } | { error: string }> {
  ready(vault);
  const convId = typeof body.convId === "string" ? body.convId : "";
  if (!convId) return { error: "convId required" };
  const want = typeof body.project === "string" && body.project.trim() ? body.project.trim() : null;
  let slug: string | null = null;
  if (want) {
    try {
      slug = withVault(vault, () => ensureProject(want).project.slug);
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) };
    }
  }
  const done = !!(await patchMeta(vault, convId, { project: slug ?? undefined }));
  if (!done) return { error: "conversation not found" };
  return { ok: true, project: slug };
}

/**
 * Carl's "Make this a project" (`folder`: a folder on the box, absolute or relative to the vault-chat folder) or
 * "+ New project" (`name`: a new folder of that name in `vault`, the open one): the project, registered in the vault
 * that holds the folder (else the main vault), and its one thread in that vault's log. `vaults`: every vault.
 */
export async function createProjectWithThread(
  vault: string,
  body: { name?: unknown; folder?: unknown },
  vaults: VaultRef[] = [{ name: "main", path: vault, main: true }],
): Promise<{ ok: true; slug: string; name: string; convId: string; created: boolean; folder: string; vault: string } | { error: string }> {
  ready(vault);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const wanted = body.folder !== undefined && body.folder !== null && body.folder !== "";
  const folder = wanted ? boxPathOf(body.folder) : null;
  if (wanted && !folder) return { error: `"${String(body.folder).slice(0, 120)}" is not a folder in the vault-chat folder` };
  if (!folder && !name) return { error: "a folder or a name is required" };
  const here = vaults.find((v) => resolve(v.path) === resolve(vault)) ?? { name: "main", path: vault, main: true };
  // A folder some vault's registry already holds is that vault's project (the vault-chat repo is the vault-chat vault's).
  const already = folder ? vaults.find((v) => registeredFolders(v.path).some((e) => resolve(e.path) === resolve(folder))) : undefined;
  const owner = already ?? (folder ? ownerOfFolder(folder, vaults) : here);
  try {
    const out = withVault(owner.path, () => {
      if (folder) {
        if (!existsSync(folder)) return { error: `${folder} does not exist on the box` };
        const c = checkFolder(owner.path, folder);
        if ("error" in c) return c;
        const had = registeredFolders(owner.path).some((e) => e.path === c.abs);
        const p = makeProject(c.abs, slugTaken(vaults, owner));
        return "error" in p ? p : { project: p, created: !had };
      }
      return ensureProject(name, slugTaken(vaults, owner));
    });
    if ("error" in out) return { error: out.error };
    const { project, created } = out;
    // A new project: a new thread even where a deleted project of that slug had one (RestoreProject brings that back).
    const conv = await ensureProjectThread(owner.path, project.slug, project.name, { fresh: created });
    return { ok: true, slug: project.slug, name: project.name, convId: conv.id, created, folder: fwd(project.folder), vault: owner.name };
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) };
  }
}

/**
 * Carl's ⋯ on a folder in the picker: Rename or Delete (recoverable: server/folderOps.ts). A project's folder goes
 * through its project instead (Rename keeps its thread; Delete asks whether the folder goes too).
 */
export async function folderRoute(body: { op?: unknown; path?: unknown; name?: unknown }, vaults: VaultRef[]): Promise<Record<string, unknown>> {
  const w = folderOpsWalls();
  if (!w) return { ok: false, error: "folders are not available on this box" };
  const abs = boxPathOf(body.path);
  if (!abs) return { ok: false, error: `"${String(body.path ?? "").slice(0, 120)}" is not in the vault-chat folder` };
  for (const v of vaults) {
    const hit = registeredFolders(v.path).find((e) => resolve(e.path) === abs);
    if (hit) return { ok: false, error: `${folderName(abs)} is a project: use its own Rename or Delete`, project: hit.slug };
  }
  if (body.op === "rename") {
    const r = renameFolder(abs, String(body.name ?? ""), w);
    return "error" in r ? { ok: false, error: r.error } : { ok: true, path: fwd(r.path), rel: relOf(r.path) };
  }
  if (body.op === "delete") {
    const r = await deleteFolder(abs, w);
    return "error" in r ? { ok: false, error: r.error } : { ...r, where: fwd(r.where) };
  }
  return { ok: false, error: "op: rename or delete" };
}

export type OpenProjectDeps = {
  /** A signal on the vault's feed (/poll): {type:"follow", convId, title, project}; the laptop and the phone open that thread. */
  emit?: (ev: Record<string, unknown>) => void;
  /** The engine's /message: Carl's request goes to the thread, and the work runs there. */
  message?: (b: { convId: string; text: string; context?: string; queue?: boolean; source?: string }) => Promise<Record<string, unknown> | null>;
};

type Send = (b: { convId: string; text: string; context?: string; queue?: boolean; source?: string }) => Promise<Record<string, unknown> | null>;

/** The box's router (set at boot): a message to any conversation, on the engine of the vault that holds it; and
 *  every vault on the box. */
let route: Send | null = null;
let vaultsNow: (() => VaultRef[]) | null = null;
export function setConversationRouter(fn: Send, vaults: () => VaultRef[]): void {
  route = fn;
  vaultsNow = vaults;
}

export const OPEN_PROJECT_DESCRIPTION =
  `Only when Carl asks, in so many words, spoken or typed: "start a project for HW4" (create: true) or "let's work on project Physics" / "back to Main" (project: "main"). Never on your own initiative and never as a suggestion you then act on. ` +
  "There is one of you: a project's thread is a place you work, and Main is home. This makes the project when he asked to start one (create-or-attach by name: a folder of that name in the vault, and its one thread), finds it otherwise, and takes his screens and a live voice call to its thread: what he says or types next arrives there. " +
  "request: what he asked to be done there, in his words; it goes to that thread, which does the work (do not also do it here). Without request, say in a few words that you are there.";

export const OPEN_PROJECT_SCHEMA = {
  type: "object",
  properties: {
    project: { type: "string", description: "The project's name as Carl said it (or its slug); main for Main." },
    create: { type: "boolean", description: "He asked to start (make) a project. Without it, only an existing project is opened." },
    request: { type: "string", description: "What he asked to be done there, in his words (optional)." },
  },
  required: ["project"],
  additionalProperties: false,
};

/** OpenProject: Carl's explicit ask to start or work on a project (or go back to Main). Never throws. */
export async function openProject(vault: string, args: Record<string, unknown>, d: OpenProjectDeps = {}): Promise<{ ok: boolean; text: string; convId?: string }> {
  const want = typeof args.project === "string" ? args.project.trim() : "";
  if (!want) return { ok: false, text: "OpenProject needs project: the name Carl said (or \"main\")." };
  const request = typeof args.request === "string" ? args.request.trim() : "";
  const vaults = vaultsNow?.() ?? [{ name: "main", path: vault, main: true }];
  let convId: string;
  let title: string;
  let slug: string | null = null;
  let created = false;
  let folder: string | null = null;
  try {
    ready(vault);
    const low = want.toLowerCase();
    const isMain = /^main$/i.test(want);
    const found = isMain ? null : withVault(vault, () => allProjects()).find((p) => p.slug === want || p.name.toLowerCase() === low);
    if (isMain) {
      convId = MAIN_ID;
      title = MAIN_TITLE;
    } else if (found) {
      convId = (await ensureProjectThread(found.vault, found.slug, found.name)).id;
      slug = found.slug;
      title = found.name;
      folder = fwd(found.folder);
    } else if (args.create === true) {
      const r = await createProjectWithThread(vault, { name: want }, vaults);
      if ("error" in r) return { ok: false, text: `The project was not made: ${r.error}.` };
      ({ convId, slug, created, folder } = r);
      title = r.name;
    } else {
      const names = withVault(vault, () => allProjects()).map((p) => p.name);
      return {
        ok: false,
        text: `Carl has no project "${want}" (${names.length ? `his projects: ${names.join(", ")}` : "he has none yet"}). Nothing changed. If he asked to start it, call OpenProject again with create: true; otherwise ask him which one he means.`,
      };
    }
  } catch (e) {
    return { ok: false, text: `OpenProject failed: ${(e as Error)?.message ?? String(e)}. Nothing changed.` };
  }
  // The surfaces follow: the laptop and the phone open the thread; a live call's lines, tools and updates go there.
  d.emit?.({ type: "follow", convId, title, ...(slug ? { project: slug } : {}), ...(created ? { created: true } : {}) });
  const call = followVoice(vault, convId);
  let handed = "";
  const send = route ?? d.message;
  if (request && send) {
    const out = await send({ convId, text: request, queue: true, context: `[Carl asked for this and you moved to ${slug ? `the thread of his project "${title}"` : "Main"} to do it (OpenProject). Do it here.]` }).catch((e) => ({ error: (e as Error)?.message ?? String(e) }));
    handed = out && !out.error ? " His request went to that thread, which is doing it now: don't do it here too." : ` His request did not reach that thread (${String(out?.error ?? "no answer")}): do it there with him.`;
  }
  const where = slug ? `${created ? "Started" : "Opened"} project ${title} (the folder ${folder}); its thread is ${convId}` : "Back in Main";
  return { ok: true, convId, text: `${where}. His screens${call ? " and the live call" : ""} are there now; what he says next arrives there.${handed}` };
}
