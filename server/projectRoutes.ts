// Projects for the clients (the desktop chip in box mode, the phone):
//   GET  /projects                         → {projects:[{slug,name}]}
//   POST /conversation/project {convId, project: name|slug|null}
//                                          → {ok, project: slug|null}
// The layout and the create-or-attach rule are CONTEXT's
// (server/context/projects.ts); the box authors every conversation, so the
// tag is a locked read-modify-write of that one conversation, mirrored into
// the headless store so its persist never writes the old value back.
import { configureContext, ctxConfig } from "./context/config";
import { listProjects, ensureProject } from "./context/projects";
import { useStore } from "../src/store";
import { readConversations, writeConversations, withConvLock } from "../src/conversations";

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
  return { projects: listProjects().map((p) => ({ slug: p.slug, name: p.name })) };
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
      slug = ensureProject(want).project.slug;
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) };
    }
  }
  const done = await withConvLock(async () => {
    const list = await readConversations(vault);
    const cur = list.find((c) => c.id === convId);
    if (!cur) return false;
    const next = { ...cur, project: slug ?? undefined };
    await writeConversations(vault, [next]);
    useStore.setState((s) => ({
      conversations: s.conversations.map((c) => (c.id === convId ? { ...c, project: slug ?? undefined } : c)),
    }));
    return true;
  });
  if (!done) return { error: "conversation not found" };
  return { ok: true, project: slug };
}
