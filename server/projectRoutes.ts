// Projects for the clients (the desktop chip in box mode, the phone):
//   GET  /projects                         → {projects:[{slug,name}]}
//   POST /projects {name}                  → {ok, slug, name, convId}: a new project (Carl's "+ New project") and its one thread
//   POST /conversation/project {convId, project: name|slug|null}
//                                          → {ok, project: slug|null}
// and the agent's OpenProject (openProject below): Carl asked, in so many words, to
// start a project or to work on one — the same create-or-attach, then his screens
// and a live call follow to its thread.
// The layout and the create-or-attach rule are CONTEXT's
// (server/context/projects.ts); the tag is a record in the conversation's log.
import { configureContext, ctxConfig, withVault } from "./context/config";
import { listProjects, ensureProject, findProject } from "./context/projects";
import { ensureProjectThread, patchMeta } from "./engine/convs";
import { MAIN_ID, MAIN_TITLE } from "../src/threads";
import { followVoice } from "./voice";
import { masterDir, newMasterProject } from "./master";
import { checkFolder, newProjectFolder, projectFolderOf, registerFolder, unregisterFolder } from "./projectFolders";

function ready(vault: string): void {
  let v = "";
  try {
    v = ctxConfig().vault;
  } catch {
    /* not configured yet */
  }
  if (!v) configureContext({ vault });
}

/** The vault's projects, by name; `folder`: the folder on the box Carl chose for one (server/projectFolders.ts). */
export function projectsList(vault: string): { projects: { slug: string; name: string; folder?: string }[] } {
  ready(vault);
  return withVault(vault, () => ({
    projects: listProjects().map((p) => {
      const f = projectFolderOf(vault, p.slug);
      return { slug: p.slug, name: p.name, ...(f && "abs" in f ? { folder: f.abs.split("\\").join("/") } : {}) };
    }),
  }));
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
 * Carl's "+ New project": the project (create-or-attach by name) and its one thread (src/threads.ts).
 * `folder`: a folder on the box he chose for it to work in (checked first: server/projectFolders.ts), or
 * `newFolder: true` for a new folder (<vault-chat folder>/projects/<slug>, else ~/projects/<slug>); neither: no folder of its own (the vault, as before).
 */
export async function createProjectWithThread(
  vault: string,
  body: { name?: unknown; folder?: unknown; newFolder?: unknown },
): Promise<{ ok: true; slug: string; name: string; convId: string; created: boolean; folder?: string } | { error: string }> {
  ready(vault);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "name required" };
  const want = typeof body.folder === "string" && body.folder.trim() ? body.folder.trim() : null;
  // The folder is checked before anything is made: a refused one makes no project.
  if (want) {
    const c = checkFolder(vault, want);
    if ("error" in c) return { error: c.error };
  }
  try {
    const { project, created } = withVault(vault, () => ensureProject(name));
    let folder: string | undefined;
    if (want || body.newFolder === true) {
      // A new folder: <vault-chat folder>/projects/<slug> when the box has one (a git repo, synced with the laptop),
      // else ~/projects/<slug> as before.
      const r = want ? registerFolder(vault, project.slug, want) : masterDir() ? await newMasterProject(project.slug) : newProjectFolder(vault, project.slug);
      if ("error" in r) return { error: r.error };
      if (!want) registerFolder(vault, project.slug, r.abs);
      folder = r.abs.split("\\").join("/");
    } else if (created) unregisterFolder(vault, project.slug);
    // A new folder: a new thread even where a deleted project of that name had one (RestoreProject brings that back).
    const conv = await ensureProjectThread(vault, project.slug, project.name, { fresh: created });
    return { ok: true, slug: project.slug, name: project.name, convId: conv.id, created, ...(folder ? { folder } : {}) };
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) };
  }
}

export type OpenProjectDeps = {
  /** A signal on the vault's feed (/poll): {type:"follow", convId, title, project}; the laptop and the phone open that thread. */
  emit?: (ev: Record<string, unknown>) => void;
  /** The engine's /message: Carl's request goes to the thread, and the work runs there. */
  message?: (b: { convId: string; text: string; context?: string; queue?: boolean; source?: string }) => Promise<Record<string, unknown> | null>;
};

export const OPEN_PROJECT_DESCRIPTION =
  `Only when Carl asks, in so many words, spoken or typed: "start a project for HW4" (create: true) or "let's work on project Physics" / "back to Main" (project: "main"). Never on your own initiative and never as a suggestion you then act on. ` +
  "There is one of you: a project's thread is a place you work, and Main is home. This makes the project when he asked to start one (create-or-attach by name: its folder agent-projects/<slug>/ with project.md, and its one thread), finds it otherwise, and takes his screens and a live voice call to its thread: what he says or types next arrives there. " +
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
  let convId: string;
  let title: string;
  let slug: string | null = null;
  let created = false;
  try {
    if (/^main$/i.test(want)) {
      convId = MAIN_ID;
      title = MAIN_TITLE;
    } else if (args.create === true) {
      const r = await createProjectWithThread(vault, { name: want });
      if ("error" in r) return { ok: false, text: `The project was not made: ${r.error}.` };
      ({ convId, slug, created } = r);
      title = r.name;
    } else {
      ready(vault);
      const found = withVault(vault, () => findProject(want));
      if (!found) {
        const names = withVault(vault, () => listProjects().map((p) => p.name));
        return {
          ok: false,
          text: `Carl has no project "${want}" (${names.length ? `his projects: ${names.join(", ")}` : "he has none yet"}). Nothing changed. If he asked to start it, call OpenProject again with create: true; otherwise ask him which one he means.`,
        };
      }
      convId = (await ensureProjectThread(vault, found.slug, found.name)).id;
      slug = found.slug;
      title = found.name;
    }
  } catch (e) {
    return { ok: false, text: `OpenProject failed: ${(e as Error)?.message ?? String(e)}. Nothing changed.` };
  }
  // The surfaces follow: the laptop and the phone open the thread; a live call's lines, tools and updates go there.
  d.emit?.({ type: "follow", convId, title, ...(slug ? { project: slug } : {}), ...(created ? { created: true } : {}) });
  const call = followVoice(vault, convId);
  let handed = "";
  if (request && d.message) {
    const out = await d.message({ convId, text: request, queue: true, context: `[Carl asked for this and you moved to ${slug ? `the thread of his project "${title}"` : "Main"} to do it (OpenProject). Do it here.]` });
    handed = out && !out.error ? " His request went to that thread, which is doing it now: don't do it here too." : ` His request did not reach that thread (${String(out?.error ?? "no answer")}): do it there with him.`;
  }
  const where = slug ? `${created ? "Started" : "Opened"} project ${title} (agent-projects/${slug}/project.md); its thread is ${convId}` : "Back in Main";
  return { ok: true, convId, text: `${where}. His screens${call ? " and the live call" : ""} are there now; what he says next arrives there.${handed}` };
}
