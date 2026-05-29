import { useEffect, useMemo, useRef, useState } from "react";
import { Allotment, LayoutPriority } from "allotment";
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "./store";
import "allotment/dist/style.css";
import { FileTree } from "./FileTree";
import { MarkdownArea } from "./MarkdownArea";
import { ChatPane } from "./ChatPane";
import { SettingsPane } from "./SettingsPane";
import { Titlebar } from "./Titlebar";
import { NotePopup } from "./NotePopup";
import { VoiceTextPanel } from "./VoiceTextPanel";
import { NotesPanel } from "./NotesPanel";
import { ChatsPanel } from "./ChatsPanel";
import { SchedulesPanel } from "./SchedulesPanel";
import { UpdateBanner } from "./UpdateBanner";
import { fileKind } from "./fileKind";
import type { NoteAnchor } from "./notes";
import { useStore } from "./store";
import { gitInitIfNeeded } from "./git";
import { useGlobalAnchorClickHandler } from "./linkNav";
import { applyHljsTheme } from "./main";
import { startVaultSyncLoop, stopVaultSyncLoop } from "./vaultSync";
import { startSchedulerLoop, stopSchedulerLoop } from "./schedulerLoop";
import { startCrossSync, stopCrossSync } from "./crossSync";
import {
  startTelegramService,
  stopTelegramService,
  subscribeTelegramInbound,
  refreshTelegramSnapshot,
  getEnabledTelegramVaults,
} from "./telegram";
import "./App.css";

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
  const showNotesPanel = useStore((s) => s.showNotesPanel);
  const setShowNotesPanel = useStore((s) => s.setShowNotesPanel);
  const setShowHistory = useStore((s) => s.setShowHistory);
  const loadNotes = useStore((s) => s.loadNotes);
  const notesLoaded = useStore((s) => s.notesLoaded);
  const showChatsPanel = useStore((s) => s.showChatsPanel);
  const setShowChatsPanel = useStore((s) => s.setShowChatsPanel);
  const showSchedulesPanel = useStore((s) => s.showSchedulesPanel);
  const setShowSchedulesPanel = useStore((s) => s.setShowSchedulesPanel);
  const loadConversations = useStore((s) => s.loadConversations);
  const conversationsLoaded = useStore((s) => s.conversationsLoaded);
  const newConversation = useStore((s) => s.newConversation);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    applyHljsTheme(theme);
  }, [theme]);

  const setFiles = useStore((s) => s.setFiles);
  useEffect(() => {
    const saved = useStore.getState().vaultPath;
    if (!saved) return;
    let cancelled = false;
    (async () => {
      try {
        const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: saved });
        if (!cancelled) setFiles(listed);
        gitInitIfNeeded(saved).catch(() => {});
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
  const rightCollapsed = useStore((s) => s.rightCollapsed);
  const popoutOpen = useStore((s) => s.popoutOpen);
  const chatFullscreen = useStore((s) => s.chatFullscreen);
  const showSettings = useStore((s) => s.showSettings);
  const chatHidden = rightCollapsed || popoutOpen;
  const files = useStore((s) => s.files);
  const vaultPath = useStore((s) => s.vaultPath);
  const fitWidth = useMemo(() => computeFitWidth(files), [files]);
  const leftMax = Math.max(fitWidth, 600);

  const [layoutKey, setLayoutKey] = useState<string>("empty");
  const lastVaultRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      vaultPath &&
      vaultPath !== lastVaultRef.current &&
      files.length > 0 &&
      files[0].path.startsWith(vaultPath)
    ) {
      lastVaultRef.current = vaultPath;
      setLayoutKey(vaultPath);
    }
  }, [vaultPath, files]);

  const lastThemeToggleRef = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      // Alt+L — theme toggle. We have to guard against three different
      // ways the same chord can fire twice: keyboard auto-repeat, a
      // synthetic re-emit from the OS menu-activation that Alt sometimes
      // triggers on Windows, and rapid back-to-back keydowns from the
      // user mashing the chord. e.repeat catches auto-repeat; the time
      // lockout absorbs the other two without affecting normal toggles.
      if (k === "l" && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        if (e.repeat) return;
        const now = Date.now();
        if (now - lastThemeToggleRef.current < 250) return;
        lastThemeToggleRef.current = now;
        setTheme(useStore.getState().theme === "light" ? "graphite" : "light");
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Holding a Ctrl-shortcut auto-repeats the keydown at the OS rate
      // (~30 Hz). Without this guard, Ctrl+B flickers the pane on/off,
      // Ctrl+J spawns a terminal per repeat, etc. One press = one fire.
      if (e.repeat) return;
      if (k === "n" && !e.shiftKey && !e.altKey) {
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
      if (k === "e") {
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
      } else if (k === "b" && !e.shiftKey) {
        e.preventDefault();
        toggleLeft();
      } else if (k === "b" && e.shiftKey) {
        e.preventDefault();
        toggleRight();
      } else if (k === "f" && e.shiftKey && !e.altKey) {
        // Ctrl+Shift+F — toggle borderless fullscreen chat. Covers the
        // titlebar, file tree, and viewer with just the ChatPane. Same
        // chord exits.
        e.preventDefault();
        useStore.getState().toggleChatFullscreen();
      } else if (k === "h" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setShowHistory(true);
      } else if (k === "t" && !e.shiftKey && !e.altKey) {
        // Ctrl+T — start a fresh chat. The browser/webview's native
        // "new tab" is already swallowed by Tauri, so we don't fight
        // any platform shortcut here.
        const s = useStore.getState();
        if (!s.vaultPath || !s.conversationsLoaded) return;
        e.preventDefault();
        s.newConversation();
        if (s.rightCollapsed) s.toggleRight();
      } else if (k === "j" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        invoke("open_terminal", {
          cwd: useStore.getState().vaultPath ?? undefined,
        }).catch((err) => console.error("[terminal] failed:", err));
      } else if (k === "s" && e.shiftKey && !e.altKey) {
        // Ctrl+Shift+S — toggle the schedules panel.
        e.preventDefault();
        const s = useStore.getState();
        s.setShowSchedulesPanel(!s.showSchedulesPanel);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMode, toggleLeft, toggleRight, currentFile, setTheme, openNoteComposer, setShowHistory, newConversation]);

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
      loadConversations();
    }
  }, [vaultPath, conversationsLoaded, loadConversations]);

  // Per-vault status refresh when the active vault changes (so the
  // settings UI reflects the right vault's poller state).
  useEffect(() => {
    if (vaultPath) void refreshTelegramSnapshot(vaultPath);
  }, [vaultPath]);

  // Telegram bot — multi-poller. On app launch, start a poller for
  // every vault that has Telegram enabled. Pollers run concurrently
  // and independently of which vault has UI focus. Inbound events
  // are tagged with vault_id; the handler routes the message either
  // to the in-memory store (if it's the currently-open vault) or
  // writes to that vault's conversations.jsonl on disk (off-vault).
  useEffect(() => {
    void (async () => {
      const enabledVaults = getEnabledTelegramVaults();
      for (const v of enabledVaults) {
        await startTelegramService(v);
      }
    })();
    const unsub = subscribeTelegramInbound(async (m) => {
      const s = useStore.getState();
      // The Rust event tells us which vault's bot received this
      // message. That, not the currently-open vault, is the target.
      const inboundVault = m.vault_id;
      if (!inboundVault) return;
      const isCurrentVault = inboundVault === s.vaultPath;
      const { sendTelegramMessage } = await import("./telegram");
      const trimmedText = m.text.trim();

      // Off-vault inbound: full round-trip (agent run + telegram
      // reply) without touching the active vault's UI. The user only
      // sees off-vault activity when they next switch to that vault.
      if (!isCurrentVault) {
        const { handleOffVaultInbound } = await import("./offVaultRun");
        void handleOffVaultInbound(
          inboundVault,
          m.chat_id,
          m.text,
          m.from_username,
          m.photo_file_ids,
        ).catch((e) =>
          console.warn("[telegram] off-vault run failed:", e),
        );
        return;
      }

      // Current-vault path: rest of the handler operates on the
      // in-memory conversations store.
      if (!s.conversationsLoaded) return;

      // Slash commands from the phone, intercepted before the agent
      // sees them. A single Telegram thread (one chat_id between you
      // and the bot) maps to one vault-chat conversation, so without
      // an explicit "start over" trigger every phone message would
      // pile into the same growing thread forever.
      // Detach the chat_id mapping from whatever conversation currently
      // owns it, and attach it to the target instead.
      const rebindChatIdTo = (targetId: string, titleFallback?: string) => {
        const prev = useStore
          .getState()
          .conversations.find((c) => c.telegramChatId === m.chat_id);
        let next = useStore.getState().conversations.map((c) => {
          if (c.id === prev?.id && c.id !== targetId) {
            return { ...c, telegramChatId: undefined };
          }
          if (c.id === targetId) {
            return {
              ...c,
              source: "telegram" as const,
              telegramChatId: m.chat_id,
              title: c.title === "New chat" && titleFallback ? titleFallback : c.title,
            };
          }
          return c;
        });
        useStore.setState({ conversations: next });
      };
      if (/^\/(new|start)\b/i.test(trimmedText)) {
        // Create the fresh conversation inline and rebind the chat_id to
        // it — deliberately NOT newConversation(), which sets
        // activeConversationId and would yank the laptop's foreground over
        // to this Telegram thread. Telegram convos always run in the
        // background; the phone gets a fresh context without disturbing
        // whatever you're doing in the app. Mirrors the inbound-message
        // path below.
        const { emptyConversation } = await import("./conversations");
        const fresh = emptyConversation();
        useStore.setState({
          conversations: [fresh, ...useStore.getState().conversations],
        });
        rebindChatIdTo(
          fresh.id,
          m.from_username ? `Telegram · @${m.from_username}` : undefined,
        );
        sendTelegramMessage(
          inboundVault,
          m.chat_id,
          "Started a new chat — fresh context. The old conversation is still in vault-chat under Recent.",
        ).catch(() => {});
        return;
      }
      if (/^\/reset\b/i.test(trimmedText)) {
        // /reset with no arg → list. /reset <N> → switch to that index.
        const argMatch = trimmedText.match(/^\/reset\s+(\d+)\s*$/i);
        const sorted = s.conversations
          .slice()
          .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
          .slice(0, 10);
        if (argMatch) {
          const idx = parseInt(argMatch[1]!, 10) - 1;
          const target = sorted[idx];
          if (!target) {
            sendTelegramMessage(
              inboundVault,
              m.chat_id,
              `No conversation #${idx + 1}. Send /reset alone to see the list.`,
            ).catch(() => {});
            return;
          }
          rebindChatIdTo(target.id);
          sendTelegramMessage(
            inboundVault,
            m.chat_id,
            `Reattached to: ${target.title || "New chat"}\nNext messages from your phone land in that conversation.`,
          ).catch(() => {});
          return;
        }
        if (sorted.length === 0) {
          sendTelegramMessage(inboundVault, m.chat_id, "No conversations yet.").catch(() => {});
          return;
        }
        const fmtAge = (ts: number) => {
          const diff = Date.now() - ts;
          const min = Math.floor(diff / 60_000);
          if (min < 60) return `${Math.max(1, min)}m`;
          const hr = Math.floor(min / 60);
          if (hr < 24) return `${hr}h`;
          return `${Math.floor(hr / 24)}d`;
        };
        const lines = sorted.map(
          (c, i) =>
            `${i + 1}. ${c.title || "New chat"} · ${fmtAge(c.lastActivityAt)}${
              c.telegramChatId === m.chat_id ? " (current)" : ""
            }`,
        );
        sendTelegramMessage(
          inboundVault,
          m.chat_id,
          `Recent conversations:\n${lines.join("\n")}\n\nReply /reset <N> to switch to one.`,
        ).catch(() => {});
        return;
      }
      if (/^\/help\b/i.test(trimmedText)) {
        sendTelegramMessage(
          inboundVault,
          m.chat_id,
          "Commands:\n/new (or /start) — start a fresh conversation; the old one stays in vault-chat\n/reset — list recent conversations and switch back to one (/reset N)\n/help — this message\n\nNote: clearing chat history on your phone is invisible to the bot — use /new to actually reset on the vault-chat side.",
        ).catch(() => {});
        return;
      }
      // Telegram threads run in the BACKGROUND and in PARALLEL with the
      // foreground vault agent — a phone message no longer waits for the
      // laptop's agent (or any other thread) to finish. The single
      // exception: don't start a second concurrent run on the SAME
      // telegram thread. If this thread's agent is still mid-turn, queue
      // the message so it isn't lost; it gets picked up on the next turn.
      const existingConv = s.conversations.find(
        (c) => c.telegramChatId === m.chat_id,
      );
      // Is this exact thread already being processed? Two ways it can be:
      // running in the background (per-conv status), or running in the
      // foreground because the user is currently viewing it (global busy
      // — foreground runs don't set the per-conv status).
      const thisThreadBusy =
        existingConv?.status === "running" ||
        (!!existingConv && s.activeConversationId === existingConv.id && s.busy);
      if (thisThreadBusy) {
        console.warn(
          "[telegram] inbound while THIS thread is mid-run — queued",
        );
        s.ingestExternalMessage({
          text: m.text,
          source: "telegram",
          telegramChatId: m.chat_id,
          matchByTelegramChatId: m.chat_id,
          titleHint: m.from_username
            ? `Telegram · @${m.from_username}`
            : undefined,
        });
        return;
      }
      // Find or create the Telegram-sourced conversation for this chat.
      // Create it inline (no newConversation() — that would activate the
      // chat and steal focus). Telegram convos always run in the
      // background unless the user explicitly clicks on them.
      let convId = existingConv?.id ?? null;
      if (!convId) {
        const { emptyConversation } = await import("./conversations");
        const fresh = {
          ...emptyConversation(),
          source: "telegram" as const,
          telegramChatId: m.chat_id,
          title: m.from_username
            ? `Telegram · @${m.from_username}`
            : "Telegram",
        };
        useStore.setState({
          conversations: [fresh, ...useStore.getState().conversations],
        });
        convId = fresh.id;
      }
      // Download any phone-sent images and convert to attachments
      // before kicking the agent — so the model can see them, not
      // just the caption.
      const attachments: import("./store").ChatAttachment[] = [];
      if (m.photo_file_ids.length > 0) {
        const { downloadTelegramPhoto, readImageAsAttachment } = await import(
          "./telegram"
        );
        for (const fid of m.photo_file_ids) {
          try {
            const path = await downloadTelegramPhoto(inboundVault, fid);
            const att = await readImageAsAttachment(path);
            attachments.push(att);
          } catch (e) {
            console.warn("[telegram] photo download failed:", e);
          }
        }
      }
      // Don't yank focus to the Telegram chat. Run the agent against
      // it as a background target — the mid-run-switch logic in
      // chat-controller routes events to that conversation's stored
      // messages while the user stays on whatever they had open.
      const { sendMessage } = await import("./chat-controller");
      void sendMessage(
        m.text || (attachments.length > 0 ? "(image)" : ""),
        undefined,
        attachments.length > 0 ? attachments : undefined,
        convId,
      ).catch((e) => console.warn("[telegram] agent run failed:", e));
    });
    return () => {
      unsub();
      // Stop every poller on app unmount.
      void stopTelegramService(null);
    };
  }, []);

  // Vault auto-sync — start a per-vault loop when a vault is active.
  // The loop reads its own opt-in config from <vault>/.vault-chat/
  // config.json; if disabled, this is a fast no-op. Tear down on
  // unmount or vault switch so two loops never run at once.
  useEffect(() => {
    if (!vaultPath) return;
    void startVaultSyncLoop(vaultPath);
    return () => {
      stopVaultSyncLoop();
    };
  }, [vaultPath]);

  // Scheduled agent runs — multi-vault. On app launch, start a
  // scheduler loop for every vault we've ever opened (tracked in
  // localStorage). Whenever a new vault is opened, start its loop
  // too. Loops persist across vault switches so a schedule for
  // vault-B fires at its time even when you're working in vault-A.
  useEffect(() => {
    void (async () => {
      const { getTrackedVaults, startSchedulerLoop } = await import("./schedulerLoop");
      for (const v of getTrackedVaults()) {
        void startSchedulerLoop(v);
      }
    })();
    return () => {
      // Stop all loops on app unmount.
      stopSchedulerLoop();
    };
  }, []);
  // When a new vault is opened, make sure its loop is running too.
  useEffect(() => {
    if (!vaultPath) return;
    void startSchedulerLoop(vaultPath);
  }, [vaultPath]);

  // Cross-machine sync — daemon (server) or client (consumer) per the
  // user's mode setting in Settings. Also registers this vault with
  // the local daemon-state map (idempotent) so the daemon can serve
  // it by vault-id even if cross-sync is later enabled. The vault-id
  // file gets created on first read; auto-sync (item #6) propagates
  // it to other machines via git so both sides converge.
  useEffect(() => {
    if (!vaultPath) return;
    void (async () => {
      try {
        const { ensureVaultId } = await import("./vaultId");
        const id = await ensureVaultId(vaultPath);
        await invoke("daemon_register_vault", {
          vaultId: id,
          vaultPath,
        });
      } catch (e) {
        console.warn("[vault-id] register failed:", e);
      }
    })();
    void startCrossSync(vaultPath);
    return () => {
      void stopCrossSync();
    };
  }, [vaultPath]);

  // Sweep stale chat-pane captures on every vault activation. The
  // user's mental model is "captures are for this session" — once a
  // few hours pass, stick around past usefulness only as disk clutter.
  // Saved chat history still renders the bubbles from data URLs, so
  // pruning the disk copies only invalidates the path reference (used
  // when the agent is asked to embed the image in a markdown file).
  useEffect(() => {
    if (!vaultPath) return;
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
      const mod = e.ctrlKey || e.metaKey;
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

  // Fullscreen chat mode: ChatPane takes over the entire window — no
  // titlebar, no Allotment, no viewer. Same Ctrl+Shift+F exits. Skipped
  // when the chat is popped out (the popout window owns its own surface).
  if (chatFullscreen && !popoutOpen) {
    return (
      <div className="h-full w-full bg-background flex flex-col">
        <div
          data-tauri-drag-region
          className="h-1.5 shrink-0 bg-background"
          title="Drag to move window — Ctrl+Shift+F to exit fullscreen chat"
        />
        <div className="flex-1 min-h-0">
          <ChatPane />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-background flex flex-col">
      <Titlebar />
      <div className="flex-1 min-h-0">
        <Allotment key={`${layoutKey}:${popoutOpen ? "pop" : "dock"}`} proportionalLayout={false}>
          <Allotment.Pane preferredSize={fitWidth} minSize={160} maxSize={leftMax} visible={!leftCollapsed} snap>
            <FileTree />
          </Allotment.Pane>
          <Allotment.Pane minSize={340} priority={LayoutPriority.High}>
            {showSettings && chatHidden ? <SettingsPane /> : <MarkdownArea />}
          </Allotment.Pane>
          {/* Dropping the pane entirely while popped out — visible=false
              still leaves a sash the user can grab at the screen edge. */}
          {!popoutOpen && (
            <Allotment.Pane preferredSize={440} minSize={320} visible={!rightCollapsed} snap>
              <ChatPane />
            </Allotment.Pane>
          )}
        </Allotment>
      </div>
      <NotePopup
        open={noteComposer.open}
        initialDraft={noteComposer.initialDraft}
        initialAnchors={noteComposer.initialAnchors}
        initialTurns={noteComposer.initialTurns}
        onClose={closeNoteComposer}
      />
      <NotesPanel open={showNotesPanel} onClose={() => setShowNotesPanel(false)} />
      <ChatsPanel
        open={showChatsPanel}
        onClose={() => setShowChatsPanel(false)}
        onFocusComposer={() => {
          // Composer focus is owned by ChatPane; emit a custom event so
          // we don't have to thread a ref through the Allotment tree.
          window.dispatchEvent(new CustomEvent("vc-focus-composer"));
        }}
      />
      <SchedulesPanel
        open={showSchedulesPanel}
        onClose={() => setShowSchedulesPanel(false)}
      />
      <VoiceTextPanel />
      <UpdateBanner />
    </div>
  );
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
