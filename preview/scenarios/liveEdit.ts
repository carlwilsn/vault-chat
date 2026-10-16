// The agent's edit turns up in the open file live (box mode): the agent on
// the box edits the writeup Carl is reading; the box commits and publishes it
// and sends /poll "vault_changed"; the laptop syncs at once and the open note
// shows the new text in place — no refresh, the scroll where it was.
import type { Scenario, Step } from "./types";
import * as P3 from "./phase3";

const NOTE = "projects/bitnet-160m/writeup.md";
const BOX = { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" };
const ADDED = "Update (agent): the 3.2B-token rerun is queued for tonight.";

const edit = (old: string | null) =>
  (old ?? "").replace("## Setup", `${ADDED}\n\n## Setup`).replace("is stable across three seeds", "is stable across all three seeds");

/** Wait (up to `ms`) for `text` in the open note's rendered view; fail the step otherwise. */
const waitText = (text: string, ms = 4000): Step => ({
  run: async (api) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (api.qa(".prose-md").some((e) => (e.textContent ?? "").includes(text))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`live-edit: "${text}" did not appear in the open note within ${ms} ms`);
  },
});

export const liveEditScenarios: Scenario[] = [
  {
    id: "live-edit",
    title: "The agent's edit shows live in the open note (box mode)",
    group: "Files · live",
    clock: "2026-10-16T10:00:00",
    notes:
      "Box mode. Carl has the BitNet writeup open (view mode). The agent on the box edits it — one word in the summary and a new line above Setup. The box commits and publishes the edit and sends /poll “vault_changed”; the laptop runs a sync at once (not on its 15 s interval) and the merge reloads the open note in place, within a second or two: “Update (agent): the 3.2B-token rerun is queued for tonight.” appears, the scroll stays where it was. Before: the note kept the old text until it was reopened. With unsaved typing in the editor the buffer is never replaced: the header says “Changed by the agent — Reload · Keep mine”.",
    build: P3.build,
    host: () => ({
      sync: {
        box: BOX,
        boxChat: {
          convs: {},
          steps: [{ merge: { [NOTE]: edit }, events: [{ vault: BOX.vault, type: "vault_changed", paths: [NOTE] }] }],
        },
      },
    }),
    surfaces: ["desktop"],
    open: [
      { file: NOTE, mode: "view" },
      { sleep: 1500 },
      { run: () => (window as any).__preview?.boxNext?.() },
      waitText(ADDED),
      waitText("stable across all three seeds", 1000),
      { sleep: 800 },
    ],
  },
];
