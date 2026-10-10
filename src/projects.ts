// Projects on the desktop: the project chip in the chat, "New chat in project"
// and the chat list grouped by project.
//
// A project is memory in `<vault>/.vault-chat/projects/<slug>/` (the layout
// server/context/projects.ts owns); a conversation carries the slug in its
// `project` meta field. In box mode the box authors every conversation, so the
// list and the tagging go to the box (`GET /projects`,
// `POST /conversation/project`); otherwise they are read and written here.
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { boxLinkFor, boxGet, boxPost } from "./boxChat";

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

/** The display name for a conversation's project slug. */
export function projectName(slug: string | undefined, list: ProjectInfo[]): string {
  if (!slug) return "";
  return list.find((p) => p.slug === slug)?.name ?? nameFromSlug(slug);
}

const HEADING = /^#\s+(.+?)\s*$/m;

async function listLocal(vault: string): Promise<ProjectInfo[]> {
  let files: string[] = [];
  try {
    files = await invoke<string[]>("glob_files", { pattern: ".vault-chat/projects/*/project.md", cwd: vault });
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

/** Seed files for a new project — the same set server/context creates. */
async function createLocal(vault: string, name: string): Promise<ProjectInfo> {
  const slug = slugify(name);
  if (!slug) throw new Error(`"${name}" does not make a project name`);
  const dir = `${vault}/.vault-chat/projects/${slug}`;
  const title = name.trim();
  const seed: Record<string, string> = {
    "project.md": `# ${title}\n\n## What\n\n(not written yet)\n\n## Why\n\n(not written yet)\n\n## Done when\n\n(not decided yet)\n\n## Status\n\nstarted ${new Date().toISOString().slice(0, 10)}\n`,
    "memory.md": `# Memory: ${title}\n\n## Decisions\n\n## Tried and learned\n\n## Conventions\n`,
    "plan.md": `# Plan: ${title}\n\n(no plan yet)\n`,
    "progress.md": `# Progress: ${title}\n`,
  };
  await invoke("create_dir", { path: dir }).catch(() => {});
  for (const [file, body] of Object.entries(seed)) {
    const p = `${dir}/${file}`;
    const exists = await invoke<boolean>("path_exists", { path: p }).catch(() => false);
    if (!exists) await invoke("write_text_file", { path: p, contents: body });
  }
  return { slug, name: title };
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

  if (link && onBox) {
    // The box authors the conversation: it tags it (and creates the project).
    const r = await boxPost(link, "/conversation/project", { convId, project: want });
    if (!r.ok) return { ok: false, error: r.error ?? "the box refused" };
    slug = typeof r.data?.project === "string" ? r.data.project : null;
  } else if (want && !known.some((p) => p.slug === slug)) {
    // A new project. On the box it is created with the first message
    // (`/message {project}`); here the files are written now.
    if (!link) {
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
  window.dispatchEvent(new CustomEvent("vc-projects-changed"));
  return { ok: true, slug };
}

/** A fresh chat already tagged with `slug`. */
export function newChatInProject(slug: string): string {
  const id = useStore.getState().newConversation();
  useStore.setState((st) => ({
    conversations: st.conversations.map((c) => (c.id === id ? { ...c, project: slug } : c)),
  }));
  return id;
}
