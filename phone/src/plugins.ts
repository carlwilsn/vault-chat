// The phone app as a plugin host (reports/07 Track 2: every surface is a host of the same plugins, not a copy). The
// laptop's host pieces run here unchanged: the in-process mount host (src/mountHost.ts, the same `mount(el, api)`
// contract and api), the supervisor's records (src/pluginSupervisor.ts: "turn off X" takes it down here too), the chat
// row and translator registries (src/chatRows.ts, src/convlog/translators.ts) and the offers registry
// (src/pluginOffers.ts: the agent's PluginRead / PluginAct reach the phone's plugins with device "phone").
//
//   - Vault plugins whose meta names the phone (`export const meta = { devices: "laptop, phone" }`, src/vaultPlugins.ts)
//     are read from the box (GET /api/v2/plugin/device?device=phone) and mounted in the light DOM, fully trusted, with
//     api.device = "phone". A changed file is a fresh mount, a removed one is unmounted (its effects reverted).
//   - Their api.host.chat.row(kind, render) / chat.translate(type, fn) draw the phone's chat rows (boot.ts asks
//     rowRenderer() for each row; a throw falls back to the phone's own row, for that row only).
//   - app/chat-rows' kept choices (plugin.state records: renderers / translators off or chosen, the plan placement) are
//     followed here as on the laptop.
//   - The phone itself offers what it shows (app/phone: the open chat, the page, its plugins and their failures).
//
// Until the supervisor's records are known nothing is mounted (a plugin turned off never flashes on). With no plugin
// naming the phone, nothing here touches the page: the phone looks and loads as before (one small request after boot).
import { hostTheme, mountPlugin, type LoadModule, type PluginHandle, type PluginTheme } from "../../src/mountHost";
import { noHost, type HostBackend, type HostState } from "../../src/hostApi";
import { Supervisor, type SupervisorRecord } from "../../src/pluginSupervisor";
import { foldPluginState, type PluginState } from "../../src/pluginRecords";
import { chainFor, noteRowFailure, registerRow, rowChain, setRowPrefs, subscribeRows, toolChain, type RowData } from "../../src/chatRows";
import { registerTranslator, setTranslatorPrefs, subscribeTranslators, type Translator } from "../../src/convlog/translators";
import { answerPluginSignal, declareOffers, type PluginSignal } from "../../src/pluginOffers";
import { rowOptionValues, rowPrefs, translatorPrefs } from "../../src/plugins/chat-rows/prefs";
import { CHAT_ROWS_PLUGIN_ID } from "../../src/appPlugins";
import { VAULT_PLUGIN_DIR } from "../../src/vaultPlugins";

type Api = (path: string, opts?: RequestInit) => Promise<Response>;
export type PhonePlugin = { id: string; name: string; code: string };
export type PhoneHostDeps = {
  api: Api;
  toast: (text: string) => void;
  /** What the phone shows now (the agent's app/phone state). */
  where: () => { page: string; chat: string | null; title: string };
  /** Open a chat (app/phone's openChat). */
  openChat?: (id: string) => void;
  /** The chat must be drawn again: `rows` true when a renderer or translator changed (every row is drawn afresh),
   *  false when only a kept option did. */
  redraw: (rows: boolean) => void;
  /** How often the plugin list is read again while the phone is on screen (ms). */
  everyMs?: number;
  /** Tests: how a plugin's code is loaded, the window's listeners, the theme. */
  load?: LoadModule;
  win?: Parameters<typeof mountPlugin>[2]["win"];
  theme?: () => PluginTheme;
};

export const PHONE_PLUGIN_ID = "app/phone";

type Mounted = { p: PhonePlugin; el: HTMLElement; handle: PluginHandle; error: string | null; draft?: string };
type Tried = { id: string; name: string; version: string; code: string; fail: (why: string) => void; kept?: boolean };

export type PhoneHost = {
  /** Vault-level records of the feed (supervisor and plugin.state ones are folded; the rest ignored). */
  fold(recs: readonly SupervisorRecord[]): void;
  /** A file changed on the box: a plugin file means the list is read again. */
  fileChanged(path: string): void;
  /** The agent's {type:"plugin", to:"phone"} signal: the ack's body. */
  answer(sig: PluginSignal): ReturnType<typeof answerPluginSignal>;
  /** Draw a chat row with a plugin's renderer, if one draws its kind: the element, or null (the phone's own row). */
  rowElement(row: RowData): HTMLElement | null;
  /** Draw one tool call of a reply with a plugin's renderer into `el`: whether it did. */
  toolInto(el: HTMLElement, tool: { name?: string } & Record<string, unknown>, index: number): boolean;
  /** A kept renderer option (app/chat-rows opt:<kind>:<key>), or undefined. */
  option(kind: string, key: string): unknown;
  /** Run a row element's cleanup (the row left the screen or was redrawn). */
  release(el: Element): void;
  /** What is mounted now (tests, the agent). `draft`: the version of a draft tried here in place of the live copy. */
  mounted(): { id: string; name: string; error: string | null; draft?: string }[];
  /**
   * Try a plugin's draft on this phone only (Change ready, phone/src/changes.ts): its code mounts in place of the live
   * copy (or as a new plugin) until Keep, Discard or Back; null stops trying. `fail` runs once when the draft throws or
   * does not load (the phone falls back to the live copy at once).
   */
  tryDraft(t: { id: string; name: string; version: string; code: string; fail: (why: string) => void } | null): void;
  /** The draft tried here was kept: it stays mounted (no flash back to the old copy) until the box lists it as live. */
  keptDraft(): void;
  stop(): void;
};

const cleanups = new WeakMap<Element, () => void>();

export function startPhoneHost(d: PhoneHostDeps): PhoneHost {
  const sup = new Supervisor();
  let known = false;
  const states = new Map<string, PluginState>();
  const mounted = new Map<string, Mounted>();
  let list: PhonePlugin[] = [];
  let listed = false;
  let stopped = false;
  let reading = false;
  let again = false;
  let redrawQueued = false;
  let tried: Tried | null = null;

  const queueRedraw = () => {
    if (redrawQueued) return;
    redrawQueued = true;
    queueMicrotask(() => {
      redrawQueued = false;
      try {
        d.redraw(true);
      } catch {
        /* the phone's own problem */
      }
    });
  };
  const offRows = subscribeRows(queueRedraw);
  const offTranslators = subscribeTranslators(queueRedraw);

  // ---- app/chat-rows' kept choices
  function applyPrefs() {
    const state = states.get(CHAT_ROWS_PLUGIN_ID)?.state ?? {};
    const p = rowPrefs(state);
    setRowPrefs(p.disabled, p.chosen);
    const t = translatorPrefs(state);
    setTranslatorPrefs(t.disabled, t.chosen);
    try {
      d.redraw(false);
    } catch {
      /* the phone's own problem */
    }
  }
  async function loadStates() {
    try {
      const r = await d.api("/api/v2/plugin/app-state?plugin=" + encodeURIComponent(CHAT_ROWS_PLUGIN_ID));
      if (!r.ok) return;
      const b = (await r.json()) as { states?: Record<string, PluginState>; seq?: number; state?: Record<string, unknown>; epoch?: string };
      const s: PluginState | null = b.states?.[CHAT_ROWS_PLUGIN_ID] ?? (b.state && typeof b.state === "object" ? { seq: Number(b.seq) || 0, state: b.state, ...(b.epoch ? { epoch: b.epoch } : {}) } : null);
      if (!s || (states.get(CHAT_ROWS_PLUGIN_ID)?.seq ?? -1) >= s.seq) return;
      states.set(CHAT_ROWS_PLUGIN_ID, { seq: s.seq, state: { ...s.state }, ...(typeof s.epoch === "string" && s.epoch ? { epoch: s.epoch } : {}) });
      applyPrefs();
    } catch {
      /* an older box, or offline: the phone's own rows */
    }
  }

  // ---- the supervisor
  async function loadSupervisor() {
    for (let i = 0; i < 10 && !stopped; i++) {
      try {
        const r = await d.api("/api/v2/supervisor");
        if (r.ok) {
          const b = (await r.json()) as { records?: SupervisorRecord[] };
          for (const rec of b.records ?? []) sup.fold(rec);
          known = true;
          reconcile();
          return;
        }
        if (r.status === 404) break; // an older box: no supervisor, every plugin runs
      } catch {
        /* offline: again in a moment */
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
    known = true;
    reconcile();
  }
  const running = (id: string) => sup.desired(id, Date.now()).state === "running";

  // ---- the plugins
  const root = () => {
    let el = document.getElementById("vc-phone-plugins");
    if (!el) {
      el = document.createElement("div");
      el.id = "vc-phone-plugins";
      el.setAttribute("data-el", "phone-plugins");
      el.style.display = "contents";
      document.body.appendChild(el);
    }
    return el;
  };
  const backend: HostBackend = {
    ...noHost,
    state: (() => {
      let last: HostState | null = null;
      return () => {
        const w = d.where();
        if (last && last.openChatId === w.chat) return last;
        return (last = { ...noHost.state(), openChatId: w.chat });
      };
    })(),
    theme: () => (d.theme ?? hostTheme)(),
    notify: (text) => {
      d.toast(String(text ?? ""));
      return () => {};
    },
    registerChatRow: (kind, render, by, opts) => registerRow(kind, render, by, opts),
    registerChatTranslator: (type, fn, by) => registerTranslator(type, fn as Translator, by),
  };
  function mountOne(p: PhonePlugin, draft?: Tried): Mounted {
    const el = document.createElement("span");
    el.setAttribute("data-el", "plugin-mount");
    el.setAttribute("data-vc-plugin", p.id);
    el.style.display = "contents";
    root().appendChild(el);
    const m: Mounted = { p, el, handle: null as unknown as PluginHandle, error: null, ...(draft ? { draft: draft.version } : {}) };
    m.handle = mountPlugin(el, { name: p.name, code: p.code }, {
      path: p.id,
      theme: () => (d.theme ?? hostTheme)(),
      host: backend,
      ...(d.load ? { load: d.load } : {}),
      ...(d.win ? { win: d.win } : {}),
      extend: () => ({ device: "phone" }),
      onError: (msg) => {
        m.error = msg;
        console.warn(`[plugin] ${p.id} stopped on the phone:`, msg);
        // A draft tried here that throws or does not load: back to the live copy now, and Change ready says why.
        if (draft && tried === draft) {
          tried = null;
          queueMicrotask(() => {
            reconcile();
            try {
              draft.fail(msg);
            } catch {
              /* the card's own problem */
            }
          });
        }
      },
    });
    return m;
  }
  function unmountOne(m: Mounted) {
    try {
      m.handle.unmount();
    } catch {
      /* already gone */
    }
    m.el.remove();
  }
  function reconcile() {
    if (stopped || !known || !listed) return;
    const want = new Map(list.filter((p) => running(p.id)).map((p) => [p.id, p]));
    // A draft Carl tries here runs in place of the live copy (a plugin turned off stays off).
    // A kept draft is the live copy once the box lists it so.
    if (tried?.kept && want.get(tried.id)?.code === tried.code) tried = null;
    const t = tried && running(tried.id) ? tried : null;
    if (t) want.set(t.id, { id: t.id, name: t.name, code: t.code });
    for (const [id, m] of [...mounted]) {
      const w = want.get(id);
      if (!w || w.code !== m.p.code || w.name !== m.p.name) {
        unmountOne(m);
        mounted.delete(id);
      } else if (t?.id !== id) delete m.draft;
    }
    for (const [id, p] of want) if (!mounted.has(id)) mounted.set(id, mountOne(p, t?.id === id ? t : undefined));
  }
  async function readList() {
    if (reading) return void (again = true);
    reading = true;
    try {
      const r = await d.api("/api/v2/plugin/device?device=phone");
      if (r.ok) {
        const b = (await r.json()) as { plugins?: PhonePlugin[] };
        list = (b.plugins ?? []).filter((p) => p && typeof p.id === "string" && typeof p.code === "string");
        listed = true;
        reconcile();
      } else if (r.status === 404) {
        listed = true; // an older box: no plugins for the phone
      }
    } catch {
      /* offline: the next look */
    } finally {
      reading = false;
      if (again) {
        again = false;
        void readList();
      }
    }
  }

  // ---- the phone's own offers (app/phone)
  const own = declareOffers(PHONE_PLUGIN_ID, "Phone", {
    state: {
      showing: { description: "What the phone shows now: its page (chat, alerts, ...) and the open chat.", read: () => d.where() },
      plugins: { description: "The vault plugins mounted on the phone (meta devices names the phone) and why one stopped.", read: () => host.mounted() },
      rows: { description: "Which plugin renderer draws each kind of chat row on the phone (none: the phone's own).", read: () => rowKindsOnPhone() },
    },
    actions: {
      openChat: {
        description: "Open a chat on the phone by its id (Main is \"main\").",
        args: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        run: (a) => {
          if (!d.openChat) throw new Error("this phone can't open chats");
          d.openChat(String(a.id));
          return { opened: String(a.id) };
        },
      },
      reloadPlugins: { description: "Read the phone's plugin list from the box again and mount what changed.", run: async () => (await readList(), host.mounted()) },
    },
  });

  function rowKindsOnPhone(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of ["user", "assistant", "notice", "working", "divider", "job", "voice", "voice-ask", "tool-call"]) {
      const top = rowChain(k).find((x) => !x.builtin && x.dom);
      out[k] = top ? top.id : "phone";
    }
    return out;
  }

  function draw(chain: readonly { id: string; builtin: boolean; dom?: (el: HTMLElement, row: RowData) => void | (() => void) }[], el: HTMLElement, row: RowData): boolean {
    for (const r of chain) {
      if (r.builtin || !r.dom) continue;
      try {
        el.replaceChildren();
        const out = r.dom(el, row);
        if (typeof out === "function") cleanups.set(el, out);
        el.setAttribute("data-vc-row-renderer", r.id);
        return true;
      } catch (e) {
        noteRowFailure(r.id, e);
      }
    }
    el.replaceChildren();
    return false;
  }

  const timer = setInterval(() => {
    if (document.visibilityState === "visible") {
      void readList();
      reconcile(); // a word with a later `from` comes into effect
    }
  }, d.everyMs ?? 15_000);
  const onVisible = () => document.visibilityState === "visible" && void readList();
  document.addEventListener("visibilitychange", onVisible);

  const host: PhoneHost = {
    fold(recs) {
      let sv = false;
      let st = false;
      for (const r of recs) {
        if ((r as { conv?: unknown }).conv !== null && (r as { conv?: unknown }).conv !== undefined) continue;
        if (sup.fold(r)) sv = true;
        const s = r.type === "signal" ? (r.signal as { plugin?: unknown } | undefined) : undefined;
        if (s?.plugin === CHAT_ROWS_PLUGIN_ID && (states.get(CHAT_ROWS_PLUGIN_ID)?.seq ?? -1) < r.seq && foldPluginState(states, r)) st = true;
      }
      if (sv) reconcile();
      if (st) applyPrefs();
    },
    fileChanged(path) {
      if (String(path ?? "").replace(/\\/g, "/").startsWith(VAULT_PLUGIN_DIR + "/")) void readList();
    },
    answer: (sig) => answerPluginSignal(sig),
    rowElement(row) {
      const chain = chainFor(rowChain(row.kind), row);
      if (!chain.some((x) => !x.builtin && x.dom)) return null;
      const el = document.createElement("div");
      el.className = "prow";
      el.setAttribute("data-el", "plugin-row");
      el.setAttribute("data-kind", row.kind);
      return draw(chain, el, row) ? el : null;
    },
    toolInto(el, tool, index) {
      const name = String(tool?.name ?? "");
      const row: RowData = { kind: "tool-call", index, tool };
      const chain = chainFor(toolChain(name), row);
      if (!chain.some((x) => !x.builtin && x.dom)) return false;
      const text = el.textContent;
      if (draw(chain, el, row)) return true;
      el.textContent = text;
      return false;
    },
    option(kind, key) {
      return rowOptionValues(states.get(CHAT_ROWS_PLUGIN_ID)?.state ?? {})[kind]?.[key];
    },
    release(el) {
      for (const c of [el, ...Array.from(el.querySelectorAll("[data-vc-row-renderer]"))]) {
        const f = cleanups.get(c);
        if (!f) continue;
        cleanups.delete(c);
        try {
          f();
        } catch {
          /* a renderer's cleanup */
        }
      }
    },
    mounted: () => [...mounted.values()].map((m) => ({ id: m.p.id, name: m.p.name, error: m.handle.error ?? m.error, ...(m.draft ? { draft: m.draft } : {}) })),
    tryDraft(t) {
      if ((tried?.id ?? null) === (t?.id ?? null) && (tried?.version ?? null) === (t?.version ?? null)) return;
      tried = t ? { ...t } : null;
      reconcile();
    },
    keptDraft() {
      if (!tried) return;
      tried.kept = true;
      void readList();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      for (const m of mounted.values()) unmountOne(m);
      mounted.clear();
      own.undo();
      offRows();
      offTranslators();
    },
  };

  void loadSupervisor();
  void loadStates();
  void readList();
  return host;
}
