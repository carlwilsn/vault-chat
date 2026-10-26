// "Can you visualize for me?" on the laptop: the answer appears where he is
// talking — a real diagram (an SVG the agent wrote into .vault-chat/visuals/)
// inline in the chat reply, through the chat's own image renderer (ChatImage),
// not ASCII art and not a send to the iPad across the room
// (server/engine/prompt.ts "Visuals", server/boardGuard.ts).
import type { BuildCtx, Scenario } from "./types";
import type * as W from "./world";
// What the real model (GPT-6.1 Sol, the box's throwaway instance, 2026-10-26) wrote and replied for this ask.
import REAL_SVG from "./visual-real-model.svg?raw";

const CONV = "c-visual-bfs";
const PATH = ".vault-chat/visuals/bfs-closest-pair.svg";
const MIN = 60_000;

/** The counterexample the agent drew: BFS from s, a and b both at level 4, two edges apart through z. */
export const BFS_SVG = (() => {
  const node = (x: number, y: number, id: string, marked: boolean) =>
    `<circle cx="${x}" cy="${y}" r="20" fill="${marked ? "#0d9488" : "#f4f4f5"}" stroke="${marked ? "#0f766e" : "#71717a"}" stroke-width="2"/>` +
    `<text x="${x}" y="${y + 6}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="17" font-weight="600" fill="${marked ? "#ffffff" : "#27272a"}">${id}</text>`;
  const edge = (x1: number, y1: number, x2: number, y2: number, hot = false) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${hot ? "#f59e0b" : "#a1a1aa"}" stroke-width="${hot ? 6 : 2.5}" stroke-linecap="round"/>`;
  const level = (y: number, n: number) =>
    `<text x="40" y="${y + 5}" font-family="Inter, system-ui, sans-serif" font-size="14" fill="#71717a">level ${n}</text>` +
    `<line x1="100" y1="${y}" x2="560" y2="${y}" stroke="#e4e4e7" stroke-dasharray="4 6"/>`;
  const ys = [70, 140, 210, 280, 350];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="430" viewBox="0 0 720 430">`,
    `<rect width="720" height="430" rx="14" fill="#ffffff"/>`,
    `<text x="40" y="34" font-family="Inter, system-ui, sans-serif" font-size="18" font-weight="700" fill="#18181b">Why BFS level differences miss the closest pair</text>`,
    ...ys.map((y, i) => level(y, i)),
    edge(330, 70, 330, 140),
    edge(330, 140, 330, 210),
    edge(330, 210, 330, 280),
    edge(330, 280, 260, 350, true),
    edge(330, 280, 400, 350, true),
    node(330, 70, "s", true),
    node(330, 140, "x", false),
    node(330, 210, "y", false),
    node(330, 280, "z", false),
    node(260, 350, "a", true),
    node(400, 350, "b", true),
    `<g font-family="Inter, system-ui, sans-serif" font-size="14" fill="#27272a">`,
    `<rect x="470" y="96" width="232" height="96" rx="10" fill="#f0fdfa" stroke="#99f6e4"/>`,
    `<text x="484" y="122" font-weight="600">Same BFS level</text>`,
    `<text x="484" y="146">d(s,a) = d(s,b) = 4</text>`,
    `<text x="484" y="170">level difference: 0</text>`,
    `<rect x="470" y="222" width="232" height="96" rx="10" fill="#fffbeb" stroke="#fcd34d"/>`,
    `<text x="484" y="248" font-weight="600">Actual closest pair</text>`,
    `<text x="484" y="272">a – z – b: distance 2</text>`,
    `<text x="484" y="296">no two marked vertices adjacent</text>`,
    `</g>`,
    `<circle cx="52" cy="398" r="8" fill="#0d9488"/><text x="66" y="403" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#52525b">marked (R = {s, a, b})</text>`,
    `<line x1="226" y1="398" x2="254" y2="398" stroke="#f59e0b" stroke-width="6" stroke-linecap="round"/><text x="264" y="403" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#52525b">the path the levels can't see</text>`,
    `</svg>`,
  ].join("");
})();

const REPLY = [
  "Here it is — the counterexample, drawn:",
  "",
  `![BFS from s: a and b are both at level 4, but only two edges apart through z](${PATH})`,
  "",
  "Both $a$ and $b$ sit at **level 4**, so subtracting levels gives $0$. The amber path $a - z - b$ is the real distance: **2**. A level records the distance **from $s$**, not between two marked vertices — which is why the multi-source BFS (every marked vertex in the queue at once, each vertex remembering its owner) is the fix.",
].join("\n");

const REAL_PATH = ".vault-chat/visuals/closest-pair-bfs.svg";
const REAL_REPLY =
  "![BFS counterexample with marked vertices s, u, and v](.vault-chat/visuals/closest-pair-bfs.svg)\n\n" +
  "**Blue vertices are marked.** Your BFS puts \\(u\\) and \\(v\\) on the same level, so your rule skips them—but the orange path connects them in just **2 edges**. Either is **3 edges** from \\(s\\).\n\n" +
  "That’s the missed closest pair.";

function conv(now: number, reply = REPLY, id = CONV): W.Conv {
  return {
    id,
    title: "BFS levels and the closest marked pair",
    source: "manual",
    status: "idle",
    unread: false,
    createdAt: now - 12 * MIN,
    lastActivityAt: now - 1 * MIN,
    messages: [
      { role: "user", content: "If I ignore marked vertices on the same level, doesn't the level difference give me the closest pair?" },
      {
        role: "assistant",
        content:
          "**Ignoring same-level vertices still misses valid closest pairs.** Being on the same level doesn't make two vertices close: a level is the distance from $s$, not the distance between them.",
      },
      { role: "user", content: "can you visualize for me?" },
      { role: "assistant", content: reply },
    ],
  };
}

export const visualScenarios: Scenario[] = [
  {
    id: "visual-inline",
    title: "Visuals — \"can you visualize for me?\" answered inline, on the laptop",
    group: "Chat",
    notes:
      "Carl on the laptop asks for a visual: the agent writes a real diagram (an SVG in .vault-chat/visuals/) and puts it in its reply, where he is talking. The chat's own image renderer shows it inline; nothing goes to the iPad unless he asks for the board.",
    build: (ctx: BuildCtx) => {
      ctx.write(PATH, BFS_SVG);
      ctx.conversations([conv(ctx.now)]);
    },
    activeConversation: CONV,
    open: [{ chat: true }, { conversation: CONV }, { sleep: 800 }],
    surfaces: ["desktop"],
  },
  {
    id: "visual-inline-real",
    title: "Visuals — the real model's answer to \"can you visualize for me?\" (box test instance)",
    group: "Chat",
    notes:
      "The SVG and the reply GPT-6.1 Sol wrote on the box's throwaway instance when asked from the laptop after a BFS discussion: a write, a read-back, and the picture inline in the reply. No BoardSend, no BoardMake.",
    build: (ctx: BuildCtx) => {
      ctx.write(REAL_PATH, REAL_SVG);
      ctx.conversations([conv(ctx.now, REAL_REPLY, `${CONV}-real`)]);
    },
    activeConversation: `${CONV}-real`,
    open: [{ chat: true }, { conversation: `${CONV}-real` }, { sleep: 800 }],
    surfaces: ["desktop"],
  },
];
