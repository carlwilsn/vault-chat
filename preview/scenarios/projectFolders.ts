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
];

// "You keep it" (server/projectChanges.ts): Vault Chat is a git repo, so its agent works on a branch in its own
// clone and hands the change over with a proof card — what changed, why, the tests, a screenshot — and two
// actions, Keep and Send back. The thread waits for Carl's answer.
const REVIEW_ARGS = {
  title: "Bigger tap targets on the phone",
  branch: "agent/bigger-tap-targets",
  what: "The phone's thread rows and the composer's send button are 44 px tall (they were 32 px).",
  why: "You asked for the rows to be easier to hit with a thumb.",
  tests: "npm run test:harness  → 405 passed, 0 failed\nnpm run test:server   → 541 passed, 0 failed\ntsc ×4                → clean",
  images: ["proof/phone-after.svg"],
};
const PROOF_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="260" viewBox="0 0 390 260"><rect width="390" height="260" rx="14" fill="#1f2023"/>' +
  [0, 1, 2, 3].map((i) => `<rect x="16" y="${20 + i * 56}" width="358" height="44" rx="10" fill="#2c2d31"/><text x="32" y="${48 + i * 56}" fill="#e6e6e6" font-family="Inter,Arial" font-size="15">${["Main", "Vault Chat", "Psych 221", "Lecture Tools"][i]}</text>`).join("") +
  "</svg>";

export const projectReviewScenarios: Scenario[] = [
  {
    id: "project-review",
    title: "You keep it — a git project's change handed over with its proof: Keep or Send back",
    group: "Projects",
    clock: "2026-10-27T10:00:00",
    notes:
      "Box mode, Vault Chat's thread (a git repo). The agent made the change on agent/bigger-tap-targets in its own clone and handed it over: the proof card says what changed, why, the test results and shows the screenshot, with Keep (the box merges the branch into main and pushes) and Send back (type what to change; it goes on with the same branch). Nothing reaches main without Keep.",
    build: (c) => {
      P3.build(c);
      c.write(".vault-chat/proof/call_rr1/1-phone-after.svg", PROOF_SVG);
    },
    host: () => {
      const h = host();
      h.sync.boxChat.convs["project-vault-chat"].messages = [{ role: "user", content: "Make the phone's rows easier to tap." }, { role: "assistant", content: "On it — I'll make the change on a branch in my clone and hand it over with the proof." }];
      return {
        ...h,
        sync: {
          ...h.sync,
          boxChat: {
            ...h.sync.boxChat,
            steps: [
              {
                log: (b: any) => {
                  b.startTurn("project-vault-chat");
                  b.tool("project-vault-chat", "call_rr1", "ReadyForReview", REVIEW_ARGS);
                  b.emit("project-vault-chat", { type: "meta", patch: { asking: { question: "Ready to keep: Bigger tap targets on the phone", options: ["Keep", "Send back"], at: Date.now() }, state: "waiting_user" } });
                },
              },
            ],
          },
        },
      };
    },
    open: [{ conversation: "project-vault-chat" }, { run: () => (window as any).__preview?.boxNext?.() }, { sleep: 900 }],
  },
];

/** The phone: the same card in Vault Chat's thread, folded from the open call by the same view as the laptop
 *  folds the call with the same view, src/convlog/view.ts, which test/harness/reviewCard.test.ts checks). */
function phoneReviewDb(db: any, now: number): void {

  const id = "project-vault-chat";
  const messages = [
    { role: "user", content: "Make the phone's rows easier to tap." },
    { role: "assistant", content: "On it — I'll make the change on a branch in my clone and hand it over with the proof.", tools: ["bash", "edit", "bash"] },
    // The hand-over as pi records it: the open ReadyForReview call, which the phone folds into the card with the same view as the laptop.
    { role: "assistant", content: "", toolCalls: [{ id: "call_rr1", name: "ReadyForReview", input: REVIEW_ARGS }] },
  ];
  db.convs = [{ id, title: "Vault Chat", source: "project", kind: "project", project: "vault-chat", role: "", lastActivityAt: now - 60_000, msgCount: 3, preview: "Ready to keep: Bigger tap targets on the phone", goal: "" }, ...db.convs];
  db.threads[id] = { id, title: "Vault Chat", source: "project", kind: "project", project: "vault-chat", status: "idle", state: "waiting_user", messages };
  db.projects = [{ slug: "vault-chat", name: "Vault Chat" }, ...(db.projects ?? [])];
}

projectReviewScenarios.push({
  id: "project-review-phone",
  title: "You keep it — the proof card on the phone: Keep or Send back",
  group: "Projects",
  clock: "2026-10-27T10:00:00",
  notes: "The phone: Vault Chat's thread with the agent's hand-over — what changed, why, the tests, the screenshot — and Keep / Send back, the same card as the laptop's.",
  build: (c) => {
    P3.build(c);
    c.write(".vault-chat/proof/call_rr1/1-phone-after.svg", PROOF_SVG);
  },
  surfaces: ["phone"],
  phone: { clicks: ["#convBtn", "?text:Vault Chat"], db: phoneReviewDb },
} as Scenario);
