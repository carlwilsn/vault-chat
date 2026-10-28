// The vault-chat folder (src/master.ts; the box's server/master.ts). Box mode. This laptop's folder is
// /home/carl/vc with vaults school2 and physics and the project vault-chat; the box's folder has those plus
// summer-demo and the project lecture-tools. At launch the laptop brings in lecture-tools (made from the box's hub) but
// not summer-demo: it already syncs from ~/vaults/summer-demo, and two copies would both write `master` (its
// migration, Copy into the folder, brings it in).
// The titlebar's vault name opens the picker: the vaults in the folder, New vault, a folder elsewhere. Settings has
// the folder for this laptop and for the box, the repos in it, and "Copy summer-demo into the folder" (the open
// vault is still outside it). "+ New project" offers a new folder in the box's vault-chat folder (synced).
import type { BuildCtx, Scenario, Step } from "./types";
import * as P3 from "./phase3";

const BOX = { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo", name: "thinkbox" };
const LAPTOP_MASTER = "/home/carl/vc";
const GH = "https://github.com/carlwilsn/vault-chat.git";

const boxMaster = {
  master: "/home/carl/vc",
  suggested: "/home/carl/vc",
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
      "Box mode. Click the vault name in the titlebar: the vaults in /home/carl/vc (lecture-tools arrives from the box at launch; summer-demo does not, it syncs from ~/vaults), New vault, A folder elsewhere…. Settings → vault-chat folder: this laptop's and the box's folder, the repos in it, Copy summer-demo into the folder. + New project offers /home/carl/vc/projects/<name> on the box, synced.",
    build,
    host,
    open: [{ sleep: 1500 }],
  },
];

export { openSettings };
