// The projects home: where every project lives, whatever vault is open (Carl, 2026-10-28: "a vault is my UI
// thing, projects are general machine path stuff"; "projects belong to vaults? I thought we decoupled them").
//
//   <home>/<slug>/project.md          the project: its name (first `# ` heading), Carl's instructions, then the
//                                     project's memory under `## Memory` (the agent keeps it); rules.md optional
//   <home>/.deleted/<slug>-<stamp>/   a deleted project (Carl's Delete; RestoreProject brings it back)
//   <home>/.vault-chat/events/        the projects' conversation log: every project's one thread
//   <home>/.vault-chat/sessions/      their pi sessions
//   <home>/.vault-chat/local/         the server's own state: the folder registry (project-folders.json)
//
// A project's working folder is its own (<vault-chat folder>/projects/<name>, or a folder Carl chose anywhere on
// the box; pi loads its AGENTS.md); the home holds what is about the project and the conversation, never the
// project's files. Every vault's feed shows the projects' log (server/convlog/log.ts RoutedLog), and their threads
// run on the box's home engine (server/engine/index.ts), so the list and every thread are the same on the laptop,
// the phone and the board, whatever vault is open. Main stays the vault's own conversation.
//
// Where: VC_PROJECTS_HOME, else <vault-chat folder>/.projects (server/master.ts), else ~/.local/share/vault-chat/projects
// (never under the server's state: the agent writes a project's memory, and the state is read-only to it).
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { masterDir } from "./master";

export const PROJECTS_HOME_DIR = ".projects";

/** This box's projects home, as configured now (none set: the master's, else the state's). */
export function resolveProjectsHome(env: NodeJS.ProcessEnv = process.env): string {
  const e = env.VC_PROJECTS_HOME?.trim();
  if (e) return resolve(e);
  const m = masterDir();
  if (m) return join(m, PROJECTS_HOME_DIR);
  return join(env.HOME || env.USERPROFILE || homedir(), ".local", "share", "vault-chat", "projects");
}

export type HomeLayout = { home: string; events: string; sessions: string; local: string; deleted: string; registry: string };

export function homeLayout(home: string): HomeLayout {
  const h = resolve(home);
  return {
    home: h,
    events: join(h, ".vault-chat", "events"),
    sessions: join(h, ".vault-chat", "sessions"),
    local: join(h, ".vault-chat", "local"),
    deleted: join(h, ".deleted"),
    registry: join(h, ".vault-chat", "local", "project-folders.json"),
  };
}

/** Its folders, made (the sandbox binds them; they must exist). */
export function ensureHome(home: string): HomeLayout {
  const l = homeLayout(home);
  for (const d of [l.home, l.events, l.sessions, l.local]) mkdirSync(d, { recursive: true });
  return l;
}
