// The chat transcript's rows as a plugin the agent reaches (src/appPlugins.ts CHAT_ROWS_PLUGIN, app/chat-rows): mounted
// by the chat pane, it draws nothing of its own (the rows are drawn by src/plugins/chat-rows/rows.tsx through the
// registry, src/chatRows.ts) and declares what it offers through api.offer: which renderer draws each kind of row and
// the rows on screen as state; enable / disable / use a renderer, scroll to a row, open or close tool rows as actions;
// a `changed` event when the renderers change. Turned off, the agent cannot reach it and the rows still draw.
//
// The choices (a renderer off, the one chosen for a kind) are this plugin's state: plugin.state records on the box
// (src/appPluginState.ts), keys "off:<renderer id>" = true, "use:<kind>" = <renderer id> and "opt:<kind>:<option>" = a
// renderer option's value (the plan's placement, the inline page's size: src/plugins/chat-rows/options.ts). So they survive a restart and
// are the same in every window; the registry follows them (followRowPrefs, from the app's start, so the first paint
// already has them), also while the plugin itself is off.
import type { PluginApi } from "../../mountHost";
import { CHAT_REVEAL_EVENT, describeRowOptions, describeRows, rowOptionProblem, rowRenderer, setRowOptionValues, setRowPrefs, subscribeRows, visibleRows } from "../../chatRows";
import { appPluginState, setAppPluginState, subscribeAppPluginState } from "../../appPluginState";
import { CHAT_ROWS_PLUGIN_ID } from "../../appPlugins";
import { useStore } from "../../store";

const OFF = "off:";
const USE = "use:";
const OPT = "opt:";

/** The kept option values, from the plugin's state: {kind: {option: value}}. */
export function rowOptionValues(state: Record<string, unknown> = appPluginState(CHAT_ROWS_PLUGIN_ID)): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(state)) {
    if (!k.startsWith(OPT)) continue;
    const at = k.lastIndexOf(":");
    const kind = k.slice(OPT.length, at);
    const key = k.slice(at + 1);
    if (kind && key && at > OPT.length) (out[kind] ??= {})[key] = v;
  }
  return out;
}

/** The kept choices, from the plugin's state. */
export function rowPrefs(state: Record<string, unknown> = appPluginState(CHAT_ROWS_PLUGIN_ID)): { disabled: string[]; chosen: Record<string, string> } {
  const disabled: string[] = [];
  const chosen: Record<string, string> = {};
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith(OFF) && v === true) disabled.push(k.slice(OFF.length));
    else if (k.startsWith(USE) && typeof v === "string" && v) chosen[k.slice(USE.length)] = v;
  }
  return { disabled, chosen };
}

let following: (() => void) | null = null;
/** The registry follows the kept choices from now on (once; returns off). */
export function followRowPrefs(): () => void {
  if (following) return following;
  const apply = () => {
    const state = appPluginState(CHAT_ROWS_PLUGIN_ID);
    const p = rowPrefs(state);
    setRowPrefs(p.disabled, p.chosen);
    setRowOptionValues(rowOptionValues(state));
  };
  apply();
  const offState = subscribeAppPluginState((id) => id === CHAT_ROWS_PLUGIN_ID && apply());
  let vault = useStore.getState().vaultPath;
  const offStore = useStore.subscribe((st) => {
    if (st.vaultPath === vault) return;
    vault = st.vaultPath;
    apply();
  });
  following = () => {
    offState();
    offStore();
    following = null;
  };
  return following;
}
followRowPrefs();

/** Keep one choice: a record on the box (here at once). What the box said, for the agent. */
async function keep(writes: [string, unknown][]): Promise<{ kept: boolean; why?: string }> {
  let why: string | null = null;
  for (const [k, v] of writes) why = (await setAppPluginState(CHAT_ROWS_PLUGIN_ID, k, v)) ?? why;
  return why ? { kept: false, why } : { kept: true };
}

function named(id: string): void {
  if (!rowRenderer(id)) throw new Error(`no chat row renderer "${id}" (see the renderers state)`);
}

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
      options: {
        description:
          "The app's own renderers' options, per kind (plan: placement inline | pinned | hidden, done line | full | hidden; inline-html: placement inline | viewer, foldInViewer, size auto | aspect=W/H | height=N, viewerButton): each with its description, values, default, value now and whether it is set. Set one with setOption.",
        read: () => describeRowOptions(),
      },
      kept: {
        description: "The choices kept on the box (the same in every window, after a restart): disabled = renderer ids turned off, chosen = {kind: renderer id}.",
        read: () => rowPrefs(),
      },
      rows: {
        description: "The rows drawn now (the newest 60): {index, kind, renderer, mid?, text (one line), tools?}; total = messages in the chat, shownFrom = the first index drawn (older ones join on scroll).",
        read: () => visibleRows(60),
      },
    },
    actions: {
      disable: {
        description: "Turn a renderer off by its id (see renderers): its kind is drawn by the next in line (a plugin's off: the built-in; the built-in off: the plain fallback row). Kept: every window, and after a restart.",
        args: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const id = String(a.id);
          named(id);
          return { disabled: id, ...(await keep([[OFF + id, true]])) };
        },
      },
      enable: {
        description: "Turn a renderer back on by its id (kept, like disable).",
        args: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const id = String(a.id);
          if (!rowPrefs().disabled.includes(id)) named(id);
          return { enabled: id, ...(await keep([[OFF + id, null]])) };
        },
      },
      use: {
        description: "Choose which registered renderer draws a kind (id from renderers, e.g. builtin:tool-call to override a plugin's; it is turned on too); id omitted: back to the default order (newest plugin renderer, else the built-in). Kept, like disable.",
        args: { type: "object", properties: { kind: { type: "string" }, id: { type: "string" } }, required: ["kind"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const kind = String(a.kind);
          const id = typeof a.id === "string" && a.id ? a.id : null;
          if (id) {
            const x = rowRenderer(id);
            if (!x || x.kind !== kind) throw new Error(`no renderer "${id}" for kind "${kind}" (see the renderers state)`);
          }
          const writes: [string, unknown][] = [[USE + kind, id]];
          if (id && rowPrefs().disabled.includes(id)) writes.push([OFF + id, null]);
          return { kind, using: id ?? "default", ...(await keep(writes)) };
        },
      },
      setOption: {
        description:
          "Set an option of the app's own renderer of a kind (see options), live in every window and kept after a restart: e.g. {kind: \"plan\", key: \"placement\", value: \"pinned\"}, {kind: \"inline-html\", key: \"size\", value: \"aspect=4/3\"}, {kind: \"inline-html\", key: \"placement\", value: \"viewer\"}. value null: back to its default.",
        args: {
          type: "object",
          properties: { kind: { type: "string" }, key: { type: "string" }, value: { type: ["string", "boolean", "number", "null"] } },
          required: ["kind", "key", "value"],
          additionalProperties: false,
        },
        run: async (a: Record<string, unknown>) => {
          const kind = String(a.kind);
          const key = String(a.key);
          const value = a.value === undefined ? null : a.value;
          const bad = rowOptionProblem(kind, key, value);
          if (bad) throw new Error(bad);
          return { kind, key, value: value ?? "default", ...(await keep([[`${OPT}${kind}:${key}`, value]])) };
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
      changed: { description: "The renderers changed (registered, removed, enabled, disabled or chosen, here or in another window): the active renderer of each kind after it." },
    },
  };
}

export function mount(_el: HTMLElement, api: PluginApi): () => void {
  const offers = api.offer(chatRowsOffers(document));
  const off = subscribeRows(() => offers.emit("changed", Object.fromEntries(describeRows().map((k) => [k.kind, k.active]))));
  return off;
}
