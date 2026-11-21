// Carl's screen across a core swap (src/coreBundle.ts; src/coreFollow.ts followCoreOnce): the loader serves
// the new bundle and the window loads it, so what only lived in this page would go. Before the swap the main window
// keeps, in its sessionStorage (it survives the load, per window), the open chat, the chat's scroll (at the bottom, or
// where he was), the composer's draft (text, mentions, pictures, files), the panes (files, split, which is active, view
// or edit, unsaved text), the side panels and full-screen chat.
// On that load index.html shows no splash and keeps the new screen hidden (html.vc-swapping), so nothing new is
// painted and the webview keeps the old frame up (Chromium's paint holding: a same-origin load shows the old page
// until the new one first paints content); the new bundle puts everything back once its vault and chats are loaded
// (restoreAfterSwap, main.tsx) and only then shows itself. A swap older than SWAP_MAX_MS is not restored (a crash, a
// later launch: a fresh start). A picture of the old screen (src/screenCapture.ts) was tried and dropped: its fonts and
// layout are close, not the same, so the hand-over showed a jump.
import { useStore, type Pane, type SplitDirection } from "./store";

/** index.html reads this key by name before any script loads: keep the two in step. */
export const SWAP_KEY = "vc.coreSwap";
export const SWAP_MAX_MS = 60_000;
/** Pane text kept as it is (unsaved edits included) up to this much in all; over it the files are read again. */
const PANE_TEXT_MAX = 1_500_000;

export type SwapState = {
  at: number;
  vault: string | null;
  conv: string | null;
  scroll: { top: number; atBottom: boolean } | null;
  draft: { input: string; mentions: unknown[]; images: unknown[]; files: unknown[] } | null;
  panes: { file: string; mode: Pane["mode"]; content: string | null }[];
  split: SplitDirection;
  active: number;
  currentFile: string | null;
  currentContent: string | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  chatFullscreen: boolean;
};

const ss = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

const chatScroller = (): HTMLElement | null => (typeof document !== "undefined" ? (document.querySelector('[data-el="chat-scroll"]') as HTMLElement | null) : null);

/** What the window shows now (pure over the store and the DOM; the composer's draft is passed in). */
export function swapStateNow(draft: SwapState["draft"], now = Date.now()): SwapState {
  const s = useStore.getState();
  const keepText = s.panes.reduce((n, p) => n + (p.content?.length ?? 0), 0) <= PANE_TEXT_MAX;
  const el = chatScroller();
  return {
    at: now,
    vault: s.vaultPath,
    conv: s.activeConversationId,
    scroll: el ? { top: el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 40 } : null,
    draft,
    panes: s.panes.map((p) => ({ file: p.file, mode: p.mode, content: keepText ? p.content : null })),
    split: s.splitDirection,
    active: Math.max(0, s.panes.findIndex((p) => p.id === s.activePaneId)),
    currentFile: s.currentFile,
    currentContent: s.currentContent.length <= PANE_TEXT_MAX ? s.currentContent : null,
    leftCollapsed: s.leftCollapsed,
    rightCollapsed: s.rightCollapsed,
    chatFullscreen: s.chatFullscreen,
  };
}

/** Before the loader swaps the bundle (main window): keep the screen's state. Never throws. */
export async function saveSwapState(): Promise<SwapState | null> {
  const store = ss();
  if (!store) return null;
  let draft: SwapState["draft"] = null;
  try {
    const { useDraft } = await import("./plugins/composer/draft");
    const d = useDraft.getState();
    draft = { input: d.input, mentions: d.mentions, images: d.images, files: d.files };
  } catch {
    /* no composer here */
  }
  const st = swapStateNow(draft);
  // The load that follows is on purpose: the window's leave guard (src/linkNav.ts) stands aside for it.
  if (typeof window !== "undefined") (window as { __vcCoreSwapping?: boolean }).__vcCoreSwapping = true;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("vc-core-swapping");
  } catch {
    /* no other windows to tell */
  }
  try {
    store.setItem(SWAP_KEY, JSON.stringify(st));
  } catch {
    // Too big (pictures in the draft, long panes): the rest without them.
    try {
      store.setItem(SWAP_KEY, JSON.stringify({ ...st, draft: draft ? { ...draft, images: [], files: [] } : null, panes: st.panes.map((p) => ({ ...p, content: null })), currentContent: null }));
    } catch {
      return null;
    }
  }
  return st;
}

/** The kept state, once (it is removed), or null when none or too old. */
export function takeSwapState(now = Date.now()): SwapState | null {
  const store = ss();
  if (!store) return null;
  let st: SwapState | null = null;
  try {
    const raw = store.getItem(SWAP_KEY);
    st = raw ? (JSON.parse(raw) as SwapState) : null;
  } catch {
    st = null;
  }
  store.removeItem(SWAP_KEY);
  return st && typeof st.at === "number" && Math.abs(now - st.at) <= SWAP_MAX_MS ? st : null;
}

/** Show the new screen (index.html kept it hidden on a swap's load). */
export function revealAfterSwap(): void {
  if (typeof document !== "undefined") document.documentElement.classList.remove("vc-swapping");
}

export type RestoreDeps = {
  /** A file's text (the panes whose text was not kept). */
  read: (path: string) => Promise<string>;
  /** Wait until the vault's chats are loaded (the open chat can be picked). */
  chatsLoaded: () => Promise<void>;
  setDraft: (d: NonNullable<SwapState["draft"]>) => void;
  /** Frames to wait for the transcript to lay out before scrolling. */
  frame: () => Promise<void>;
};

/** Put back what the window showed before the swap. What it can't (a file gone, a chat deleted since) is left as the
 *  new start has it. Returns what it put back, for the log. */
export async function restoreSwapState(st: SwapState, d: RestoreDeps): Promise<string[]> {
  const done: string[] = [];
  const s = useStore.getState();
  if (st.vault && s.vaultPath !== st.vault) return done; // another vault opened since: nothing of it applies
  const panes: Pane[] = [];
  for (const p of st.panes) {
    try {
      panes.push({ id: `p_${Math.random().toString(36).slice(2)}`, file: p.file, mode: p.mode, content: p.content ?? (await d.read(p.file)) });
    } catch {
      /* gone since */
    }
  }
  if (panes.length >= 2) {
    const a = panes[Math.min(st.active, panes.length - 1)]!;
    useStore.setState({ panes, splitDirection: st.split, activePaneId: a.id, currentFile: a.file, currentContent: a.content });
    done.push("panes");
  } else if (st.currentFile) {
    try {
      useStore.getState().setCurrentFile(st.currentFile, st.currentContent ?? (await d.read(st.currentFile)));
      done.push("file");
    } catch {
      /* gone since */
    }
  }
  useStore.setState({ leftCollapsed: st.leftCollapsed, rightCollapsed: st.rightCollapsed, chatFullscreen: st.chatFullscreen });
  if (st.draft && (st.draft.input || st.draft.mentions.length || st.draft.images.length || st.draft.files.length)) {
    d.setDraft(st.draft);
    done.push("draft");
  }
  if (st.conv) {
    await d.chatsLoaded();
    if (useStore.getState().conversations.some((c) => c.id === st.conv)) {
      if (useStore.getState().activeConversationId !== st.conv) useStore.getState().selectConversation(st.conv);
      done.push("chat");
    }
  }
  if (st.scroll) {
    await d.frame();
    const el = chatScroller();
    if (el) {
      el.scrollTop = st.scroll.atBottom ? el.scrollHeight : st.scroll.top;
      done.push("scroll");
    }
  }
  return done;
}

/** Main window, at start: a swap just happened here, so put the screen back, then show it. */
export async function restoreAfterSwap(): Promise<void> {
  const mark = (v: string) => typeof document !== "undefined" && document.documentElement.setAttribute("data-vc-core-swap", v);
  const st = takeSwapState();
  if (!st) {
    mark("none");
    revealAfterSwap();
    return;
  }
  mark("restoring");
  const until = (ok: () => boolean, ms: number) =>
    new Promise<void>((resolve) => {
      const end = Date.now() + ms;
      const look = () => (ok() || Date.now() > end ? resolve() : setTimeout(look, 50));
      look();
    });
  try {
    await until(() => !!useStore.getState().vaultPath, 8000);
    const [{ readTextAt }, draftMod] = await Promise.all([import("./boxFiles"), import("./plugins/composer/draft")]);
    const done = await restoreSwapState(st, {
      read: (p) => readTextAt(p),
      chatsLoaded: () => until(() => useStore.getState().conversations.some((c) => c.id === st.conv) || (useStore.getState().conversationsLoaded && useStore.getState().conversations.length > 0), 8000),
      setDraft: (x) => draftMod.useDraft.setState({ input: x.input, mentions: x.mentions as never, images: x.images as never, files: x.files as never }),
      frame: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    });
    console.info(`[core] after the swap, put back: ${done.join(", ") || "nothing"}`);
    mark(done.join(",") || "nothing");
  } catch (e) {
    mark(`failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    console.warn("[core] could not put the screen back after the swap:", e);
  } finally {
    revealAfterSwap();
  }
}
