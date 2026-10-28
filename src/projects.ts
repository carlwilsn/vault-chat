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
import { boxPathOf, readTextAt } from "./boxFiles";
import { PROJECTS_DIR } from "./agentProjects";
import { emptyConversation } from "./conversations";
import { MAIN_ID, MAIN_TITLE, projectOfThread, projectThreadId } from "./threads";

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

/** `folder`: the folder on the box the project works in (server/projectFolders.ts); `notes`: its project.md on the box
 *  (the projects home, server/projectsHome.ts: the machine's, the same whatever vault is open). */
export type ProjectInfo = { slug: string; name: string; folder?: string; notes?: string };

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

/**
 * Open a thread: Main, a project's one thread, or any chat. Shown at once (a placeholder until the box's row
 * arrives: the box makes Main and the project threads itself).
 */
export function openThread(id: string, title?: string): void {
  const s = useStore.getState();
  if (!s.conversations.some((c) => c.id === id)) {
    const slug = projectOfThread(id);
    const placeholder = { ...emptyConversation(), id, title: title ?? (id === MAIN_ID ? MAIN_TITLE : "New chat"), ...(id === MAIN_ID ? { kind: "main" } : slug ? { kind: "project", project: slug } : {}) };
    useStore.setState((st) => ({ conversations: [...st.conversations, placeholder] }));
  }
  useStore.getState().selectConversation(id);
}

/**
 * Carl's "+ New project": the project (its folder and project.md) and its one thread, then that thread open.
 * On the box (`POST /projects`) or, without one, the files here. Returns the thread's id, or an error.
 */
export async function createProjectThread(
  name: string,
  where: { folder?: string; newFolder?: boolean } = {},
): Promise<{ ok: true; id: string; slug: string } | { ok: false; error: string }> {
  const vault = useStore.getState().vaultPath;
  const want = name.trim();
  if (!vault || !want) return { ok: false, error: "no name" };
  const link = await boxLinkFor(vault);
  let slug: string;
  let title = want;
  if (!link && (where.folder || where.newFolder)) return { ok: false, error: "a folder on the box needs the box connected" };
  if (link) {
    // A folder on the box it works in (one Carl chose, or a new ~/projects/<slug>): the box checks it first.
    const r = await boxPost(link, "/projects", { name: want, ...(where.folder ? { folder: where.folder } : where.newFolder ? { newFolder: true } : {}) });
    if (!r.ok) return { ok: false, error: r.error ?? "the box refused" };
    slug = String(r.data?.slug ?? slugify(want));
    title = String(r.data?.name ?? want);
  } else {
    try {
      slug = (await createLocal(vault, want)).slug;
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) };
    }
  }
  const id = projectThreadId(slug);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new CustomEvent("vc-projects-changed"));
  openThread(id, title);
  return { ok: true, id, slug };
}

function projectsChanged(): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new CustomEvent("vc-projects-changed"));
}

/**
 * Carl's Delete on a project (the ⋯ menu, after its confirm): its thread and its own notes go (moved to
 * agent-projects/.deleted/, recoverable), the folder it names and the rest of his files stay. A screen on its
 * thread lands on Main. On the box, every surface follows (server: Engine.deleteProject).
 */
export async function deleteProject(slug: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const vault = useStore.getState().vaultPath;
  if (!vault || !slug) return { ok: false, error: "no project" };
  const id = projectThreadId(slug);
  const link = await boxLinkFor(vault);
  if (link) {
    const r = await boxPost(link, "/api/v2/intent", { type: "deleteProject", slug, client: "laptop" });
    if (!r.ok) return { ok: false, error: r.error ?? "the box refused" };
  } else {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    try {
      await invoke("create_dir", { path: `${vault}/${PROJECTS_DIR}/.deleted` }).catch(() => {});
      await invoke("rename_path", { from: `${vault}/${PROJECTS_DIR}/${slug}`, to: `${vault}/${PROJECTS_DIR}/.deleted/${slug}-${stamp}` });
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) };
    }
  }
  projectsChanged();
  if (useStore.getState().activeConversationId === id) openThread(MAIN_ID);
  return { ok: true };
}

/** Carl's Rename on a project: the name (project.md's first heading); its slug, folder and thread stay. */
export async function renameProject(slug: string, name: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const vault = useStore.getState().vaultPath;
  const want = name.trim().replace(/\s+/g, " ");
  if (!vault || !slug || !want) return { ok: false, error: "a project needs a name" };
  const link = await boxLinkFor(vault);
  let got = want;
  if (link) {
    const r = await boxPost(link, "/api/v2/intent", { type: "renameProject", slug, name: want, client: "laptop" });
    if (!r.ok) return { ok: false, error: r.error ?? "the box refused" };
    got = String(r.data?.name ?? want);
  } else {
    const p = `${vault}/${PROJECTS_DIR}/${slug}/project.md`;
    try {
      const text = await invoke<string>("read_text_file", { path: p }).catch(() => "");
      const next = /^#\s+.+$/m.test(text) ? text.replace(/^#\s+.+$/m, `# ${want}`) : `# ${want}\n${text ? `\n${text}` : ""}`;
      await invoke("write_text_file", { path: p, contents: next });
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) };
    }
  }
  const id = projectThreadId(slug);
  useStore.setState((st) => ({ conversations: st.conversations.map((c) => (c.id === id ? { ...c, title: got } : c)) }));
  projectsChanged();
  return { ok: true, name: got };
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

// The popout has no viewer: it hands "Project notes" to main (sync.ts installs this there).
let notesToMain: ((slug: string, name: string) => void) | null = null;
export function routeProjectNotesTo(fn: (slug: string, name: string) => void): void {
  notesToMain = fn;
}

/** A project's shared notes file, `<vault>/agent-projects/<slug>/project.md`. */
export function projectNotesPath(vault: string, slug: string): string {
  return `${vault}/${PROJECTS_DIR}/${slug}/project.md`;
}

/**
 * Open a project's project.md in the viewer (the folder is hidden from the
 * file tree, so this is the way to it), creating it with its heading first if
 * it is missing. Leaves fullscreen chat, which has no viewer. Returns the path.
 */
export async function openProjectNotes(slug: string, name: string): Promise<string | null> {
  if (notesToMain) {
    notesToMain(slug, name);
    return null;
  }
  if (slug === MEMORY_SLUG) return openMemory();
  const s = useStore.getState();
  const vault = s.vaultPath;
  if (!vault || !slug || slug !== slugify(slug)) return null;
  // On the box (box mode) a project's project.md is in the projects home, not in any vault: opened there.
  const link = await boxLinkFor(vault);
  if (link) {
    const d = await boxGet(link, "/projects").catch(() => null);
    const hit = (Array.isArray(d?.projects) ? (d.projects as ProjectInfo[]) : []).find((x) => x.slug === slug);
    if (!hit?.notes) return null;
    const bp = boxPathOf(hit.notes);
    const text = await readTextAt(bp);
    const st = useStore.getState();
    if (st.chatFullscreen) st.toggleChatFullscreen();
    st.setCurrentFile(bp, text);
    return bp;
  }
  const p = projectNotesPath(vault, slug);
  let content: string;
  const exists = await invoke<boolean>("path_exists", { path: p }).catch(() => false);
  if (exists) content = await invoke<string>("read_text_file", { path: p });
  else {
    await invoke("create_dir", { path: `${vault}/${PROJECTS_DIR}/${slug}` }).catch(() => {});
    content = `# ${name.trim() || nameFromSlug(slug)}\n`;
    await invoke("write_text_file", { path: p, contents: content });
  }
  const st = useStore.getState();
  if (st.chatFullscreen) st.toggleChatFullscreen();
  st.setCurrentFile(p, content);
  return p;
}

/** "Memory" for Main: the agent's global memory file, `.vault-chat/MEMORY.md` (server/context/memory.ts). */
export const MEMORY_REL = ".vault-chat/MEMORY.md";
/** openProjectNotes' name for the memory file (the popout hands it to main the same way). */
export const MEMORY_SLUG = "__memory__";

/** Open `.vault-chat/MEMORY.md` in the viewer (made with its heading when missing). Returns the path. */
export async function openMemory(): Promise<string | null> {
  if (notesToMain) {
    notesToMain(MEMORY_SLUG, "Memory");
    return null;
  }
  const s = useStore.getState();
  const vault = s.vaultPath;
  if (!vault) return null;
  const p = `${vault}/${MEMORY_REL}`;
  let content: string;
  const exists = await invoke<boolean>("path_exists", { path: p }).catch(() => false);
  if (exists) content = await invoke<string>("read_text_file", { path: p });
  else {
    await invoke("create_dir", { path: `${vault}/.vault-chat` }).catch(() => {});
    content = "# Memory\n\nWhat the agent keeps between conversations: one line per fact, dated. Edit or delete freely.\n";
    await invoke("write_text_file", { path: p, contents: content });
  }
  const st = useStore.getState();
  if (st.chatFullscreen) st.toggleChatFullscreen();
  st.setCurrentFile(p, content);
  return p;
}
