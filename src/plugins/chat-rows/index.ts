// The chat transcript's rows as a plugin the agent reaches (src/appPlugins.ts CHAT_ROWS_PLUGIN, app/chat-rows): mounted
// by the chat pane, it draws nothing of its own (the rows are drawn by src/plugins/chat-rows/rows.tsx through the
// registry, src/chatRows.ts) and declares what it offers through api.offer: which renderer draws each kind of row and
// the rows on screen as state; enable / disable / use a renderer, scroll to a row, open or close tool rows as actions;
// a `changed` event when the renderers change. Turned off, the agent cannot reach it and the rows still draw.
import type { PluginApi } from "../../mountHost";
import { CHAT_REVEAL_EVENT, chooseRowRenderer, describeRows, setRowEnabled, subscribeRows, visibleRows } from "../../chatRows";

/** The chat's scroller: the element the rows sit in (null: no chat pane on screen). */
function rowsRoot(doc: Document): HTMLElement | null {
  const any = doc.querySelector<HTMLElement>("[data-row]");
  return any?.parentElement ?? null;
}

const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** The row's element on screen (its index; the newest row with `last`). */
function rowEl(doc: Document, index: number | "last"): HTMLElement | null {
  if (index === "last") {
    const all = doc.querySelectorAll<HTMLElement>("[data-row]");
    return all[all.length - 1] ?? null;
  }
  return doc.querySelector<HTMLElement>(`[data-row="${index}"]`);
}

/** The collapsible rows: a reply's tool calls, a voice ask's work, a job's output, the compaction summary. */
const TOOL_ROWS = 'details[data-el="tool-calls"], details[data-el="voice-ask"], details[data-el="job-end"]';

export function chatRowsOffers(doc: Document = document) {
  return {
    state: {
      renderers: {
        description:
          "Each kind of row (user, assistant, notice, working, divider, job, voice, voice-ask, plan, tool-call, tool-call:<Tool>, inline-html) with the renderer drawing it (active: builtin:<kind>, a plugin's <plugin id>#<kind>, or fallback = the plain text row) and every renderer registered for it (by, enabled, failures).",
        read: () => describeRows(),
      },
      rows: {
        description: "The rows drawn now (the newest 60): {index, kind, renderer, mid?, text (one line), tools?}; total = messages in the chat, shownFrom = the first index drawn (older ones join on scroll).",
        read: () => visibleRows(60),
      },
    },
    actions: {
      disable: {
        description: "Turn a renderer off by its id (see renderers): its kind is drawn by the next in line (a plugin's off: the built-in; the built-in off: the plain fallback row). Until the app restarts.",
        args: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          setRowEnabled(String(a.id), false);
          return { disabled: String(a.id) };
        },
      },
      enable: {
        description: "Turn a renderer back on by its id.",
        args: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          setRowEnabled(String(a.id), true);
          return { enabled: String(a.id) };
        },
      },
      use: {
        description: "Choose which registered renderer draws a kind (id from renderers, e.g. builtin:tool-call to override a plugin's); id omitted: back to the default order (newest plugin renderer, else the built-in).",
        args: { type: "object", properties: { kind: { type: "string" }, id: { type: "string" } }, required: ["kind"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          chooseRowRenderer(String(a.kind), typeof a.id === "string" && a.id ? a.id : null);
          return { kind: String(a.kind), using: typeof a.id === "string" && a.id ? a.id : "default" };
        },
      },
      scrollTo: {
        description: "Scroll the chat to a row: index (from rows; an older one is drawn first) or last: true.",
        args: { type: "object", properties: { index: { type: "integer" }, last: { type: "boolean" } }, additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const want: number | "last" = a.last === true || a.index === undefined ? "last" : Number(a.index);
          let el = rowEl(doc, want);
          if (!el && want !== "last") {
            window.dispatchEvent(new CustomEvent(CHAT_REVEAL_EVENT, { detail: { index: want } }));
            await frames();
            el = rowEl(doc, want);
          }
          if (!el) throw new Error(want === "last" ? "no chat rows on screen (is the chat open?)" : `row ${want} is not drawn (hidden, a finished job, or not in this chat; see rows)`);
          el.scrollIntoView({ block: "center" });
          return { scrolledTo: want };
        },
      },
      toolRows: {
        description: "Open or close the collapsible rows (a reply's tool calls, voice-ask work, job output): every one on screen, or the one row at index.",
        args: { type: "object", properties: { open: { type: "boolean" }, index: { type: "integer" } }, required: ["open"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          const root = a.index === undefined ? rowsRoot(doc) : rowEl(doc, Number(a.index));
          if (!root) throw new Error(a.index === undefined ? "no chat rows on screen" : `row ${a.index} is not drawn`);
          const list = [...(root.matches(TOOL_ROWS) ? [root] : []), ...root.querySelectorAll<HTMLDetailsElement>(TOOL_ROWS)] as HTMLDetailsElement[];
          for (const d of list) d.toggleAttribute("open", a.open === true);
          return { rows: list.length, open: a.open === true };
        },
      },
    },
    events: {
      changed: { description: "The renderers changed (registered, removed, enabled, disabled or chosen): the active renderer of each kind after it." },
    },
  };
}

export function mount(_el: HTMLElement, api: PluginApi): () => void {
  const offers = api.offer(chatRowsOffers(document));
  const off = subscribeRows(() => offers.emit("changed", Object.fromEntries(describeRows().map((k) => [k.kind, k.active]))));
  return off;
}
