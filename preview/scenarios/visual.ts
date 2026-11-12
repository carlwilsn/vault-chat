// "Can you visualize for me?" on the laptop: the answer appears where he is
// talking — a real diagram (an SVG the agent wrote into .vault-chat/visuals/)
// inline in the chat reply, through the chat's own image renderer (ChatImage),
// not ASCII art and not a send to the iPad across the room
// (server/engine/prompt.ts "Visuals", server/boardGuard.ts).
import type { BuildCtx, Scenario } from "./types";
import type * as W from "./world";
// What the real model (GPT-6.1 Sol, the box's throwaway instance, 2026-10-26) wrote and replied for this ask.
import REAL_SVG from "./visual-real-model.svg?raw";
// The sample mockup: the app's composer with its real classes, linking the app's stylesheet (src/inlineHtml.ts).
import SAMPLE_HTML from "./inline-html-sample.html?raw";
import THEME_HTML from "./page-theme.html?raw";
import LIVE_HTML from "./live-chat-demo.html?raw";
// A copy of the vault page .vault-chat/visuals/voice-lab.html (tool:voice-lab.*, mic): its calls reach the real lab service.
import LAB_HTML from "./voice-lab.html?raw";
// A counter that keeps its number with the state service (change 1.2): every view of it shows the same number.
import STATE_HTML from "./page-state.html?raw";
// A page that starts real chats with the converse service (change 1.3): the new chat appears in the chat list.
import CONVERSE_HTML from "./page-converse.html?raw";
// Pages that declare an in-process mount (change 1.5, src/mountHost.ts): one that works, one whose mount() throws.
import PLUGIN_COUNTER_HTML from "./plugin-counter.html?raw";
import PLUGIN_BROKEN_HTML from "./plugin-broken.html?raw";
// A page that reads the catalog (change 1.4): the registered services and the plugins in the vault.
import CATALOG_HTML from "./page-catalog.html?raw";

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

const HTML_CONV = "c-inline-html";
const HTML_PATH = ".vault-chat/visuals/sample-mockup.html";

export const visualScenarios: Scenario[] = [
  {
    id: "inline-html",
    title: "Inline HTML — a live, interactive page in the reply (a composer mockup in the app's own styles)",
    group: "Chat",
    notes:
      "The agent links a vault .html in image syntax: the chat shows it live in a sandboxed frame (no network, no same-origin), sized to its content, with Open in viewer. This page links /app-styles.css, so it renders in the app's real CSS and theme; type in it, press +.",
    build: (ctx: BuildCtx) => {
      ctx.write(HTML_PATH, SAMPLE_HTML);
      ctx.conversations([{
        id: HTML_CONV, title: "Composer mockup", source: "manual", status: "idle", unread: false,
        createdAt: ctx.now - 5 * MIN, lastActivityAt: ctx.now - MIN,
        messages: [
          { role: "user", content: "show me the composer with the plus menu, as a real mockup" },
          { role: "assistant", content: `Here it is, live — type to enable Send, press + for the menu:\n\n![Composer mockup](${HTML_PATH})\n\nSame classes as the real composer.` },
        ],
      }]);
    },
    activeConversation: HTML_CONV,
    open: [{ chat: true }, { conversation: HTML_CONV }, { sleep: 1200 }],
    surfaces: ["desktop"],
  },
  {
    id: "page-theme",
    title: "Page theme — a vault .html follows the app's theme live (--vc-* variables); the newest embed of a file is the live one",
    group: "Chat",
    notes: "theme-demo.html uses --vc-bg/--vc-fg/--vc-muted/--vc-border/--vc-accent. It is embedded twice: the older embed folds to a static row. Switch the theme in Settings and the page follows without a reload.",
    build: (ctx: BuildCtx) => {
      ctx.write(".vault-chat/visuals/theme-demo.html", THEME_HTML);
      ctx.conversations([{
        id: "c-page-theme", title: "Page theme", source: "manual", status: "idle", unread: false,
        createdAt: ctx.now - 5 * MIN, lastActivityAt: ctx.now - MIN,
        messages: [
          { role: "user", content: "show me the theme demo" },
          { role: "assistant", content: "First try:\n\n![Theme demo](.vault-chat/visuals/theme-demo.html)" },
          { role: "user", content: "again" },
          { role: "assistant", content: "Again:\n\n![Theme demo](.vault-chat/visuals/theme-demo.html)" },
        ],
      }]);
    },
    activeConversation: "c-page-theme",
    open: [{ chat: true }, { conversation: "c-page-theme" }, { sleep: 1200 }],
    surfaces: ["desktop"],
  },
  {
    id: "page-live-edit",
    title: "Page live edit — the inline copy of a page reloads when its file changes",
    group: "Chat",
    notes: "At 4 s the file is rewritten on disk (Version 2): the inline copy reloads by itself. theme-demo.html uses --vc-bg/--vc-fg/--vc-muted/--vc-border/--vc-accent. It is embedded twice: the older embed folds to a static row. Switch the theme in Settings and the page follows without a reload.",
    build: (ctx: BuildCtx) => {
      ctx.write(".vault-chat/visuals/theme-demo.html", THEME_HTML);
      ctx.conversations([{
        id: "c-page-edit", title: "Page theme", source: "manual", status: "idle", unread: false,
        createdAt: ctx.now - 5 * MIN, lastActivityAt: ctx.now - MIN,
        messages: [
          { role: "user", content: "show me the theme demo" },
          { role: "assistant", content: "First try:\n\n![Theme demo](.vault-chat/visuals/theme-demo.html)" },
        ],
      }]);
    },
    activeConversation: "c-page-edit",
    open: [{ chat: true }, { conversation: "c-page-edit" }, { sleep: 4000 }, { run: async (api) => { const { invoke } = await import("@tauri-apps/api/core"); const { refreshOpenFiles } = await import("../../src/liveReload"); const rel = ".vault-chat/visuals/theme-demo.html"; const cur = await invoke<string>("read_text_file", { path: `${api.vault}/${rel}` }); await invoke("write_text_file", { path: `${api.vault}/${rel}`, contents: cur.replace("Version 1", "Version 2 (edited)").replace("<p class=\"muted\">", "<p>Edited on disk: the chat copy reloaded.</p><p class=\"muted\">") }); await refreshOpenFiles({ paths: [rel] }); } }, { sleep: 3000 }],
    surfaces: ["desktop"],
  },
  {
    id: "page-theme-viewer",
    title: "Page theme in the viewer — a vault .html follows the app's theme live (--vc-* variables); the newest embed of a file is the live one",
    group: "Chat",
    notes: "theme-demo.html uses --vc-bg/--vc-fg/--vc-muted/--vc-border/--vc-accent. It is embedded twice: the older embed folds to a static row. Switch the theme in Settings and the page follows without a reload.",
    build: (ctx: BuildCtx) => {
      ctx.write(".vault-chat/visuals/theme-demo.html", THEME_HTML);
      ctx.conversations([{
        id: "c-page-theme", title: "Page theme", source: "manual", status: "idle", unread: false,
        createdAt: ctx.now - 5 * MIN, lastActivityAt: ctx.now - MIN,
        messages: [
          { role: "user", content: "show me the theme demo" },
          { role: "assistant", content: "First try:\n\n![Theme demo](.vault-chat/visuals/theme-demo.html)" },
          { role: "user", content: "again" },
          { role: "assistant", content: "Again:\n\n![Theme demo](.vault-chat/visuals/theme-demo.html)" },
        ],
      }]);
    },
    activeConversation: "c-page-theme",
    open: [{ chat: true }, { file: ".vault-chat/visuals/theme-demo.html" }, { sleep: 1500 }],
    surfaces: ["desktop"],
  },
  {
    id: "live-page",
    title: "Live page — a vault .html that declares `ask` gets a one-time grant, then streams AI replies (vc.ask)",
    group: "Chat",
    notes:
      "The page's <meta name=\"vc-capabilities\" content=\"ask\"> makes it a live page: the app asks once (Allow), the box mints a scoped token, and the page's nested chat streams scripted replies through vc.ask (an ephemeral read-only side session, no chat created).",
    build: (ctx: BuildCtx) => {
      ctx.write(".vault-chat/visuals/live-chat-demo.html", LIVE_HTML);
      ctx.conversations([{
        id: "c-live-page", title: "Live chat demo", source: "manual", status: "idle", unread: false,
        createdAt: ctx.now - 5 * MIN, lastActivityAt: ctx.now - MIN,
        messages: [
          { role: "user", content: "make me a tiny chat app that talks to the AI" },
          { role: "assistant", content: "Here it is, live:\n\n![Live chat](.vault-chat/visuals/live-chat-demo.html)" },
        ],
      }]);
    },
    host: (now: number) => ({
      sync: {
        box: { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" },
        boxChat: {
          convs: {
            "c-live-page": {
              title: "Live chat demo", source: "manual", status: "idle",
              meta: { unread: false, createdAt: now - 5 * MIN, lastActivityAt: now - MIN },
              messages: [
                { role: "user", content: "make me a tiny chat app that talks to the AI" },
                { role: "assistant", content: "Here it is, live:\n\n![Live chat](.vault-chat/visuals/live-chat-demo.html)" },
              ],
            },
          } as any,
          steps: [],
        },
      },
    }),
    llm: { scripts: [{ id: "live-ask", match: /./, steps: [{ text: "Hi! I'm answering through vc.ask: an ephemeral, read-only side session on the box, streamed into this page. Nothing here touched your vault or your chat list." }] }] },
    activeConversation: "c-live-page",
    open: [{ chat: true }, { conversation: "c-live-page" }, { sleep: 1200 }],
    surfaces: ["desktop"],
  },
  {
    id: "live-page-viewer",
    title: "Live page in the viewer — a vault .html that declares `ask` gets a one-time grant, then streams AI replies (vc.ask)",
    group: "Chat",
    notes:
      "The page's <meta name=\"vc-capabilities\" content=\"ask\"> makes it a live page: the app asks once (Allow), the box mints a scoped token, and the page's nested chat streams scripted replies through vc.ask (an ephemeral read-only side session, no chat created).",
    build: (ctx: BuildCtx) => {
      ctx.write(".vault-chat/visuals/live-chat-demo.html", LIVE_HTML);
      ctx.conversations([{
        id: "c-live-page", title: "Live chat demo", source: "manual", status: "idle", unread: false,
        createdAt: ctx.now - 5 * MIN, lastActivityAt: ctx.now - MIN,
        messages: [
          { role: "user", content: "make me a tiny chat app that talks to the AI" },
          { role: "assistant", content: "Here it is, live:\n\n![Live chat](.vault-chat/visuals/live-chat-demo.html)" },
        ],
      }]);
    },
    host: (now: number) => ({
      sync: {
        box: { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" },
        boxChat: {
          convs: {
            "c-live-page": {
              title: "Live chat demo", source: "manual", status: "idle",
              meta: { unread: false, createdAt: now - 5 * MIN, lastActivityAt: now - MIN },
              messages: [
                { role: "user", content: "make me a tiny chat app that talks to the AI" },
                { role: "assistant", content: "Here it is, live:\n\n![Live chat](.vault-chat/visuals/live-chat-demo.html)" },
              ],
            },
          } as any,
          steps: [],
        },
      },
    }),
    llm: { scripts: [{ id: "live-ask", match: /./, steps: [{ text: "Hi! I'm answering through vc.ask: an ephemeral, read-only side session on the box, streamed into this page. Nothing here touched your vault or your chat list." }] }] },
    activeConversation: "c-live-page",
    open: [{ file: ".vault-chat/visuals/live-chat-demo.html" }, { sleep: 1500 }],
    surfaces: ["desktop"],
  },
  {
    id: "page-state",
    title: "Page state — a counter page keeps its number in the box's log (vc.state): the chat's copy and the viewer show one counter",
    group: "Chat",
    notes:
      "The page declares state, log. After the one-time Allow, +1 in the chat's inline copy sets the count through vc.state.set; Open in viewer mounts a second view that reads the same state; +1 there, close the viewer, and the chat's copy shows the new number (vc.state.subscribe).",
    build: (ctx: BuildCtx) => {
      ctx.write(".vault-chat/visuals/counter.html", STATE_HTML);
      ctx.conversations([{
        id: "c-page-state", title: "Counter page", source: "manual", status: "idle", unread: false,
        createdAt: ctx.now - 5 * MIN, lastActivityAt: ctx.now - MIN,
        messages: [
          { role: "user", content: "make me a click counter that is the same everywhere I open it" },
          { role: "assistant", content: "Here it is; its number lives on the box:\n\n![Counter](.vault-chat/visuals/counter.html)" },
        ],
      }]);
    },
    host: (now: number) => ({
      sync: {
        box: { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" },
        boxChat: {
          convs: {
            "c-page-state": {
              title: "Counter page", source: "manual", status: "idle",
              meta: { unread: false, createdAt: now - 5 * MIN, lastActivityAt: now - MIN },
              messages: [
                { role: "user", content: "make me a click counter that is the same everywhere I open it" },
                { role: "assistant", content: "Here it is; its number lives on the box:\n\n![Counter](.vault-chat/visuals/counter.html)" },
              ],
            },
          } as any,
          steps: [],
        },
      },
    }),
    activeConversation: "c-page-state",
    open: [{ chat: true }, { conversation: "c-page-state" }, { sleep: 1200 }],
    surfaces: ["desktop"],
  },
  {
    id: "page-catalog",
    title: "Page catalog — a page lists the registered services and the vault's plugins (vc.catalog)",
    group: "Chat",
    notes:
      "The page declares catalog. After the one-time Allow, Read the catalog fetches GET /api/v2/plugin/catalog: every registered service (who supplies it, its line) and every page in the vault with a vc-capabilities or vc-mount manifest (its name, where it runs, what it needs). The plain picture page is not a plugin and is not listed.",
    build: (ctx: BuildCtx) => {
      ctx.write(".vault-chat/visuals/plugin-catalog.html", CATALOG_HTML);
      ctx.write(".vault-chat/visuals/counter.html", STATE_HTML);
      ctx.write(".vault-chat/visuals/start-chat.html", CONVERSE_HTML);
      ctx.write(".vault-chat/visuals/voice-lab.html", LAB_HTML);
      ctx.write(".vault-chat/visuals/live-chat-demo.html", LIVE_HTML);
      ctx.write(".vault-chat/visuals/plugin-counter.html", PLUGIN_COUNTER_HTML);
      ctx.write(".vault-chat/visuals/inline-html-sample.html", SAMPLE_HTML);
    },
    host: () => ({ sync: { box: { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" }, boxChat: { convs: {} as any, steps: [] } } }),
    open: [{ file: ".vault-chat/visuals/plugin-catalog.html" }, { sleep: 1500 }],
    surfaces: ["desktop"],
  },
  {
    id: "page-converse",
    title: "Page converse — a page starts a real chat (vc.converse.start): it appears in the chat list",
    group: "Chat",
    notes:
      "The page declares converse. After the one-time Allow, Start a chat sends its text as a start: the box makes a new chat (marked as the page's), the chat list shows it, and the page lists it from vc.converse.list().",
    build: (ctx: BuildCtx) => {
      ctx.write(".vault-chat/visuals/start-chat.html", CONVERSE_HTML);
      ctx.conversations([{
        id: "c-page-converse", title: "Chat starter page", source: "manual", status: "idle", unread: false,
        createdAt: ctx.now - 5 * MIN, lastActivityAt: ctx.now - MIN,
        messages: [
          { role: "user", content: "make me a page that can start a chat for me" },
          { role: "assistant", content: "Here it is; what you type there becomes a new chat:\n\n![Start a chat](.vault-chat/visuals/start-chat.html)" },
        ],
      }]);
    },
    host: (now: number) => ({
      sync: {
        box: { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" },
        boxChat: {
          convs: {
            "c-page-converse": {
              title: "Chat starter page", source: "manual", status: "idle",
              meta: { unread: false, createdAt: now - 5 * MIN, lastActivityAt: now - MIN },
              messages: [
                { role: "user", content: "make me a page that can start a chat for me" },
                { role: "assistant", content: "Here it is; what you type there becomes a new chat:\n\n![Start a chat](.vault-chat/visuals/start-chat.html)" },
              ],
            },
          } as any,
          steps: [],
        },
      },
    }),
    activeConversation: "c-page-converse",
    open: [{ chat: true }, { conversation: "c-page-converse" }, { sleep: 1200 }],
    surfaces: ["desktop"],
  },
  {
    id: "plugin-mount",
    title: "In-process mount — a page that declares vc-mount: in-process runs in the app itself (no iframe); one that throws becomes an error card and the app stands",
    group: "Chat",
    notes:
      "Two pages with <meta name=\"vc-mount\" content=\"in-process\">, inline in a reply. The counter's mount(el, api) runs in the app's own document (a shadow root, no iframe): +1 counts. The broken one's mount() throws: its box shows 'Broken widget stopped' with the error and a Reload, and the chat, the composer and the counter keep working.",
    build: (ctx: BuildCtx) => {
      ctx.write(".vault-chat/visuals/plugin-counter.html", PLUGIN_COUNTER_HTML);
      ctx.write(".vault-chat/visuals/plugin-broken.html", PLUGIN_BROKEN_HTML);
      ctx.conversations([{
        id: "c-plugin-mount", title: "In-process plugins", source: "manual", status: "idle", unread: false,
        createdAt: ctx.now - 5 * MIN, lastActivityAt: ctx.now - MIN,
        messages: [
          { role: "user", content: "mount a plugin without an iframe, and show me what happens when one is broken" },
          { role: "assistant", content: "A counter, mounted in the app itself:\n\n![Counter](.vault-chat/visuals/plugin-counter.html)\n\nAnd one whose mount() throws:\n\n![Broken widget](.vault-chat/visuals/plugin-broken.html)" },
        ],
      }]);
    },
    host: (now: number) => ({
      sync: {
        box: { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" },
        boxChat: {
          convs: {
            "c-plugin-mount": {
              title: "In-process plugins", source: "manual", status: "idle",
              meta: { unread: false, createdAt: now - 5 * MIN, lastActivityAt: now - MIN },
              messages: [
                { role: "user", content: "mount a plugin without an iframe, and show me what happens when one is broken" },
                { role: "assistant", content: "A counter, mounted in the app itself:\n\n![Counter](.vault-chat/visuals/plugin-counter.html)\n\nAnd one whose mount() throws:\n\n![Broken widget](.vault-chat/visuals/plugin-broken.html)" },
              ],
            },
          } as any,
          steps: [],
        },
      },
    }),
    activeConversation: "c-plugin-mount",
    open: [{ chat: true }, { conversation: "c-plugin-mount" }, { sleep: 1200 }],
    surfaces: ["desktop"],
  },
  {
    id: "live-page-voice-lab",
    title: "Voice lab — a live page with tool:voice-lab.* compares TTS/STT engines on the box (vc.tool, vc.mic)",
    group: "Chat",
    notes:
      "voice-lab.html declares mic + tool:voice-lab.*; after the one-time Allow its calls go to the box's /api/v2/lab/* route (here: the real lab proxy and the real local service). Needs the service on 127.0.0.1:8871.",
    build: (ctx: BuildCtx) => {
      ctx.write(".vault-chat/visuals/voice-lab.html", LAB_HTML);
    },
    host: () => ({ sync: { box: { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" } } }),
    open: [{ file: ".vault-chat/visuals/voice-lab.html" }, { sleep: 1500 }],
    surfaces: ["desktop"],
  },
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
