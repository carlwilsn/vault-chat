import { useEffect, useMemo, useRef, useState } from "react";
import { Allotment, LayoutPriority, type AllotmentHandle } from "allotment";
import { invoke } from "@tauri-apps/api/core";
import { openTerminal } from "./terminal";
import type { FileEntry } from "./store";
import "allotment/dist/style.css";
import { FileTree } from "./FileTree";
import { MarkdownArea } from "./MarkdownArea";
import { Titlebar } from "./Titlebar";
import { AutoHideTitlebar } from "./AutoHideTitlebar";
import { NotePopup } from "./NotePopup";
import { VoiceSlot } from "./VoiceSlot";
import { PlaceMount } from "./PluginMount";
import { reapplyKeptColumns, registerOuterResize, sashMoved } from "./layoutOps";
import { placeModule } from "./places";
import { ASK_PLUGIN, CHAT_PLUGIN, CHAT_ROWS_PLUGIN, CHATS_PLUGIN, COMPOSER_PLUGIN, CONTEXT_PLUGIN, ELEVENLABS_VOICE_PLUGIN, FILETREE_PLUGIN, NOTES_PLUGIN, SETTINGS_PLUGIN, TITLEBAR_PLUGIN, VAULTS_PLUGIN, VIEWER_PLUGIN } from "./appPlugins";
import * as titlebarPlugin from "./plugins/titlebar";
import * as settingsPlugin from "./plugins/settings";
import * as vaultsPlugin from "./plugins/vaults";
import * as fileTreePlugin from "./plugins/filetree";
import * as viewerPlugin from "./plugins/viewer";
import * as chatsPlugin from "./plugins/chats";
import * as chatPlugin from "./plugins/chat";
import * as chatRowsPlugin from "./plugins/chat-rows";
import * as composerPlugin from "./plugins/composer";
import * as notesPlugin from "./plugins/notes";
import * as elevenLabsVoicePlugin from "./plugins/elevenlabs-voice";
import * as contextPlugin from "./plugins/context";
import * as askPlugin from "./plugins/ask";
import { bindContextSource } from "./contextSource";
import { ChatsSidebar } from "./ChatsPanel";
import { Notices } from "./UpdateBanner";
import { ChangeKeeper } from "./ChangeKeeper";
import { hit, isMod } from "./shortcuts";
import { fileKind } from "./fileKind";
import type { NoteAnchor } from "./notes";
import { useStore } from "./store";
import { gitInitIfNeeded } from "./git";
import { useGlobalAnchorClickHandler } from "./linkNav";
import { toggleVoice, toggleVoiceMute } from "./voiceCall";
import { applyHljsTheme } from "./hljsTheme";
import {
  ensureVaultSyncLoop,
  stopVaultSyncLoop,
  focusVaultSync,
  readVaultSyncConfig,
  trackedVaults,
  untrackVault,
} from "./vaultSync";
import { startActivityWatch } from "./activity";
import { clearSavedLayouts } from "./paneLayout";
import { startTiles, toggleMaximizeFocused, useTiles } from "./tiles";
import { startChatRowDrag, startDevDragHook } from "./tileDrag";
import { MAIN_ID } from "./threads";
import { afterVaultReady, bootMark } from "./bootTiming";
import { isSecondWindow } from "./windowKind";
import "./App.css";

// The built-in modules mounted over either layout (src/places.ts place "overlay").
placeModule(NOTES_PLUGIN, () => notesPlugin);
placeModule(CONTEXT_PLUGIN, () => contextPlugin);
placeModule(ASK_PLUGIN, () => askPlugin);
placeModule(ELEVENLABS_VOICE_PLUGIN, () => elevenLabsVoicePlugin);
// Every part's offers, headless (src/places.ts "offers"): reachable whatever the layout.
placeModule(TITLEBAR_PLUGIN, () => titlebarPlugin.offers, "offers");
placeModule(SETTINGS_PLUGIN, () => settingsPlugin.offers, "offers");
placeModule(VAULTS_PLUGIN, () => vaultsPlugin.offers, "offers");
placeModule(FILETREE_PLUGIN, () => fileTreePlugin.offers, "offers");
placeModule(VIEWER_PLUGIN, () => viewerPlugin.offers, "offers");
placeModule(CHATS_PLUGIN, () => chatsPlugin.offers, "offers");
placeModule(CHAT_PLUGIN, () => chatPlugin.offers, "offers");
placeModule(CHAT_ROWS_PLUGIN, () => chatRowsPlugin.offers, "offers");
placeModule(COMPOSER_PLUGIN, () => composerPlugin.offers, "offers");

export default function App() {
  const toggleMode = useStore((s) => s.toggleMode);
  const toggleLeft = useStore((s) => s.toggleLeft);
  const toggleRight = useStore((s) => s.toggleRight);
  const currentFile = useStore((s) => s.currentFile);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const openNoteComposer = useStore((s) => s.openNoteComposer);
  const closeNoteComposer = useStore((s) => s.closeNoteComposer);
  const noteComposer = useStore((s) => s.noteComposer);
  const loadNotes = useStore((s) => s.loadNotes);
  const notesLoaded = useStore((s) => s.notesLoaded);
  const loadConversations = useStore((s) => s.loadConversations);
  const conversationsLoaded = useStore((s) => s.conversationsLoaded);
  const newConversation = useStore((s) => s.newConversation);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    applyHljsTheme(theme);
  }, [theme]);

  // The shared context stream: the file open, the PDF page, selections and captures (src/activity.ts).
  useEffect(() => startActivityWatch(), []);
  // The live shared context plugins and the agent read (src/sharedContext.ts): its publisher runs only while one listens.
  useEffect(() => bindContextSource(), []);
  // A start opens with an empty viewer; the layout earlier builds saved is cleared (src/paneLayout.ts).
  useEffect(() => clearSavedLayouts(), []);
  // the viewer's tile tree kept in step with the store, chats draggable out of the chats lists.
  useEffect(() => startTiles(), []);
  useEffect(() => startChatRowDrag((id) => (id === MAIN_ID ? "Main" : useStore.getState().conversations.find((c) => c.id === id)?.title || "Chat")), []);
  useEffect(() => startDevDragHook(), []);

  const setFiles = useStore((s) => s.setFiles);
  useEffect(() => {
    const saved = useStore.getState().vaultPath;
    if (!saved) return;
    let cancelled = false;
    (async () => {
      try {
        const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: saved });
        if (!cancelled) setFiles(listed, saved);
        bootMark("tree", { files: listed.length });
        if (!isSecondWindow) gitInitIfNeeded(saved).catch(() => {});
      } catch {
        if (!cancelled) {
          localStorage.removeItem("vault_chat_last_vault");
          useStore.setState({ vaultPath: null });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setFiles]);
  const leftCollapsed = useStore((s) => s.leftCollapsed);
  const popoutOpen = useStore((s) => s.popoutOpen);
  const chatFullscreen = useStore((s) => s.chatFullscreen);
  const chatsOpen = useStore((s) => s.chatSidebarOpen);
  // a zoomed tile fills the window (src/tiles.ts maximizeTile closes the side panels and puts them back;
  // Ctrl+B / Ctrl+Shift+B still open them beside it); our title bar is not drawn (App.css). The window itself never
  // changes size or mode (no OS fullscreen: a snapped window stays snapped).
  const tileMaximized = useTiles((t) => !!t.maximized);
  const files = useStore((s) => s.files);
  const vaultPath = useStore((s) => s.vaultPath);
  const fitWidth = useMemo(() => computeFitWidth(files), [files]);
  // both side panels (Files, Chats) stop at one cap: about 480 px, or a third of a narrower window.
  const panelMax = usePanelMax();
  const leftMax = panelMax;
  // a side panel's own edge dragged past half its minimum closes it (Files and Chats alike, mirrored), and
  // the store says so (Ctrl+B / Ctrl+Shift+B open it again). Not Allotment's snap: that also snapped the panel on the
  // far side when the near one hit its maximum (dragging Files' edge right closed Chats).
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const sash = (e.target as Element | null)?.closest?.(".sash");
      const outer = document.querySelector(".split-view-horizontal, .split-view");
      if (!sash || !outer || sash.parentElement?.parentElement !== outer) return;
      const all = [...sash.parentElement.children].filter((c) => c.classList.contains("sash") && (c as HTMLElement).offsetHeight > 0);
      const s = useStore.getState();
      // Which panel this edge is Files' or Chats' own: the leftmost visible edge with Files open, the rightmost with
      // Chats open.
      const isFiles = !s.leftCollapsed && all[0] === sash;
      const isChats = s.chatSidebarOpen && all[all.length - 1] === sash && !(isFiles && all.length === 1);
      if (!isFiles && !isChats) return;
      const views = outer.querySelectorAll(":scope > .split-view-container > .split-view-view");
      const panel = (isFiles ? views[0] : views[views.length - 1])?.getBoundingClientRect();
      if (!panel) return;
      const min = isFiles ? (window.innerWidth < 900 ? 120 : 160) : 220;
      const move = (ev: PointerEvent) => {
        const width = isFiles ? ev.clientX - panel.left : panel.right - ev.clientX;
        if (width >= min / 2) return;
        stop();
        const st = useStore.getState();
        if (isFiles && !st.leftCollapsed) st.toggleLeft();
        if (isChats && st.chatSidebarOpen) st.toggleChatSidebar();
      };
      const stop = () => (window.removeEventListener("pointermove", move, true), window.removeEventListener("pointerup", stop, true));
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", stop, true);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, []);
  // A narrow window (snapped to half the screen: 768 px at 125% on a 1920 screen) gets smaller column minimums, so
  // the three columns fit inside the window instead of running off its right edge (160+340+320 = 820 px did).
  const narrow = useNarrowWindow();
  const layoutRef = useRef<AllotmentHandle>(null);
  // The sashes' own resize, for box:workspace's resize (src/layoutOps.ts): what dragging them does.
  useEffect(() => registerOuterResize((sizes) => layoutRef.current?.resize(sizes)), []);
  useEffect(() => {
    // preferredSize updates the library's preference, not its current width.
    // Refit through its native API without replacing the conversation owner.
    layoutRef.current?.reset();
    // Right after a core swap: the widths Carl had, not the fitted ones (src/coreSwap.ts).
    reapplyKeptColumns();
  }, [fitWidth]);

  // Fullscreen chat has no viewer, so "Capture a region" (the + menu, the voice
  // typed reply) shows the open file over the chat with the marquee on, and
  // closes once the capture is taken (or Esc).
  const [captureOver, setCaptureOver] = useState(false);
  const capturePending = useStore((s) => s.chatPaneCapturePending || s.voiceCapturePending);
  useEffect(() => {
    const onCapture = () => setCaptureOver(true);
    window.addEventListener("vc-fullscreen-capture", onCapture);
    return () => window.removeEventListener("vc-fullscreen-capture", onCapture);
  }, []);
  useEffect(() => {
    if (!captureOver) return;
    // The viewer registers its marquee listener on mount; start it after.
    const id = setTimeout(() => window.dispatchEvent(new CustomEvent("vc-marquee-toggle")), 80);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      useStore.getState().setChatPaneCapturePending(false);
      useStore.getState().setVoiceCapturePending(false);
      setCaptureOver(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [captureOver]);
  useEffect(() => {
    if (captureOver && !capturePending) setCaptureOver(false);
  }, [captureOver, capturePending]);
  useEffect(() => {
    if (!chatFullscreen) setCaptureOver(false);
  }, [chatFullscreen]);

  const lastThemeToggleRef = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Alt+L — theme toggle. We have to guard against three different
      // ways the same chord can fire twice: keyboard auto-repeat, a
      // synthetic re-emit from the OS menu-activation that Alt sometimes
      // triggers on Windows, and rapid back-to-back keydowns from the
      // user mashing the chord. e.repeat catches auto-repeat; the time
      // lockout absorbs the other two without affecting normal toggles.
      if (hit(e, "view.theme")) {
        e.preventDefault();
        if (e.repeat) return;
        const now = Date.now();
        if (now - lastThemeToggleRef.current < 250) return;
        lastThemeToggleRef.current = now;
        void setTheme(useStore.getState().theme === "light" ? "graphite" : "light").then((why) => why && console.warn("[theme] the box refused:", why));
        return;
      }
      const mod = isMod(e);
      if (e.key === "Escape" && !e.defaultPrevented && useTiles.getState().maximized && !document.querySelector('[role="dialog"], [role="menu"]')) {
        // Esc ends a zoom (as Ctrl+Shift+F again), unless a menu or dialog is open (Esc is theirs).
        e.preventDefault();
        toggleMaximizeFocused();
        return;
      }
      if (!mod) return;
      // Holding a Ctrl-shortcut auto-repeats the keydown at the OS rate
      // (~30 Hz). Without this guard, Ctrl+B flickers the pane on/off,
      // Ctrl+J spawns a terminal per repeat, etc. One press = one fire.
      if (e.repeat) return;
      if (hit(e, "files.note")) {
        // Ctrl+N — open a fresh note composer for the current vault.
        // Intentionally also fires while focused in a Monaco editor
        // or a textarea — the user often wants to capture a thought
        // about what they're currently writing. Browser's native
        // "new window" was already suppressed by Tauri.
        const s = useStore.getState();
        if (!s.vaultPath) return;
        e.preventDefault();

        // Capture current context into the initial anchor:
        //   - Monaco editor selection (preferred when in edit mode —
        //     window.getSelection() doesn't see Monaco's selection)
        //   - window.getSelection() for text-layer viewers (markdown
        //     view, pdf text layer, html iframe where accessible)
        //   - lastCapture (marquee image + page anchor) if still fresh
        //     for the current file
        const cf = s.currentFile;
        const cap = s.lastCapture;
        const capFresh = cap && Date.now() - cap.timestamp < 2 * 60_000 && cap.path === cf;
        const editorSel = s.editorSelection;
        const editorSelActive =
          editorSel && cf && editorSel.path === cf && editorSel.text.trim().length > 0;
        const winSel = (window.getSelection?.()?.toString() ?? "").trim();
        const selection = editorSelActive ? editorSel!.text : winSel;
        // When the selection came from Monaco we can add a precise
        // line anchor "L42" or "L42-L58" to the note.
        const selectionAnchor = editorSelActive
          ? editorSel!.lineStart === editorSel!.lineEnd
            ? `L${editorSel!.lineStart}`
            : `L${editorSel!.lineStart}-L${editorSel!.lineEnd}`
          : null;
        if (cf) {
          const k = fileKind(cf).kind;
          const sourceKind: NoteAnchor["source_kind"] =
            k === "markdown" || k === "pdf" || k === "html" || k === "image" || k === "notebook"
              ? k
              : "code";
          const anchor: NoteAnchor = {
            source_path: cf,
            source_kind: sourceKind,
            source_anchor:
              selectionAnchor ?? (capFresh ? cap!.source_anchor : null),
            source_selection: selection || (capFresh ? cap!.selection : null) || null,
            image_data_url: capFresh ? cap!.imageDataUrl : null,
            primary: true,
          };
          openNoteComposer({ initialAnchors: [anchor] });
          if (capFresh) s.clearLastCapture();
        } else {
          openNoteComposer();
        }
        return;
      }
      if (hit(e, "edit.mode")) {
        if (!currentFile) return;
        e.preventDefault();
        // In split mode, Ctrl+E toggles only the active pane so users
        // can read one note while editing another. Falls back to the
        // global mode when there are no panes.
        const st = useStore.getState();
        if (st.activePaneId && st.panes.some((p) => p.id === st.activePaneId)) {
          st.togglePaneMode(st.activePaneId);
        } else {
          toggleMode();
        }
      } else if (hit(e, "view.files")) {
        e.preventDefault();
        toggleLeft();
      } else if (hit(e, "view.chat")) {
        // Ctrl+Shift+B shows or hides the Chats panel (there is no chat panel: chats are tiles).
        e.preventDefault();
        useStore.getState().toggleChatSidebar();
      } else if (hit(e, "view.fullscreen")) {
        // Ctrl+Shift+F — maximize / restore the focused tile (its header's button). There is no separate
        // full-screen mode: a chat tile filling the area is what full-screen chat was.
        e.preventDefault();
        if (useStore.getState().chatFullscreen) useStore.getState().toggleChatFullscreen();
        else toggleMaximizeFocused();
      } else if (hit(e, "chat.new")) {
        // Ctrl+T — back to Main (one main conversation: there are no new chats to start). The
        // webview's native "new tab" is already swallowed by Tauri.
        const s = useStore.getState();
        if (!s.vaultPath || !s.conversationsLoaded) return;
        e.preventDefault();
        void import("./projects").then((p) => p.openThread("main"));
      } else if (hit(e, "view.terminal") || hit(e, "view.terminalOther")) {
        // Ctrl+J: the terminal where the chat runs (the box for a box vault); Shift: the other one.
        e.preventDefault();
        openTerminal({ shift: e.shiftKey }).catch((err) => console.error("[terminal] failed:", err));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMode, toggleLeft, toggleRight, currentFile, setTheme, openNoteComposer, newConversation]);

  // Lazy-load notes the first time a vault is active (or after a vault
  // switch, which resets notesLoaded).
  useEffect(() => {
    if (vaultPath && !notesLoaded) {
      loadNotes();
    }
  }, [vaultPath, notesLoaded, loadNotes]);

  // Same shape for the multi-chat conversations list — load lazily
  // per-vault, then store mirrors keep it in sync to disk.
  useEffect(() => {
    if (vaultPath && !conversationsLoaded) {
      void loadConversations().finally(() =>
        bootMark("chats", { chats: useStore.getState().conversations.length }),
      );
    }
  }, [vaultPath, conversationsLoaded, loadConversations]);


  // Vault auto-sync — multi-vault. A sync-enabled
  // vault syncs in the BACKGROUND for the whole session, so switching to a
  // different vault never strands the one you left (the old single-loop design
  // silently stopped syncing everything but the foreground vault). On launch,
  // start a loop for every tracked vault that has sync enabled. Loops are
  // torn down only on app unmount.
  useEffect(() => {
    // The vault's sync is the main window's (a New window, src/newWindow.ts, shows what it brings).
    if (isSecondWindow) return;
    void (async () => {
      const { shadowedByFolder } = await import("./master");
      for (const v of trackedVaults()) {
        try {
          // Moved into the vault-chat folder: the folder's copy syncs, this one stays on disk and never syncs again.
          if (await shadowedByFolder(v)) {
            untrackVault(v);
            continue;
          }
          const cfg = await readVaultSyncConfig(v);
          if (cfg.enabled) await ensureVaultSyncLoop(v);
        } catch {
          /* a vault we can't read config for just doesn't auto-start */
        }
      }
    })();
    // Every repo in the vault-chat folder (src/master.ts): what the box has and this laptop lacks is made here, and
    // each syncs; again every 5 minutes (a vault or project made on the box arrives on its own).
    const masterPass = () => void import("./master").then((m) => m.syncMasterFolder()).catch(() => {});
    void afterVaultReady().then(masterPass);
    const masterTimer = window.setInterval(masterPass, 5 * 60_000);
    return () => {
      window.clearInterval(masterTimer);
      stopVaultSyncLoop(); // stop ALL loops on app unmount
    };
  }, []);

  // Whenever a vault is opened, make sure its loop is running (a disabled vault
  // gets the cheap local-commit-only loop; an enabled one the full sync loop)
  // and point the status row at it.
  useEffect(() => {
    if (!vaultPath || isSecondWindow) return;
    void ensureVaultSyncLoop(vaultPath);
    focusVaultSync();
  }, [vaultPath]);

  // Cross-machine sync — daemon (server) or client (consumer) per the
  // user's mode setting in Settings. Also registers this vault with
  // the local daemon-state map (idempotent) so the daemon can serve
  // it by vault-id even if cross-sync is later enabled. The vault-id
  // file gets created on first read; auto-sync (item #6) propagates
  // it to other machines via git so both sides converge.
  useEffect(() => {
    if (!vaultPath || isSecondWindow) return;
    // Ensure the vault has a stable id file (vault identity).
    void (async () => {
      try {
        const { ensureVaultId } = await import("./vaultId");
        await ensureVaultId(vaultPath);
      } catch (e) {
        console.warn("[vault-id] ensure failed:", e);
      }
    })();
    // Pull any keys this machine is missing from the vault's encrypted
    // keystore (no-op unless a passphrase is set and keys.enc exists), so
    // a synced machine inherits credentials without re-entry.
    void (async () => {
      const { autoImportOnOpen } = await import("./keystore");
      await autoImportOnOpen(vaultPath).catch((e) =>
        console.warn("[keystore] auto-import failed:", e),
      );
    })();
    // Seed this vault's voice prompt (.vault-chat/agent/voice.md, which the box's
    // voice agent reads) from the bundled default if absent.
    void (async () => {
      const { ensureVaultVoicePrompt } = await import("./meta");
      await ensureVaultVoicePrompt(vaultPath).catch((e) =>
        console.warn("[agent-cfg] ensure voice prompt failed:", e),
      );
    })();
  }, [vaultPath]);

  // Sweep stale chat-pane captures on every vault activation. The
  // user's mental model is "captures are for this session" — once a
  // few hours pass, stick around past usefulness only as disk clutter.
  // Saved chat history still renders the bubbles from data URLs, so
  // pruning the disk copies only invalidates the path reference (used
  // when the agent is asked to embed the image in a markdown file).
  useEffect(() => {
    if (!vaultPath || isSecondWindow) return;
    const RETENTION_HOURS = 6;
    void invoke("cleanup_old_captures", {
      vault: vaultPath,
      olderThanHours: RETENTION_HOURS,
    }).catch((e) => console.warn("[captures] sweep failed:", e));
  }, [vaultPath]);

  // Suppress webview defaults that bleed through and make the app feel
  // like a browser tab: Ctrl+F (find bar), Ctrl+G (find-next), Ctrl+R /
  // F5 (reload), Ctrl+P (print), Ctrl+S (save-page), and the native
  // right-click context menu. Custom menus (file tree, PDF) install
  // their own contextmenu handlers that preventDefault locally.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMod(e);
      const k = e.key.toLowerCase();
      if (mod && (k === "f" || k === "g" || k === "r" || k === "p" || k === "s")) {
        e.preventDefault();
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        return;
      }
    };
    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      // Keep the browser's mature media menu (Play/Pause, Mute, etc.).
      // Suppressing it removes a native control path, especially with codecs
      // or platform media-control themes that cannot draw every button.
      if (e.target instanceof Element && e.target.closest("video,audio")) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("contextmenu", onContext);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("contextmenu", onContext);
    };
  }, []);

  // Block stray file drops that miss our handlers — otherwise the webview
  // navigates to the dropped file's URL.
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  useGlobalAnchorClickHandler();

  // Ctrl+D — voice mode on/off. Here rather than in the titlebar so it works
  // in fullscreen chat, which has no titlebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isSecondWindow) return;
      if (hit(e, "voice.toggle")) {
        e.preventDefault();
        toggleVoice("ctrl+d");
      }
      // Ctrl+Shift+M: mute / unmute a live call (the composer's Mute button). No call: the key is left alone.
      if (hit(e, "voice.mute") && !e.repeat && toggleVoiceMute()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // What floats over either layout (the note composer, Notes, voice text,
  // the update banner). Fullscreen chat used to drop them all with the
  // titlebar, so Ctrl+N, Notes and voice did nothing there.
  const overlays = (
    <>
      <NotePopup
        open={noteComposer.open}
        initialDraft={noteComposer.initialDraft}
        initialAnchors={noteComposer.initialAnchors}
        initialTurns={noteComposer.initialTurns}
        onClose={closeNoteComposer}
      />
      {/* What src/places.ts mounts over either layout: the Notes panel
          (src/plugins/notes), the shared context (src/plugins/context: draws nothing) and the Ctrl+K / Ctrl+L box's
          offers (src/plugins/ask: draws nothing; each box is its `prompt` part, src/InlineEditPrompt.tsx). */}
      <PlaceMount place="overlay" />
      <PlaceMount place="offers" />
      {/* Voice: a plugin (src/plugins/voice): its text box here, its controls in the title bar and the composer. */}
      {/* Voice, the update notices and the change keeper are the main window's (one call, one card). */}
      {!isSecondWindow && <VoiceSlot />}
      {!isSecondWindow && <Notices />}
      {/* Changes reach Carl as lines in a chat (src/changeFlow.ts); this keeps what they stand on. Core, never a plugin. */}
      {!isSecondWindow && <ChangeKeeper />}
    </>
  );

  // Fullscreen chat mode (FullscreenChat.tsx): the chats sidebar and the chat,
  // no titlebar, no Allotment, no viewer. Same Ctrl+Shift+F exits. Skipped
  // when the chat is popped out (the popout window is the fullscreen chat).
  // The chat pane itself is ChatPaneHost's, at the same place in either layout: <ChatPane /> in a layout is a slot it
  // moves into (src/ChatPane.tsx), so switching layouts never rebuilds the transcript.
  // no full-screen chat and no chat panel: a chat is a tile (src/tiles.ts); a maximized chat tile is what
  // full-screen chat was. The side panels: Files (left), Chats (right), Notes (its own).
  void chatFullscreen;
  void captureOver;
  return (
    <>
    <div className="relative h-full w-full bg-background flex flex-col" data-tile-zoom={tileMaximized ? "" : undefined}>
      <AutoHideTitlebar><Titlebar /></AutoHideTitlebar>
      <div className="flex-1 min-h-0">
        {/* Viewer navigation cannot replace the conversation's React owner.
            Refit file-tree widths through Allotment, not a React remount. A vault
            key here remounted ChatPane, discarded its draft and reader scroll,
            and rebuilt the entire historical transcript for a file operation. */}
        <Allotment
          ref={layoutRef}
          key={popoutOpen ? "pop" : "dock"}
          proportionalLayout={false}
          onChange={sashMoved}
        >
          <Allotment.Pane preferredSize={Math.min(fitWidth, panelMax)} minSize={narrow ? 120 : 160} maxSize={leftMax} visible={!leftCollapsed}>
            <FileTree />
          </Allotment.Pane>
          {/* The tiles: low enough that Files + tiles + Chats fit a narrow window side by side (the strip scrolls). */}
          <Allotment.Pane minSize={200} priority={LayoutPriority.High}>
            <MarkdownArea />
          </Allotment.Pane>
          {/* Chats, the chat list, as the right side panel (Ctrl+Shift+B); every chat itself is a tile. */}
          <Allotment.Pane preferredSize={272} minSize={220} maxSize={panelMax} visible={chatsOpen}>
            <ChatsSidebar />
          </Allotment.Pane>
        </Allotment>
      </div>
      {overlays}
    </div>
    </>
  );
}

/** Below 900 px the window is narrow (the docked layout's column minimums shrink), following its live width. */
/** The side panels' widest: 480 px, or a third of the window when that is less (live). */
function usePanelMax(): number {
  const now = () => (typeof window === "undefined" ? 480 : Math.max(220, Math.min(480, Math.round(window.innerWidth / 3))));
  const [max, setMax] = useState(now);
  useEffect(() => {
    const on = () => setMax(now());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return max;
}

function useNarrowWindow(): boolean {
  const narrowNow = () => typeof window !== "undefined" && window.innerWidth < 900;
  const [narrow, setNarrow] = useState(narrowNow);
  useEffect(() => {
    const on = () => setNarrow(narrowNow());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return narrow;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.font = "12.5px ui-sans-serif, system-ui, sans-serif";
  measureCtx = ctx;
  return ctx;
}

function computeFitWidth(files: FileEntry[]): number {
  if (!files.length) return 180;
  const ctx = getMeasureCtx();
  let max = 0;
  for (const f of files) {
    if (f.hidden) continue;
    if (f.depth !== 0) continue;
    const label = f.is_dir ? f.name : f.name.replace(/\.md$/, "");
    const indent = 8;
    const iconAndGap = 22;
    const text = ctx ? ctx.measureText(label).width : label.length * 7;
    const right = 16;
    const w = indent + iconAndGap + text + right;
    if (w > max) max = w;
  }
  return Math.max(160, Math.min(320, Math.round(max)));
}
