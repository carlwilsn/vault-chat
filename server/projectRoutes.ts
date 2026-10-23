// Projects for the clients (the desktop chip in box mode, the phone):
//   GET  /projects                         → {projects:[{slug,name}]}
//   POST /projects {name}                  → {ok, slug, name, convId}: a new project (Carl's "+ New project") and its one thread
//   POST /conversation/project {convId, project: name|slug|null}
//                                          → {ok, project: slug|null}
// The layout and the create-or-attach rule are CONTEXT's
// (server/context/projects.ts); the tag is a record in the conversation's log.
import { configureContext, ctxConfig, withVault } from "./context/config";
import { listProjects, ensureProject } from "./context/projects";
import { ensureProjectThread, patchMeta } from "./engine/convs";

function ready(vault: string): void {
  let v = "";
  try {
    v = ctxConfig().vault;
  } catch {
    /* not configured yet */
  }
  if (!v) configureContext({ vault });
}

/** The vault's projects, by name. */
export function projectsList(vault: string): { projects: { slug: string; name: string }[] } {
  ready(vault);
  return withVault(vault, () => ({ projects: listProjects().map((p) => ({ slug: p.slug, name: p.name })) }));
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

/** Carl's "+ New project": the project (create-or-attach by name) and its one thread (src/threads.ts). */
export async function createProjectWithThread(vault: string, body: { name?: unknown }): Promise<{ ok: true; slug: string; name: string; convId: string; created: boolean } | { error: string }> {
  ready(vault);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "name required" };
  try {
    const { project, created } = withVault(vault, () => ensureProject(name));
    const conv = await ensureProjectThread(vault, project.slug, project.name);
    return { ok: true, slug: project.slug, name: project.name, convId: conv.id, created };
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) };
  }
}
