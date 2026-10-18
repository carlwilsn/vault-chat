// Projects on the desktop: the project chip in the chat, "New chat in project"
// and the chat list grouped by project.
//
// A project is a plain grouping: a folder `<vault>/agent-projects/<slug>/`
// (src/agentProjects.ts names it; server/context/projects.ts reads it) whose
// project.md is the project's shared notes, hidden from the file tree by
// default; a conversation carries the slug in its `project` meta field. Only
// Carl makes projects and moves chats (this chip, the chats list): no agent
// tool does. In box mode the box authors every conversation, so the
// list and the tagging go to the box (`GET /projects`,
// `POST /conversation/project`); otherwise they are read and written here.
import { invoke } from "@tauri-apps/api/core";
import { useStore, type FileEntry } from "./store";
import { boxLinkFor, boxGet, boxPost } from "./boxChat";
import { PROJECTS_DIR } from "./agentProjects";

export type Prepared = { moved: string[]; kept: string[]; hidden: boolean };

const prepared = new Map<string, Promise<Prepared | null>>();

/**
 * Once per vault per session (vault open): move projects from the old place
 * (`.vault-chat/projects/`) to `agent-projects/` and hide that folder the first
 * time it exists (lib.rs prepare_agent_projects). The box does the same to its
 * copy; the moves are identical, so the sync merges them. Never throws.
 */
export function prepareVaultProjects(vault: string): Promise<Prepared | null> {
  let p = prepared.get(vault);
  if (!p) {
    p = runPrepare(vault);
    prepared.set(vault, p);
  }
  return p;
}

async function runPrepare(vault: string): Promise<Prepared | null> {
  try {
    const r = await invoke<Prepared>("prepare_agent_projects", { vault });
    if (r.moved.length) console.info(`[projects] moved .vault-chat/projects/ → ${PROJECTS_DIR}/: ${r.moved.join(", ")}`);
    if (r.kept.length) console.warn(`[projects] left in .vault-chat/projects/ (a different file is already in ${PROJECTS_DIR}/): ${r.kept.join(", ")}`);
    // The open vault's tree: the folder appeared, or was just hidden.
    if ((r.moved.length || r.hidden) && useStore.getState().vaultPath === vault) {
      useStore.getState().setFiles(await invoke<FileEntry[]>("list_markdown_files", { vault }));
    }
    return r;
  } catch (e) {
    console.warn(`[projects] preparing ${vault}: ${String(e)}`);
    return null;
  }
}

export type ProjectInfo = { slug: string; name: string };

/** The same slug rule as server/context/files.ts. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** "bitnet-160m" → "Bitnet 160m" when the project file has no heading. */
export function nameFromSlug(slug: string): string {
  const s = slug.replace(/-/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : slug;
}

// A project named in a chat that hasn't reached the box yet: the box creates
// it with the first message, so the name as typed travels with that message
// (the slug alone would lose "BitNet 160M" to "bitnet-160m").
const pendingNames = new Map<string, string>();

/** What to send as `project` with a first message: the typed name if the
 *  project is still to be made, else the slug. */
export function projectForSend(slug: string): string {
  return pendingNames.get(slug) ?? slug;
}

/** The display name for a conversation's project slug. */
export function projectName(slug: string | undefined, list: ProjectInfo[]): string {
  if (!slug) return "";
  return list.find((p) => p.slug === slug)?.name ?? pendingNames.get(slug) ?? nameFromSlug(slug);
}

const HEADING = /^#\s+(.+?)\s*$/m;

async function listLocal(vault: string): Promise<ProjectInfo[]> {
  let files: string[] = [];
  try {
    files = await invoke<string[]>("glob_files", { pattern: `${PROJECTS_DIR}/*/project.md`, cwd: vault });
  } catch {
    return [];
  }
  const out: ProjectInfo[] = [];
  for (const f of files) {
    const parts = f.replace(/\\/g, "/").split("/");
    const slug = parts[parts.length - 2] ?? "";
    if (!slug || slug !== slugify(slug)) continue;
    let name = nameFromSlug(slug);
    try {
      const m = HEADING.exec(await invoke<string>("read_text_file", { path: f }));
      if (m) name = m[1]!;
    } catch {
      /* heading is optional */
    }
    out.push({ slug, name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The vault's projects (box mode: the box's list). */
export async function listProjects(vault: string | null): Promise<ProjectInfo[]> {
  if (!vault) return [];
  await prepareVaultProjects(vault);
  const link = await boxLinkFor(vault);
  if (link) {
    try {
      const d = await boxGet(link, "/projects");
      return Array.isArray(d?.projects) ? (d.projects as ProjectInfo[]) : [];
    } catch {
      return [];
    }
  }
  return listLocal(vault);
}

/** A new project (Carl's action in the app): its folder and project.md, which names it and holds the
 *  project's shared notes — the same file server/context creates. */
async function createLocal(vault: string, name: string): Promise<ProjectInfo> {
  const slug = slugify(name);
  if (!slug) throw new Error(`"${name}" does not make a project name`);
  const dir = `${vault}/${PROJECTS_DIR}/${slug}`;
  const title = name.trim();
  await invoke("create_dir", { path: dir }).catch(() => {});
  const p = `${dir}/project.md`;
  const exists = await invoke<boolean>("path_exists", { path: p }).catch(() => false);
  if (!exists) await invoke("write_text_file", { path: p, contents: `# ${title}\n` });
  // The vault's first project: hide agent-projects/ (once).
  await runPrepare(vault);
  return { slug, name: title };
}

// The chat popout shows the main window's chats list, so it hands project
// changes to main (sync.ts installs this there) instead of writing its own.
let toMain: ((convId: string, nameOrSlug: string | null) => void) | null = null;
export function routeProjectChangesTo(fn: (convId: string, nameOrSlug: string | null) => void): void {
  toMain = fn;
}

/**
 * Tag a conversation with a project (create-or-attach by name or slug), or
 * clear it with null. Returns the slug set, or an error message.
 */
export async function setConversationProject(
  convId: string,
  nameOrSlug: string | null,
  known: ProjectInfo[],
): Promise<{ ok: true; slug: string | null } | { ok: false; error: string }> {
  const s = useStore.getState();
  const vault = s.vaultPath;
  if (!vault) return { ok: false, error: "no vault" };
  const want = nameOrSlug?.trim() || null;
  const conv = s.conversations.find((c) => c.id === convId);
  const onBox = !!conv?.messages.some((m) => !m.boxPending) || !!conv?.threadId;
  const link = await boxLinkFor(vault);

  let slug: string | null = null;
  if (want) {
    const hit = known.find((p) => p.slug === slugify(want) || p.name.toLowerCase() === want.toLowerCase());
    slug = hit?.slug ?? slugify(want);
    if (!slug) return { ok: false, error: `"${want}" does not make a project name` };
  }
  if (toMain) {
    toMain(convId, want);
    return { ok: true, slug };
  }

  if (link && onBox) {
    // The box authors the conversation: it tags it (and creates the project).
    const r = await boxPost(link, "/conversation/project", { convId, project: want });
    if (!r.ok) return { ok: false, error: r.error ?? "the box refused" };
    slug = typeof r.data?.project === "string" ? r.data.project : null;
  } else if (want && !known.some((p) => p.slug === slug)) {
    // A new project. On the box it is created with the first message
    // (`/message {project}`); here the files are written now.
    if (link) pendingNames.set(slug!, want);
    else {
      try {
        slug = (await createLocal(vault, want)).slug;
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message ?? e) };
      }
    }
  }

  useStore.setState((st) => ({
    conversations: st.conversations.map((c) => (c.id === convId ? { ...c, project: slug ?? undefined } : c)),
  }));
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new CustomEvent("vc-projects-changed"));
  return { ok: true, slug };
}

/** A fresh chat already tagged with `slug`. */
export function newChatInProject(slug: string): string {
  const id = useStore.getState().newConversation();
  if (toMain) {
    toMain(id, slug);
    return id;
  }
  useStore.setState((st) => ({
    conversations: st.conversations.map((c) => (c.id === id ? { ...c, project: slug } : c)),
  }));
  return id;
}
