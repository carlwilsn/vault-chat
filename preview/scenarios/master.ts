// The vault-chat folder (src/master.ts; the box's server/master.ts, VC_MASTER). Box mode. This laptop's folder is
// /home/carl/vc with vaults school2 and physics and the project vault-chat; the box's folder has those plus the
// project lecture-tools, which the laptop brings in at launch (made from the box's hub). The titlebar's vault name
// opens the picker: the vaults in the folder and New vault, nothing from elsewhere. Settings has this laptop's folder
// (the only setting; the box's is shown), the repos in it and whether each syncs. "+ New project" offers the vault or
// a new folder in projects/ (synced). (The preview's open vault is its fixture at ~/vaults/summer-demo.)
import type { BuildCtx, Scenario, Step } from "./types";
import * as P3 from "./phase3";

const BOX = { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo", name: "thinkbox" };
const LAPTOP_MASTER = "/home/carl/vc";
const GH = "https://github.com/carlwilsn/vault-chat.git";

const boxMaster = {
  master: "/home/carl/vc",
  vaults: ["physics", "school2", "summer-demo"].map((name) => ({ name, path: `/home/carl/vc/vaults/${name}` })),
  projects: [
    { name: "lecture-tools", path: "/home/carl/vc/projects/lecture-tools", branch: "main", origin: null, syncing: true, ok: true, error: null },
    { name: "vault-chat", path: "/home/carl/vc/projects/vault-chat", branch: "main", origin: GH, syncing: true, ok: true, error: null },
  ],
};

const host = () => ({
  sync: {
    box: BOX,
    boxes: { "https://thinkbox.tail0a1b2.ts.net": { name: "thinkbox", version: "0.7.8", online: true, keys: {}, vaults: ["summer-demo", "school2", "physics"] } },
    boxChat: {
      convs: {
        main: { title: "Main", source: "main", meta: { kind: "main" }, messages: [{ role: "user", content: "morning" }, { role: "assistant", content: "Morning! What are we working on?" }] },
      },
      master: boxMaster,
      live: true,
    },
  },
});

function build(ctx: BuildCtx): void {
  P3.build(ctx);
  // This laptop's folder, beside the open vault (/home/carl/vaults/summer-demo).
  const up = "../../vc";
  ctx.write(`${up}/.vault-chat-master.json`, JSON.stringify({ box: BOX.box, name: "thinkbox", projects: { "vault-chat": { branch: "main", origin: GH } } }, null, 2) + "\n");
  ctx.write(`${up}/vaults/school2/README.md`, "# school2\n");
  ctx.write(`${up}/vaults/physics/README.md`, "# physics\n");
  ctx.write(`${up}/projects/vault-chat/README.md`, "# vault-chat\n");
  ctx.ls["vault_chat_master_path"] = LAPTOP_MASTER;
}

const openSettings: Step = { click: "[title='Settings']" };

export const masterScenarios: Scenario[] = [
  {
    id: "master-folder",
    title: "The vault-chat folder — the vault picker, Settings, + New project",
    group: "Projects",
    clock: "2026-10-27T10:00:00",
    notes:
      "Box mode. Click the vault name in the titlebar: the vaults in /home/carl/vc and New vault (nothing from elsewhere). Settings → vault-chat folder: this laptop's folder (the box's is only shown), the repos in it (lecture-tools arrived from the box at launch). + New project: the vault, or /home/carl/vc/projects/<name> on the box, synced.",
    build,
    host,
    open: [{ sleep: 1500 }],
  },
  // [final-model] Carl's final folder model (2026-10-29) against a REAL box: start preview/tools/finalModelBox.ts (the
  // real server bundle on a migrated copy of a live-shaped vault-chat folder), then the dev server with
  // VC_REALBOX=<its base>. This laptop's folder mirrors the box's: vaults school2 (IEMS 469 inside it) and vault-chat,
  // and the repo projects/vault-chat. The titlebar's folder name opens the picker: Vaults and Projects.
  {
    id: "folders-final",
    title: "Everything is a folder: the picker's Vaults and Projects, ⋯ Rename / Delete / Make this a project (real box)",
    group: "Projects",
    notes:
      "Start preview/tools/finalModelBox.ts, then the dev server with VC_REALBOX=<its base>. The folder picker: Vaults (every folder; IEMS 469 shows where it is) and Projects (folders with a conversation). Picking a vault opens it and the chat stays as it is; picking a project opens its folder and its thread.",
    clock: new Date().toISOString(),
    build: (ctx: BuildCtx) => {
      const up = "../../vc";
      ctx.write(`${up}/.vault-chat-master.json`, JSON.stringify({ box: "http://realbox.localhost", name: "box" }, null, 2) + "\n");
      ctx.write(`${up}/vaults/school2/README.md`, "# school2\n");
      ctx.write(`${up}/vaults/school2/IEMS 469/course-notes.html`, "<html><body><h1>IEMS 469</h1></body></html>\n");
      ctx.write(`${up}/vaults/school2/IEMS 469/lectures/lecture-07.md`, "# Lecture 7: value iteration\n");
      ctx.write(`${up}/vaults/school2/Psych 221/essay.md`, "# Essay draft\n\nOn memory.\n");
      ctx.write(`${up}/vaults/school2/Physics 135/ps5.md`, "# Problem set 5\n");
      ctx.write(`${up}/vaults/physics/ps6.md`, "# Problem set 6\n");
      ctx.write(`${up}/vaults/vault-chat/reports/QUEUE.md`, "# Queue\n\n1. the folder model\n");
      ctx.write(`${up}/projects/vault-chat/AGENTS.md`, "# vault-chat\n\nThe rules for the agent that builds vault-chat.\n");
      ctx.write(`${up}/projects/vault-chat/src/main.tsx`, "export {};\n");
      ctx.ls["vault_chat_master_path"] = LAPTOP_MASTER;
    },
    host: () => ({ sync: { box: { box: "http://realbox.localhost", vault: "school2" }, boxPerVault: true, reports: [{ configured: true, ok: true, message: "ok" }] } as any }),
    surfaces: ["desktop"],
    open: [{ sleep: 1500 }],
  },
];

export { openSettings };
