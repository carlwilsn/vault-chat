// The agent's edit turns up in the open file live (box mode): the agent on
// the box edits the writeup Carl is reading; the box commits and publishes it
// and sends /poll "vault_changed"; the laptop syncs at once and the open note
// shows the new text in place — no refresh, the scroll where it was.
import type { Scenario, Step } from "./types";
import * as P3 from "./phase3";

const NOTE = "projects/bitnet-160m/writeup.md";
const DOG = "dog.svg";
const dog = (fur: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 160" width="400" height="320"><rect width="200" height="160" fill="#f4f1ea"/><ellipse cx="100" cy="105" rx="55" ry="35" fill="${fur}"/><circle cx="100" cy="60" r="32" fill="${fur}"/><ellipse cx="72" cy="58" rx="10" ry="22" fill="#8b5a2b"/><ellipse cx="128" cy="58" rx="10" ry="22" fill="#8b5a2b"/><circle cx="90" cy="55" r="4"/><circle cx="110" cy="55" r="4"/><ellipse cx="100" cy="70" rx="7" ry="5"/><rect x="80" y="86" width="40" height="7" rx="3" fill="#c62828"/></svg>`;

/** Does the image view show an SVG containing `text` (read from its blob URL), within `ms`? */
async function imgHas(text: string, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const img = document.querySelector<HTMLImageElement>("img[src^='blob:']");
    if (img?.src) {
      try {
        if ((await (await fetch(img.src)).text()).includes(text)) return true;
      } catch {
        /* revoked between the query and the read: try again */
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}
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
  {
    id: "live-edit-voice",
    title: "A voice edit on the box shows in the open image at once",
    group: "Files · live",
    clock: "2026-10-16T16:18:00",
    notes:
      "Box mode, voice: Carl has dog.svg open (a golden dog) and asks the voice agent to make it purple. The voice agent's Edit runs on the box; the box announces the write at once (/poll “file_changed”, before any commit), the laptop fetches the box's copy of dog.svg and redraws the image in place — purple within about a second. Nothing is written to the laptop's disk: the sync's merge lands the same file a little later and nothing flickers. Before: the image changed only when a 15–30 s sync cycle had merged it (about a minute after the agent said it was done).",
    build: (ctx) => {
      P3.build(ctx);
      ctx.write(DOG, dog("goldenrod"));
    },
    host: () => ({
      sync: {
        box: BOX,
        boxChat: {
          convs: {},
          steps: [
            // The voice route's Edit on the box: file_changed at once (server/liveEdits.ts).
            { merge: { [DOG]: (old) => (old ?? "").split("goldenrod").join("purple") }, events: [{ vault: BOX.vault, type: "file_changed", path: DOG }] },
            // A second later the box has committed and published it.
            { events: [{ vault: BOX.vault, type: "vault_changed", paths: [DOG] }] },
          ],
        },
      },
    }),
    surfaces: ["desktop"],
    open: [
      { file: DOG, mode: "view" },
      { sleep: 1500 },
      {
        run: async () => {
          const w = window as any;
          if (!(await imgHas("goldenrod", 3000))) throw new Error("live-edit-voice: the golden dog is not on screen");
          const t0 = performance.now();
          w.__preview?.boxNext?.();
          if (!(await imgHas("purple", 3000))) throw new Error("live-edit-voice: dog.svg did not turn purple within 3 s");
          const ms = Math.round(performance.now() - t0);
          w.__liveEditMs = ms;
          console.info(`[live-edit-voice] purple on screen ${ms} ms after the box's edit`);
          if (ms > 1500) throw new Error(`live-edit-voice: purple after ${ms} ms (want about 1 s)`);
        },
      },
      { sleep: 600 },
      {
        run: async () => {
          // The commit catches up: the merge brings the same bytes, the image stays purple.
          const img = document.querySelector<HTMLImageElement>("img[src^='blob:']");
          const src = img?.src;
          (window as any).__preview?.boxNext?.();
          await new Promise((r) => setTimeout(r, 2500));
          if (!(await imgHas("purple", 500))) throw new Error("live-edit-voice: the merge took the purple dog away");
          if (document.querySelector<HTMLImageElement>("img[src^='blob:']")?.src !== src) throw new Error("live-edit-voice: the merge redrew the same image (flicker)");
        },
      },
    ],
  },
];
