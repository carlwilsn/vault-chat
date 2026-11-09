// Projects that work in a folder on the box (server/projectFolders.ts; Carl, 2026-10-27: "a vault is my UI
// thing, projects are general machine-path stuff"). Box mode. The left panel: Main, then the projects —
// "Vault Chat" works in ~/github/vault-chat on the box. "+ New project" asks where it works: the vault, a new
// ~/projects/<name>, or a folder on the box (the chooser browses the box's folders). In Vault Chat's thread the
// file tree has two tabs: that folder, read live from the box, and the vault; a file opens from the box and an
// edit is written back there.
import type { Scenario, Step } from "./types";
import * as P3 from "./phase3";


const BOX = { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" };
const FOLDER = "/home/carl/github/vault-chat";

const host = () => ({
  sync: {
    box: BOX,
    boxChat: {
      convs: {
        main: { title: "Main", source: "main", meta: { kind: "main" }, messages: [{ role: "user", content: "morning" }, { role: "assistant", content: "Morning! What are we working on?" }] },
        "project-vault-chat": {
          title: "Vault Chat",
          source: "project",
          meta: { kind: "project", project: "vault-chat" },
          messages: [
            { role: "user", content: "What does this repo's AGENTS.md ask of you?" },
            { role: "assistant", content: "To run the gates — tsc ×4, test:harness, test:server, build:server — before I push. I'm working in ~/github/vault-chat." },
          ],
        },
        "project-psych-221": { title: "Psych 221", source: "project", meta: { kind: "project", project: "psych-221" }, messages: [] },
      },
      projectFolders: { "vault-chat": FOLDER },
      live: true,
    },
  },
});

// psych-221 with 14 chats: the panel shows 5 and a quiet "Show more", then 10 and "Show all", then all.
const manyChats = () => {
  const convs: Record<string, unknown> = {
    main: { title: "Main", source: "main", meta: { kind: "main" }, messages: [{ role: "user", content: "morning" }, { role: "assistant", content: "Morning!" }] },
    "project-psych-221": { title: "Psych 221", source: "project", meta: { kind: "project", project: "psych-221" }, messages: [] },
  };
  for (let i = 1; i <= 14; i++)
    convs[`psych-chat-${i}`] = {
      title: `Psych question ${i}`,
      source: "manual",
      meta: { kind: "separate", project: "psych-221", lastActivityAt: Date.parse("2026-10-27T09:00:00") - i * 3_600_000 },
      messages: [{ role: "user", content: `Question ${i}` }, { role: "assistant", content: `Answer ${i}` }],
    };
  return { sync: { box: BOX, boxChat: { convs, live: true } } };
};

const openPanel: Step = { click: "[title^='Chats —']" };

export const projectFolderScenarios: Scenario[] = [
  {
    id: "project-folder-tree",
    title: "A project's folder on the box — its file tree in its thread",
    group: "Projects",
    clock: "2026-10-27T10:00:00",
    notes:
      "Box mode. Vault Chat works in ~/github/vault-chat on the box. Its thread is open: the file tree has two tabs, Vault Chat (that folder, read live from the box: src/, server/, AGENTS.md …) and Vault. Click README.md: it opens from the box; edit it and the edit is written back to the box (fakeBoxDisk). Main and Psych 221 (a vault project) show the vault's tree as before.",
    build: P3.build,
    host,
    open: [{ conversation: "project-vault-chat" }, { sleep: 800 }],
  },
  {
    id: "project-folder-new",
    title: "+ New project — where it works: the vault, ~/projects/<name>, or a folder on the box",
    group: "Projects",
    clock: "2026-10-27T10:00:00",
    notes:
      "Box mode. Open the left panel and click + New project: name it, then choose where it works — the vault (as before), a new ~/projects/<name>, or A folder on the box…, which browses the box's folders from the home (Use this folder is off where a folder can't be a project's: the home itself). Create makes the project and opens its thread.",
    build: P3.build,
    host,
    open: [openPanel, { sleep: 500 }],
  },
  {
    id: "chats-many",
    title: "Chat list — a project with 14 chats: Show more, then Show all",
    group: "Projects",
    clock: "2026-10-27T10:00:00",
    notes:
      "Box mode. Psych 221 holds 14 chats. Its list shows the 5 newest and a quiet “Show more”; that reveals 5 more (10), then the row says “Show all” and reveals the rest. 5 or fewer chats: no row; 10 or fewer: one step. The open chat and any chat working or unseen always stay visible. Resets on reload.",
    build: P3.build,
    host: manyChats,
    open: [openPanel, { sleep: 500 }],
  },
];
