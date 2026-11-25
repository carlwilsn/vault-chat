// The home scenario's places (tiles proposal): Main with a short history and two chats of its own, and two projects
// (BitNet 160M, Stat 210) with their chats, so the Chats panel has something to open. Every chat has a short fake
// history; the projects are agent-projects/<slug>/project.md, as the app makes them.
import type { BuildCtx, Step } from "./types";
import * as W from "./world";

const MIN = 60_000;
const HOUR = 60 * MIN;

const u = (content: string) => ({ role: "user", content });
const a = (content: string) => ({ role: "assistant", content });

const PROJECTS = [
  { slug: "bitnet-160m", name: "BitNet 160M" },
  { slug: "stat-210", name: "Stat 210" },
];

/** Which place each of the world's chats sits in (null: Main). */
const PLACE: Record<string, string | null> = { "c-spectral": null, "c-ps3": "stat-210", "c-writeup": "bitnet-160m" };

export function homePlaces(ctx: BuildCtx): void {
  const { now, vault } = ctx;
  for (const p of PROJECTS) ctx.write(`agent-projects/${p.slug}/project.md`, `# ${p.name}\n`);
  // Every place opens showing its chats (src/placeOpen.ts: Carl's open/shut choice, per vault).
  ctx.ls["vault_chat_place_open"] = JSON.stringify({ [vault]: Object.fromEntries(["main", ...PROJECTS.map((p) => `project-${p.slug}`)].map((k) => [k, true])) });
  const placed = W.chats(vault, now).map((c) => ({ ...c, kind: "separate", project: PLACE[c.id] ?? null }));
  const chat = (id: string, title: string, project: string | null, ago: number, msgs: Record<string, unknown>[]) => ({
    id,
    title,
    source: "manual",
    status: "idle",
    unread: false,
    kind: "separate",
    project,
    createdAt: now - ago - 10 * MIN,
    lastActivityAt: now - ago,
    messages: msgs,
  });
  ctx.conversations([
    {
      id: "main",
      title: "Main",
      source: "main",
      kind: "main",
      status: "idle",
      unread: false,
      createdAt: now - 72 * HOUR,
      lastActivityAt: now - 2 * HOUR,
      messages: [
        u("Morning. What's on today?"),
        a("Morning! The BitNet writeup summary is tightened, PS3 is due Friday, and the seed-44 eval finished overnight (1.5588)."),
        u("Remind me to reread the Chinchilla note before the reading group."),
        a("Noted: reread `reading/chinchilla.md` before Thursday's reading group."),
      ],
    },
    // Each project's own thread (the box lists a project by it: preview/runtime/backend/host.ts /projects).
    ...PROJECTS.map((p, i) => ({
      id: `project-${p.slug}`,
      title: p.name,
      source: "project",
      kind: "project",
      project: p.slug,
      status: "idle",
      unread: false,
      createdAt: now - (60 + i) * HOUR,
      lastActivityAt: now - (40 + i) * HOUR,
      messages: [u(`Set up the ${p.name} project.`), a(`Done: its notes live in agent-projects/${p.slug}/project.md.`)],
    })),
    ...placed,
    chat("c-mup", "muP: what transfers across width?", null, 8 * HOUR, [
      u("In muP, which hyperparameters transfer when I scale width?"),
      a("Learning rate, init scale and output multiplier transfer across width under muP's parametrization. Depth and batch size don't: those still need a sweep (see `notes/mup.md`)."),
    ]),
    chat("c-lr", "LR schedule for 3.2B tokens", "bitnet-160m", 3 * HOUR, [
      u("If I extend training to 3.2B tokens, should the cosine schedule stretch or should I add a constant phase?"),
      a("Stretch it: a cosine over the full 3.2B tokens with the same peak (1.5e-3) and a 2% warmup. A WSD schedule is the alternative if you want to stop early and still decay."),
      u("OK, cosine it is."),
      a("Updated `train.py`'s config: `total_tokens=3.2e9`, `warmup=0.02`."),
    ]),
    chat("c-seeds", "Seed spread in results.csv", "bitnet-160m", 26 * HOUR, [
      u("Is a 0.0025 nat spread across three seeds normal at 160M?"),
      a("Yes: at this scale seed noise is usually 0.002 to 0.005 nat, so the reproduction is inside it."),
    ]),
    chat("c-syllabus", "Stat 210: what's on the midterm?", "stat-210", 30 * HOUR, [
      u("What does the syllabus say the midterm covers?"),
      a("Weeks 1 to 6: concentration inequalities, matrix perturbation (Davis–Kahan, Weyl) and spectral clustering. Open notes, 80 minutes."),
    ]),
  ]);
}

/** Files opens with a few folders expanded (notes, papers, the BitNet project). */
export const expandHomeFolders: Step = {
  run: async (api) => {
    const { setExpanded } = await import(/* @vite-ignore */ "/src/plugins/filetree/model.ts");
    const dirs = ["notes", "papers", "projects", "projects/bitnet-160m", "courses", "courses/stat-210"].map((d) => `${api.vault}/${d}`);
    setExpanded((prev: Set<string>) => new Set([...prev, ...dirs]));
  },
};
