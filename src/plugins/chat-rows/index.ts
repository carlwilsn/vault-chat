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
import "../../convlog/view"; // the app's own translators register with it
import { describeTranslators, setTranslatorPrefs, subscribeTranslators, translatorById } from "../../convlog/translators";
import { rowKey, rowOpenParts, setRowOpen, useRowOpen } from "../../rowOpen";
import { inlineAct, inlineFramesNow, onInlineChanged } from "../../inlineFrames";
import { CHAT_REVEAL_EVENT, TAIL_KINDS, describeRowOptions, rowChain, describeRows, rowOptionProblem, rowRenderer, setRowOptionValues, setRowPrefs, subscribeRows, visibleRows } from "../../chatRows";
import { appPluginState, setAppPluginState, subscribeAppPluginState } from "../../appPluginState";
import { CHAT_ROWS_PLUGIN_ID } from "../../appPlugins";
import { useStore } from "../../store";
import { OFF, OPT, TOFF, TUSE, USE, rowOptionValues as optionsOf, rowPrefs as prefsOf, translatorPrefs as tPrefsOf } from "./prefs";

/** The kept translator choices (src/convlog/translators.ts): ids turned off, the one chosen per event type. */
export const translatorPrefs = (state: Record<string, unknown> = appPluginState(CHAT_ROWS_PLUGIN_ID)) => tPrefsOf(state);
/** The kept option values, from the plugin's state: {kind: {option: value}}. */
export const rowOptionValues = (state: Record<string, unknown> = appPluginState(CHAT_ROWS_PLUGIN_ID)) => optionsOf(state);
/** The kept choices, from the plugin's state. */
export const rowPrefs = (state: Record<string, unknown> = appPluginState(CHAT_ROWS_PLUGIN_ID)) => prefsOf(state);

let following: (() => void) | null = null;
/** The registry follows the kept choices from now on (once; returns off). */
export function followRowPrefs(): () => void {
  if (following) return following;
  const apply = () => {
    const state = appPluginState(CHAT_ROWS_PLUGIN_ID);
    const p = rowPrefs(state);
    setRowPrefs(p.disabled, p.chosen);
    setRowOptionValues(rowOptionValues(state));
    const t = translatorPrefs(state);
    setTranslatorPrefs(t.disabled, t.chosen);
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

const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** The row's element on screen (its index; the newest row with `last`). */
function rowEl(doc: Document, index: number | "last"): HTMLElement | null {
  if (index === "last") {
    const all = doc.querySelectorAll<HTMLElement>("[data-row]");
    return all[all.length - 1] ?? null;
  }
  return doc.querySelector<HTMLElement>(`[data-row="${index}"]`);
}

const lastLine = (t: string) => {
  const x = t.trimEnd().split("\n").pop() ?? "";
  return x.length > 140 ? x.slice(0, 139) + "…" : x;
};

/** The live tail on screen now (the chat pane draws it from these store fields: ./tail.tsx). */
function liveTail() {
  const s = useStore.getState();
  const tools = s.liveTools.map((t) => {
    const i = (t.input ?? {}) as Record<string, unknown>;
    const about = [i.path, i.file_path, i.command, i.pattern, i.url, i.query].find((v) => typeof v === "string") as string | undefined;
    return { name: t.name, running: !t.result, ...(about ? { about: about.slice(0, 140) } : {}) };
  });
  return {
    busy: s.busy,
    stream: { chars: s.streamingText.length, ...(s.streamingText ? { lastLine: lastLine(s.streamingText) } : {}) },
    reasoning: { chars: s.streamingReasoning.length },
    tools,
    renderers: Object.fromEntries(TAIL_KINDS.map((k) => [k, rowChain(k)[0]?.id ?? "fallback"])),
  };
}

/** The collapsible parts a row has (what toolRows opens). */
function collapsible(r: Record<string, unknown>): string[] {
  const k = String(r.kind ?? "");
  if (k === "voice-ask") return ["voice-ask"];
  if (k === "job") return ["job"];
  if (k === "divider") return ["divider"];
  if (k === "assistant") return [...(Array.isArray(r.tools) && r.tools.length ? ["tools"] : []), ...(r.thought ? ["thought"] : [])];
  return [];
}

export function chatRowsOffers(doc: Document = document) {
  return {
    state: {
      renderers: {
        description:
          "Each kind of row (user, assistant, notice, working, divider, job, voice, voice-ask, plan, tool-call, tool-call:<Tool>, inline-html; and the live tail while the agent works: stream = the reply as it streams, live-tool = the tool ticker, reasoning = the reasoning as it streams, thinking-indicator = the working pulse) with the renderer drawing it (active: builtin:<kind>, a plugin's <plugin id>#<kind>, or fallback = the plain text row) and every renderer registered for it (by, enabled, failures).",
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
      live: {
        description:
          "The live tail now (what streams under the rows while the agent works): busy, the streaming reply (chars and its last line), the streaming reasoning (chars), the turn's tool calls so far ({name, running, about}) and which renderer draws each tail kind.",
        read: () => liveTail(),
      },
      translators: {
        description:
          "What turns each event in the chat's log into rows (the step before the renderers): per event type (user, user:<via> such as user:job / user:wake, worker = a background worker's line, assistant, thinking, commentary = text beside a tool call, compaction, notice) the translator now active (builtin:<type>, an app alternative app:<type>:<name> such as app:commentary:thought, a plugin's <plugin id>#<type>) and every one registered (enabled, failures). A vault plugin adds one with api.host.chat.translate(type, (event, next) => messages | null).",
        read: () => describeTranslators(),
      },
      inline: {
        description: "What the chat shows inline: live web pages (kind web: id, url, title, loading, fullWindow, resting, height, a refused link's note) and vault pages (kind html: id, page, title, larger, height, inViewer). Change one with inline.",
        read: () => inlineFramesNow(),
      },
      rows: {
        description: "The rows drawn now (the newest 60): {index, kind, renderer, mid?, text (one line), tools?, open? (its collapsible parts open now: tools, thought, voice-ask, job, divider)}; total = messages in the chat, shownFrom = the first index drawn (older ones join on scroll).",
        read: () => {
          const v = visibleRows(60);
          return { ...v, rows: v.rows.map((r) => {
            const open = rowOpenParts(Number(r.index));
            return open.length ? { ...r, open } : r;
          }) };
        },
      },
    },
    watch: (fn: () => void) => {
      const offs = [subscribeRows(fn), subscribeTranslators(fn), useStore.subscribe(fn), useRowOpen.subscribe(fn), onInlineChanged(fn)];
      return () => offs.forEach((f) => f());
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
      disableTranslator: {
        description: "Turn a translator off by its id (see translators): its type is translated by the next in line (a user:<via> with none left: as a plain user line). Kept: every window, after a restart.",
        args: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const id = String(a.id);
          if (!translatorById(id)) throw new Error(`no chat translator "${id}" (see the translators state)`);
          return { disabled: id, ...(await keep([[TOFF + id, true]])) };
        },
      },
      enableTranslator: {
        description: "Turn a translator back on by its id (kept, like disableTranslator).",
        args: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const id = String(a.id);
          if (!translatorPrefs().disabled.includes(id) && !translatorById(id)) throw new Error(`no chat translator "${id}" (see the translators state)`);
          return { enabled: id, ...(await keep([[TOFF + id, null]])) };
        },
      },
      useTranslator: {
        description:
          "Choose which registered translator translates an event type (e.g. {type: \"commentary\", id: \"app:commentary:thought\"} folds text beside a tool call under Thought again; builtin:<type> over a plugin's); id omitted: back to the default order (newest plugin translator, else the app's own). Kept, like disableTranslator.",
        args: { type: "object", properties: { type: { type: "string" }, id: { type: "string" } }, required: ["type"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const type = String(a.type);
          const id = typeof a.id === "string" && a.id ? a.id : null;
          if (id) {
            const x = translatorById(id);
            if (!x || x.type !== type) throw new Error(`no translator "${id}" for type "${type}" (see the translators state)`);
          }
          const writes: [string, unknown][] = [[TUSE + type, id]];
          if (id && translatorPrefs().disabled.includes(id)) writes.push([TOFF + id, null]);
          return { type, using: id ?? "default", ...(await keep(writes)) };
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
      inline: {
        description: "Use an inline page's buttons (id from inline; left out: the newest): a web page's back, forward, reload, fullWindow {on}, browser (open in the browser), close, wake (show it again after it rested), resize {height}, dismissNote (a refused link's note), reopen (a closed page's show here); a vault page's larger {on}, resize {height}, openInViewer.",
        args: { type: "object", properties: { id: { type: "string" }, action: { type: "string", enum: ["back", "forward", "reload", "fullWindow", "browser", "close", "wake", "resize", "dismissNote", "reopen", "larger", "openInViewer"] }, on: { type: "boolean" }, height: { type: "number", minimum: 80 } }, required: ["action"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          await inlineAct(String(a.id ?? ""), String(a.action), a);
          return inlineFramesNow().find((f) => f.id === a.id) ?? { done: a.action };
        },
      },
      toolRows: {
        description: "Open or close the collapsible rows (a reply's tool calls and Thought, voice-ask work, job output, a summary divider), as a click on each: every one drawn, or the parts of the row at index. Kept as the rows' open state (rows: open).",
        args: { type: "object", properties: { open: { type: "boolean" }, index: { type: "integer" }, part: { type: "string", enum: ["tools", "thought", "voice-ask", "job", "divider"] } }, required: ["open"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          const { rows } = visibleRows(10_000);
          const want = a.index === undefined ? rows : rows.filter((r) => r.index === Number(a.index));
          if (!want.length) throw new Error(a.index === undefined ? "no chat rows on screen" : `row ${a.index} is not drawn`);
          let n = 0;
          for (const r of want) for (const part of collapsible(r)) if (a.part === undefined || a.part === part) {
            setRowOpen(rowKey(Number(r.index), part)!, a.open === true);
            n++;
          }
          return { rows: n, open: a.open === true };
        },
      },
    },
    events: {
      translatorsChanged: { description: "The translators changed (a plugin's registered or removed, one turned on or off or chosen): the active translator of each event type after it." },
      changed: { description: "The renderers changed (registered, removed, enabled, disabled or chosen, here or in another window): the active renderer of each kind after it." },
    },
  };
}

/** Headless (it draws nothing; the rows draw in the transcript): mounted in every layout by the "offers" place. */
export const offers = { mount };

export function mount(_el: HTMLElement, api: PluginApi): () => void {
  const offers = api.offer(chatRowsOffers(document));
  const off = subscribeRows(() => offers.emit("changed", Object.fromEntries(describeRows().map((k) => [k.kind, k.active]))));
  const offT = subscribeTranslators(() => offers.emit("translatorsChanged", Object.fromEntries(describeTranslators().map((k) => [k.type, k.active]))));
  return () => {
    off();
    offT();
  };
}
