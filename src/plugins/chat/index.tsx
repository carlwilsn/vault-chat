// The chat pane plugin (Track 1; src/appPlugins.ts CHAT_PLUGIN_ID): the pane's header (./Header.tsx: the chat's name,
// the cost, the ⋯ menu with Memory and plugins' entries) and its transcript (./Transcript.tsx: the box starting / no-box
// screens, the window of messages, jump-to-latest, the background-task strip, the ongoing-work line), mounted through
// the plugin host under the supervisor's records like the title bar and the composer. src/ChatHeader.tsx mounts the
// header: docked, as the pane's top row (`mount`); in fullscreen chat and the popout, in the window's top bar (`bar`).
// src/ChatPane.tsx mounts the transcript (`transcript`), which holds the docked header's slot. Turned off or failing,
// a plain header stands in (the chat's name and a Memory button, with Turn on / Reload); the transcript is drawn in the
// app's tree while the records are unknown or the plugin is off, and a plain one stands in if it fails. The
// transcript's rows are app/chat-rows; the composer is app/composer.
//
// Its slot: a vault plugin adds an entry to the ⋯ menu live with api.host.chat.menuItem({...}) (src/chatMenuItems.ts),
// gone when that plugin stops.
//
// It declares what it offers (api.offer, src/pluginOffers.ts): the open chat, the view (docked, full screen, popped out;
// Settings in its place; the box starting or out of reach), the scroll, the running background tasks, the ongoing-work
// line, the menu and which memory Memory opens as state; open / close the menu, open the memory, click a plugin's entry,
// scroll to the newest, show older messages, go back to a worker's parent, open / stop / steer a background task and
// open Settings → Box as actions; what happened as events. Each mounted part declares them (the newest answers).
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import type { PluginApi } from "../../mountHost";
import { useStore } from "../../store";
import { isPopout } from "../../windowKind";
import { chatGateOf } from "../../chatGate";
import { threadKindOf } from "../../threads";
import { chatMenuItemNamed, chatMenuItems, subscribeChatMenuItems, type ChatMenuItem } from "../../chatMenuItems";
import { taskActivity, taskElapsed, taskName, taskState } from "../../backgroundTasks";
import { ongoingText, ongoingWork } from "../../ongoingWork";
import { uiChoice } from "../../uiChoices";
import { boxSubagent } from "../../boxChat";
import { BarTitle, DockHeader } from "./Header";
import { Transcript, openBoxSettings } from "./Transcript";
import { emitChatEvent, memoryTarget, onChatEvent, openChatMemory, paneScroll, setMenuOpen, useChatMenu } from "./model";

const shownItem = (i: ChatMenuItem) => ({ key: i.key, id: i.id, by: i.by, label: i.label, ...(i.title ? { title: i.title } : {}) });
const OPEN = { type: "object", properties: { open: { type: "boolean", description: "true: open it, false: close it; left out: toggle." } }, additionalProperties: false };

/** The plugin's offers (exported for tests). */
export function chatOffers() {
  const S = () => useStore.getState();
  const active = () => {
    const s = S();
    return s.conversations.find((c) => c.id === s.activeConversationId);
  };
  const needPane = () => {
    const p = paneScroll();
    if (!p) throw new Error(S().showSettings ? "Settings is open in the chat's place" : "no chat is on screen");
    return p;
  };
  const running = () => (active()?.subagents ?? []).filter((t) => taskState(t) === "running");
  const runningTask = (id: unknown) => {
    const all = running();
    const t = all.find((x) => x.threadId === String(id ?? ""));
    if (!t) throw new Error(`no running background task "${String(id ?? "")}"${all.length ? ` (running: ${all.map((x) => x.threadId).join(", ")})` : " (none is running)"}`);
    return t;
  };
  const control = async (id: unknown, op: "steer" | "stop", text?: string) => {
    const t = runningTask(id);
    const why = await boxSubagent(S().activeConversationId ?? "", t.threadId, op, text);
    if (why) throw new Error(why);
    return { [op === "stop" ? "stopped" : "steered"]: t.threadId };
  };
  const TASK = { type: "object", properties: { id: { type: "string", description: "The task's id (tasks: id)." } }, required: ["id"], additionalProperties: false };
  return {
    state: {
      chat: {
        description: "The open chat: id, title, kind (main, project, separate, older), project (its slug or null), busy (the agent is working), messages (how many).",
        read: () => {
          const s = S();
          const c = active();
          const id = s.activeConversationId;
          return {
            id,
            title: c?.title ?? null,
            kind: id ? threadKindOf({ id, kind: c?.kind }) : null,
            project: c?.project ?? null,
            busy: s.busy,
            messages: s.messages.length,
          };
        },
      },
      view: {
        description: "How the chat is shown: where (docked, fullscreen, popout, hidden), settings (Settings drawn in its place), gate (ready, starting, noBox, boxDown with why, archived: an older chat, read only).",
        read: () => {
          const s = S();
          const where = isPopout ? "popout" : s.popoutOpen ? "popout" : s.chatFullscreen ? "fullscreen" : s.rightCollapsed ? "hidden" : "docked";
          const g = chatGateOf(s);
          return { where, settings: s.showSettings, gate: g.starting ? "starting" : g.noBox ? "noBox" : g.boxDown ? "boxDown" : g.archived ? "archived" : "ready", ...(g.boxDown && g.reason ? { why: g.reason } : {}) };
        },
      },
      scroll: {
        description: "The transcript's scroll: atBottom (following the newest), shown (messages drawn), total, older (not drawn yet: showOlder draws them), jump (the 'new messages' button is shown); null when no chat is on screen.",
        read: () => paneScroll()?.state() ?? null,
      },
      tasks: {
        description: "The background tasks running for the open chat, as the strip above the composer shows them: id, name, activity (its latest step), elapsedMs.",
        read: () => {
          const now = Date.now();
          return running().map((t) => ({ id: t.threadId, name: taskName(t), activity: taskActivity(t), elapsedMs: taskElapsed(t, now) }));
        },
      },
      ongoing: {
        description: "The ongoing-work line above the composer (a chat waiting on its own schedule, waiting for Carl, blocked, or done with the verifier's verdict): tone (waiting, you, blocked, done) and text; null when it is not shown.",
        read: () => {
          const c = active();
          if (!c) return null;
          const o = ongoingWork({ ...c, messages: S().messages, ...(uiChoice("cost") !== "reply" ? { costUsd: undefined } : {}) }, Date.now(), undefined, uiChoice("verdict") === "ongoing");
          return o ? { tone: o.tone, text: ongoingText(o) } : null;
        },
      },
      menu: {
        description: "The ⋯ menu: open, and the entries vault plugins put there (api.host.chat.menuItem): key, id, by, label, title. Memory is always first.",
        read: () => ({ open: useChatMenu.getState().open, items: chatMenuItems().map(shownItem) }),
      },
      memory: {
        description: "Which memory the menu's Memory opens for this chat: kind main (.vault-chat/MEMORY.md, for Main and chats in no project) or project (slug, name: the project's memory).",
        read: () => {
          const t = memoryTarget();
          return t.kind === "main" ? { kind: "main", file: t.file } : { kind: "project", slug: t.slug, name: t.name };
        },
      },
    },
    actions: {
      openMenu: {
        description: "Open (or close) the ⋯ menu on screen.",
        args: OPEN,
        run: (a: Record<string, unknown>) => {
          setMenuOpen(typeof a.open === "boolean" ? a.open : !useChatMenu.getState().open);
          return { open: useChatMenu.getState().open };
        },
      },
      openMemory: {
        description: "Open this chat's memory in the viewer (as the menu's Memory): Main's, or the chat's project's. Fullscreen chat leaves for the viewer.",
        run: async () => {
          const { target, path } = await openChatMemory();
          return { kind: target.kind, ...(target.kind === "project" ? { project: target.slug } : {}), path };
        },
      },
      clickItem: {
        description: "Click a plugin's entry in the ⋯ menu (its key, or its id or label when that names one entry).",
        args: { type: "object", properties: { item: { type: "string" } }, required: ["item"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          const it = chatMenuItemNamed(String(a.item ?? ""));
          if (!it) {
            const all = chatMenuItems();
            throw new Error(`no menu entry "${String(a.item ?? "")}"${all.length ? ` (entries: ${all.map((i) => i.key).join(", ")})` : " (no plugin has put one there; Memory is openMemory)"}`);
          }
          setMenuOpen(false);
          it.onClick();
          emitChatEvent("itemClicked", { key: it.key, by: it.by });
          return { clicked: it.key };
        },
      },
      scrollToBottom: {
        description: "Scroll the transcript to the newest message (and follow it), as the 'new messages' button.",
        run: () => {
          const p = needPane();
          p.toBottom();
          emitChatEvent("scrolled", { to: "bottom" });
          return p.state();
        },
      },
      showOlder: {
        description: "Draw older messages above (count, default 60; all: every one) as scrolling up does; top true also scrolls to the top.",
        args: { type: "object", properties: { count: { type: "integer", minimum: 1 }, all: { type: "boolean" }, top: { type: "boolean" } }, additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          const p = needPane();
          p.older(a.all === true ? "all" : typeof a.count === "number" ? a.count : 60, a.top === true);
          emitChatEvent("scrolled", { to: a.top === true ? "top" : "older" });
          return p.state();
        },
      },
      openParent: {
        description: "Back to the chat that started this worker (the 'Back to' link), when the open chat is a worker's.",
        run: () => {
          const s = S();
          const parent = s.conversations.find((c) => c.subagents?.some((x) => x.kind !== "job" && x.threadId === s.activeConversationId));
          if (!parent) throw new Error("the open chat is not a worker's");
          s.selectConversation(parent.id);
          return { opened: parent.id };
        },
      },
      openTask: {
        description: "Open a running background task's own chat (as clicking it in the strip).",
        args: TASK,
        run: (a: Record<string, unknown>) => {
          const t = runningTask(a.id);
          S().selectConversation(t.threadId);
          return { opened: t.threadId };
        },
      },
      stopTask: {
        description: "Stop a running background task (the strip's Stop).",
        args: TASK,
        run: (a: Record<string, unknown>) => control(a.id, "stop"),
      },
      steerTask: {
        description: "Send a running background task a message (the strip's Steer).",
        args: { type: "object", properties: { id: { type: "string", description: "The task's id (tasks: id)." }, text: { type: "string" } }, required: ["id", "text"], additionalProperties: false },
        run: (a: Record<string, unknown>) => control(a.id, "steer", String(a.text ?? "")),
      },
      openBoxSettings: {
        description: "Open Settings at its Box section (the no-box screen's button).",
        run: () => {
          openBoxSettings();
          return { open: true };
        },
      },
    },
    events: {
      menuOpened: { description: "The ⋯ menu opened." },
      memoryOpened: { description: "Memory was opened: kind (main, project), project, path." },
      itemClicked: { description: "A plugin's menu entry was clicked: key, by." },
      itemAdded: { description: "A plugin put an entry in the menu: key, by, label." },
      itemRemoved: { description: "An entry left the menu (its plugin stopped or removed it): key, by." },
      scrolled: { description: "The agent scrolled the transcript: to (bottom, older, top)." },
      olderShown: { description: "Carl scrolled up and older messages were drawn above: by, shown." },
      jumped: { description: "Carl clicked 'new messages' to go back to the newest." },
      tasksChanged: { description: "The running background tasks changed: running (how many)." },
    },
  };
}

function mountSurface(el: HTMLElement, api: PluginApi, view: () => ReactNode): () => void {
  let alive = true;
  const offers = api.offer(chatOffers());
  api.effect(onChatEvent((name, data) => offers.emit(name, data)));
  let known = new Map(chatMenuItems().map((i) => [i.key, i] as const));
  api.effect(
    subscribeChatMenuItems(() => {
      const now = new Map(chatMenuItems().map((i) => [i.key, i] as const));
      for (const [k, i] of now) if (known.get(k) !== i) offers.emit("itemAdded", { key: k, by: i.by, label: i.label });
      for (const [k, i] of known) if (!now.has(k)) offers.emit("itemRemoved", { key: k, by: i.by });
      known = now;
    }),
  );
  // A render error the part does not catch is the plugin's failure (src/ChatHeader.tsx, src/ChatPane.tsx then show their fallback).
  const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
  // Drawn right after the app's commit (before the browser paints: the pane never lacks its header), unmounted outside it.
  queueMicrotask(() => alive && flushSync(() => root.render(view())));
  return () => {
    alive = false;
    setMenuOpen(false);
    queueMicrotask(() => root.unmount());
  };
}

/** The docked pane's header row. */
export function mount(el: HTMLElement, api: PluginApi): () => void {
  return mountSurface(el, api, () => <DockHeader />);
}

/** Fullscreen chat's (and the popout's) top bar: the chat's name and ⋯. */
export const bar = { mount: (el: HTMLElement, api: PluginApi) => mountSurface(el, api, () => <BarTitle />) };

/** The pane's transcript (src/ChatPane.tsx mounts it in the pane, under its own header slot). */
export const transcript = { mount: (el: HTMLElement, api: PluginApi) => mountSurface(el, api, () => <Transcript />) };
