// The chat composer (the plugin's view; ./index.tsx mounts it): the text box, the / skill and @ file menus, the +
// menu, attached pictures and files, drop and paste, Send / Stop, voice beside them, and the line under it (the model
// and effort labels, the box's state, the run's time, the context ring, New chat, Chats). It moved here unchanged from
// the chat pane (src/ChatPane.tsx); its draft is module state (./draft.ts) so the agent's actions and the built-in
// fallback share it, and it reads whether a message can go from src/chatGate.ts, as the pane does.
//
// Its own React root: a keystroke redraws the composer alone, never the chat pane around it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus, Square, ArrowUp, X, Mic, Paperclip, Scan, AtSign, AlertCircle, FileText } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { attachBlob, sizeLabel } from "../../attachFiles";
import { isExternalFileDrop } from "../../dnd";
import { fileKind } from "../../fileKind";
import { clipboardImageDataUrls } from "../../chatImage";
import { dispatchChatAction, isPopout } from "../../sync";
import { useStore } from "../../store";
import { toggleVoice } from "../../voiceCall";
import { InlineVoiceWaves, VoiceMuteButton } from "../../voiceParts";
import { Button, Textarea } from "../../ui";
import { cn } from "../../lib/utils";
import { ATTACH_MAX_BYTES, BOX_UNREACHABLE } from "../../boxChat";
import { ARCHIVED_THREAD, OLDER_CHAT } from "../../conversations";
import { ChatModelPicker } from "../../ChatModelPicker";
import { ClaudeSignInPrompt } from "../../ClaudeCodeSignIn";
import { useFittedPlaceholder } from "../../fitPlaceholder";
import { useChatGate } from "../../chatGate";
import { ChatFooterTools } from "../../ChatFooter";
import { startCapture } from "../../capture";
import { shortcutHint } from "../../shortcuts";
import {
  addAttached,
  addCapture,
  addReference,
  attachImages,
  detachItem,
  attachPaths,
  escapeRegExp,
  filterFilesForMention,
  focusHandoff,
  scrollHold,
  sendDraft,
  setAttachError,
  setInputOnly,
  setMentions,
  stopAgent,
  useDraft,
  type MentionHit,
} from "./draft";

/** The composer grows with its text up to this height, then scrolls. */
const COMPOSER_MAX_PX = 200;

/** The text box's focus survives a swap (the in-tree composer while the records load, then the plugin's): taken over
 *  when the new one mounts within this long of the old one going. */
const HANDOFF_MS = 1500;

export function Composer() {
  const vaultPath = useStore((s) => s.vaultPath);
  const skills = useStore((s) => s.skills);
  const busy = useStore((s) => s.busy);
  const files = useStore((s) => s.files);
  const activeConversationId = useStore((s) => s.activeConversationId);
  const capturable = useStore((s) => {
    const paths: string[] = [];
    if (s.currentFile) paths.push(s.currentFile);
    for (const p of s.panes) if (p.file) paths.push(p.file);
    return paths.some((p) => {
      const k = fileKind(p).kind;
      return k === "pdf" || k === "html" || k === "image";
    });
  });
  const chatPaneLastCapture = useStore((s) => s.chatPaneLastCapture);
  const chatFullscreen = useStore((s) => isPopout || (s.chatFullscreen && !s.popoutOpen));
  const voiceMode = useStore((s) => s.voiceMode);
  const voiceError = useStore((s) => s.voiceError);
  const voiceNotice = useStore((s) => s.voiceNotice);
  const { ready, aiBlocked, archived, older, boxDown, downWhy, held, reason } = useChatGate();

  const input = useDraft((d) => d.input);
  const pendingImages = useDraft((d) => d.images);
  const pendingFiles = useDraft((d) => d.files);
  const attachError = useDraft((d) => d.attachError);

  const [plusOpen, setPlusOpen] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  // Skill menu opens on a /word-boundary token at the caret — same shape as fileMention so it can appear mid-message,
  // not just at input start. start is the index of the "/".
  const [skillMention, setSkillMention] = useState<{ query: string; start: number } | null>(null);
  const [skillMentionIdx, setSkillMentionIdx] = useState(0);
  const [fileMention, setFileMention] = useState<{ query: string; start: number } | null>(null);
  const [fileMentionIdx, setFileMentionIdx] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A capture taken for the chat (the marquee over the viewer): into the draft.
  useEffect(() => {
    if (!chatPaneLastCapture) return;
    useStore.getState().setChatPaneLastCapture(null);
    addCapture(chatPaneLastCapture);
  }, [chatPaneLastCapture]);

  // A waiting message's Edit: its text back into the composer, ahead of anything typed since.
  useEffect(() => {
    const onInsert = (e: Event) => {
      const t = String((e as CustomEvent).detail ?? "");
      if (!t) return;
      useDraft.setState((d) => ({ input: d.input.trim() ? `${t}\n${d.input}` : t }));
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    const onFocus = () => inputRef.current?.focus();
    window.addEventListener("vc-composer-insert", onInsert);
    window.addEventListener("vc-focus-composer", onFocus);
    return () => {
      window.removeEventListener("vc-composer-insert", onInsert);
      window.removeEventListener("vc-focus-composer", onFocus);
    };
  }, []);

  // Focus across a swap: the old text box had it, so the new one takes it (caret at the end).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && Date.now() - focusHandoff.at < HANDOFF_MS) {
      focusHandoff.at = 0;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    return () => {
      if (el && el.ownerDocument.activeElement === el) focusHandoff.at = Date.now();
    };
  }, []);

  // The menus belong to the text: a sent (or cleared) draft closes them.
  useEffect(() => {
    if (input) return;
    setSkillMention(null);
    setFileMention(null);
  }, [input]);

  // Pasting an image adds a thumbnail row above the composer, which resizes the thread box: it stays where it was.
  useLayoutEffect(() => {
    scrollHold.restore();
  }, [pendingImages]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // Reset to the natural `rows={1}` height first. When the input is
    // empty we stop here — measuring scrollHeight on an empty textarea
    // before layout settles can return a stale value (the previous
    // height of the element), which made the box render unnaturally
    // tall on mount and reset on first keystroke. Only grow when there
    // is actual content to fit.
    el.style.height = "auto";
    // Never a scrollbar until the text itself passes the cap (an empty or one-line composer has none).
    el.style.overflowY = "hidden";
    if (input.length === 0) return;
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
    if (el.scrollHeight > COMPOSER_MAX_PX) el.style.overflowY = "auto";
  }, [input]);

  // One line at any width, cut with an ellipsis (src/fitPlaceholder.ts).
  const placeholder = useFittedPlaceholder(
    inputRef,
    archived ? (older ? OLDER_CHAT : ARCHIVED_THREAD) : boxDown ? `${BOX_UNREACHABLE} — ${downWhy}. Retrying…` : !ready ? (vaultPath ? "Connecting to the box…" : "Open a vault first") : "Ask anything, or / for commands…",
  );

  const send = () => {
    if (!ready || aiBlocked) return;
    void sendDraft();
  };
  const stop = stopAgent;
  const hasDraft = !!input.trim() || pendingImages.length > 0 || pendingFiles.length > 0;

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Snapshot items synchronously — clipboardData is invalidated as
    // soon as the handler returns, so we can't read items inside
    // FileReader callbacks. Collect blobs first, then promote them
    // to data URLs and batch-append in one setState to avoid losing
    // a paste-then-Enter race (if the user hits send before all
    // readers fire, only the resolved ones land).
    const blobs: File[] = [];
    const others: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      if (item.type.startsWith("image/")) blobs.push(file);
      else others.push(file);
    }
    // Some native webviews expose copied browser images as HTML, not Files.
    // Parse only to extract inline pixels; no clipboard markup/URLs are rendered.
    const html = blobs.length || others.length ? "" : e.clipboardData.getData("text/html");
    // A detached template stays inert (including remote img/iframe resources).
    const clipboard = document.createElement("template");
    if (html.length <= 20 * 1024 * 1024) clipboard.innerHTML = html;
    const inline = clipboardImageDataUrls(Array.from(clipboard.content.querySelectorAll("img"), (img) => img.getAttribute("src") ?? ""));
    if (blobs.length === 0 && others.length === 0 && inline.length === 0) return;
    e.preventDefault();
    scrollHold.hold();
    if (inline.length) attachImages(inline.map((imageDataUrl) => ({ imageDataUrl })));
    // A file copied in Explorer and pasted here: attached like a dropped one.
    if (others.length) void Promise.all(others.map((f) => attachBlob(f.name, f))).then(addAttached);
    Promise.all(
      blobs.map(
        (b) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(b);
          }),
      ),
    ).then((urls) => {
      const additions = urls.filter(Boolean).map((u) => ({ imageDataUrl: u }));
      attachImages(additions);
    });
  };

  const filteredSkills = skillMention ? skills.filter((s) => s.name.startsWith(skillMention.query)) : [];
  const matchedFiles = fileMention ? filterFilesForMention(files, vaultPath, fileMention.query).slice(0, 8) : [];

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (skillMention && filteredSkills.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSkillMentionIdx((i) => Math.min(i + 1, filteredSkills.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSkillMentionIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const hit = filteredSkills[skillMentionIdx] ?? filteredSkills[0];
        pickSkill(hit.name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSkillMention(null);
        return;
      }
    }
    if (fileMention && matchedFiles.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFileMentionIdx((i) => Math.min(i + 1, matchedFiles.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFileMentionIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const hit = matchedFiles[fileMentionIdx] ?? matchedFiles[0];
        pickMention(hit);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setFileMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // Never fire mid-IME-composition (e.g. CJK candidate selection) — the
      // Enter that commits a composition must not send the message.
      if ((e.nativeEvent as { isComposing?: boolean }).isComposing) return;
      e.preventDefault();
      send();
      return;
    }
    if ((busy || held) && e.key === "Escape") {
      e.preventDefault();
      stop();
    }
  };

  const onInputChange = (v: string) => {
    setInputOnly(v);
    const caret = inputRef.current?.selectionStart ?? v.length;
    const upToCaret = v.slice(0, caret);
    // /skill tokens at caret — same shape as @mentions so skills can
    // be invoked anywhere in the message, not only at input start.
    const slashMatch = upToCaret.match(/(^|\s)\/([\w-]*)$/);
    if (slashMatch) {
      setSkillMention({ query: slashMatch[2], start: caret - slashMatch[2].length - 1 });
      setSkillMentionIdx(0);
    } else {
      setSkillMention(null);
    }
    // @file tokens at caret.
    const atMatch = upToCaret.match(/(^|\s)@([^\s]*)$/);
    if (atMatch) {
      setFileMention({ query: atMatch[2], start: caret - atMatch[2].length - 1 });
      setFileMentionIdx(0);
    } else {
      setFileMention(null);
    }
    // Drop any tracked mention whose @name no longer appears in the text (deleted inline).
    const mentions = useDraft.getState().mentions;
    if (mentions.length) setMentions((prev) => prev.filter((m) => new RegExp(`(^|\\s)@${escapeRegExp(m.name)}(?![\\w./-])`).test(v)));
  };

  const pickSkill = (name: string) => {
    if (!skillMention) {
      // Fallback: no caret ref (programmatic invoke). Insert at end.
      setInputOnly(input.length ? `${input.replace(/\s+$/, "")} /${name} ` : `/${name} `);
      setSkillMention(null);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    const before = input.slice(0, skillMention.start);
    const after = input.slice(skillMention.start + 1 + skillMention.query.length);
    const insertion = `/${name} `;
    setInputOnly(`${before}${insertion}${after.replace(/^\s+/, "")}`);
    setSkillMention(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      const pos = before.length + insertion.length;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
  };

  const pickMention = (hit: MentionHit) => {
    if (!fileMention) return;
    const before = input.slice(0, fileMention.start);
    const after = input.slice(fileMention.start + 1 + fileMention.query.length);
    // Keep the @name inline in the textarea — no chip. The mentions array still tracks the exact path so the send can
    // resolve basenames to their source even when two files share a name.
    const insertion = `@${hit.name} `;
    setInputOnly(`${before}${insertion}${after.replace(/^\s+/, "")}`);
    addReference({ rel: hit.rel, path: hit.path, name: hit.name, raw: `@${hit.name}` }, true);
    setFileMention(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      const pos = before.length + insertion.length;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
  };

  // The + menu. Every path the composer already has, in one place: files from disk (images as attachments, the rest
  // as @-references), a region of the open file (the marquee — over the chat in fullscreen, which has no viewer), and
  // the @ picker for vault files.
  const addFiles = async () => {
    setPlusOpen(false);
    let picked: string | string[] | null = null;
    try {
      picked = await openDialog({ multiple: true, directory: false, defaultPath: vaultPath ?? undefined });
    } catch (e) {
      console.warn("[attach] file dialog failed:", e);
      return;
    }
    await attachPaths(picked == null ? [] : Array.isArray(picked) ? picked : [picked]);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const captureRegion = () => {
    setPlusOpen(false);
    if (!capturable) return;
    // The one capture start (src/capture.ts), as app/viewer's capture action.
    startCapture("chat");
  };
  const mentionVaultFile = () => {
    setPlusOpen(false);
    const el = inputRef.current;
    const v = `${input}${input && !/\s$/.test(input) ? " " : ""}@`;
    if (el) {
      el.value = v;
      el.setSelectionRange(v.length, v.length);
      el.focus();
    }
    onInputChange(v);
  };

  return (
    <>
      {/* Signed out of Claude, the composer is the one thing the chat pane
          blocks: the thread above it stays readable, and everything outside
          this pane (vaults, the tree, the editor, the viewer) is untouched.
          Carl: "the app should work without claude, only the AI features
          should be blocked by sign in." */}
      {aiBlocked ? (
        <ClaudeSignInPrompt surface="chat" />
      ) : (
        <div
          className={cn("relative flex flex-col rounded-2xl border border-border bg-background focus-within:border-ring/40 focus-within:ring-[0.5px] focus-within:ring-ring/20 transition-colors", dropOver && "border-ring/60 ring-1 ring-ring/30")}
          data-el="composer"
          // A file dropped from Explorer: attached (images as images; anything else uploaded with the message).
          onDragOver={(e) => {
            if (!ready || !isExternalFileDrop(e.dataTransfer)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            if (!dropOver) setDropOver(true);
          }}
          onDragLeave={() => setDropOver(false)}
          onDrop={(e) => {
            setDropOver(false);
            if (!ready || !isExternalFileDrop(e.dataTransfer)) return;
            e.preventDefault();
            const dropped = Array.from(e.dataTransfer.files);
            const images = dropped.filter((f) => f.type.startsWith("image/") && f.size <= ATTACH_MAX_BYTES);
            const rest = dropped.filter((f) => !images.includes(f));
            for (const f of images) {
              const r = new FileReader();
              r.onload = () => attachImages([{ imageDataUrl: String(r.result), sourcePath: f.name }]);
              r.readAsDataURL(f);
            }
            if (rest.length) void Promise.all(rest.map((f) => attachBlob(f.name, f))).then(addAttached);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          {skillMention && filteredSkills.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 max-h-[240px] overflow-auto bg-popover border-t border-x border-border shadow-lg z-10">
              {filteredSkills.slice(0, 8).map((s, i) => (
                <div
                  key={s.name}
                  className={cn("flex items-baseline gap-3 px-3 py-2 cursor-pointer border-b border-border/40 last:border-b-0", i === skillMentionIdx ? "bg-accent" : "hover:bg-accent/60")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSkill(s.name);
                  }}
                  onMouseEnter={() => setSkillMentionIdx(i)}
                >
                  <span className="text-primary font-mono text-[12.5px] font-medium shrink-0">/{s.name}</span>
                  {s.description && <span className="text-muted-foreground text-[11px] truncate">{s.description}</span>}
                </div>
              ))}
            </div>
          )}
          {fileMention && matchedFiles.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 max-h-[240px] overflow-auto bg-popover border-t border-x border-border shadow-lg z-10">
              {matchedFiles.map((f, i) => (
                <div
                  key={f.path}
                  className={cn("flex items-baseline gap-3 px-3 py-2 cursor-pointer border-b border-border/40 last:border-b-0", i === fileMentionIdx ? "bg-accent" : "hover:bg-accent/60")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(f);
                  }}
                  onMouseEnter={() => setFileMentionIdx(i)}
                >
                  <span className="text-primary font-mono text-[12.5px] font-medium shrink-0 max-w-[50%] truncate">{f.name}</span>
                  <span className="text-muted-foreground text-[11px] truncate font-mono">{f.rel}</span>
                </div>
              ))}
            </div>
          )}
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2" data-el="attached-files">
              {pendingFiles.map((f, i) => (
                <div key={i} className="group relative flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 pl-2 pr-2.5 py-1 text-[11.5px]" data-el="attached-file">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="max-w-[220px] truncate text-foreground/90" title={f.name}>
                    {f.name}
                  </span>
                  <span className="text-[10.5px] text-muted-foreground">{sizeLabel(f.size)}</span>
                  <button data-offer="app/composer.detach"
                    onClick={() => detachItem("file", i)}
                    className="absolute -top-1.5 -right-1.5 h-4 w-4 flex items-center justify-center rounded-full bg-card border border-border text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
                    title="Remove"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {attachError && (
            <div className="flex items-start gap-1.5 px-3 pt-2 text-[11px] text-destructive/90" data-el="attach-error">
              <AlertCircle className="h-3 w-3 mt-px shrink-0" />
              <span className="min-w-0 break-words">{attachError}</span>
              <button data-offer="app/composer.attach" onClick={() => setAttachError(null)} className="ml-auto shrink-0 text-muted-foreground hover:text-foreground" title="Dismiss">
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          {pendingImages.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-2">
              {pendingImages.map((img, i) => {
                const name = img.sourcePath?.split("/").pop();
                return (
                  <div key={i} className="relative group flex flex-col items-start gap-0.5">
                    <img
                      src={img.imageDataUrl}
                      alt={`captured ${i + 1}`}
                      className="max-h-[72px] rounded border border-border/60"
                      onLoad={() => {
                        scrollHold.restore();
                      }}
                    />
                    {name && (
                      <span className="text-[9.5px] text-muted-foreground font-mono">
                        {name}
                        {img.sourceAnchor ? ` · ${img.sourceAnchor}` : ""}
                      </span>
                    )}
                    <button data-offer="app/composer.detach"
                      onClick={() => detachItem("image", i)}
                      className="absolute -top-1.5 -right-1.5 h-4 w-4 flex items-center justify-center rounded-full bg-card border border-border text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
                      title="Remove"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="relative flex items-end">
            <div className="absolute left-2 bottom-2 z-10">
              <button data-offer="app/composer.attach"
                onClick={() => setPlusOpen((o) => !o)}
                disabled={!ready}
                data-el="composer-plus"
                className={cn(
                  "h-7 w-7 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed",
                  plusOpen && "bg-accent/60 text-foreground",
                )}
                title="Add files, capture a region, or mention a vault file"
              >
                <Plus className="h-4 w-4" />
              </button>
              {plusOpen && (
                <>
                  <div className="fixed inset-0 z-10" onMouseDown={() => setPlusOpen(false)} />
                  <div data-el="composer-plus-menu" className="absolute bottom-full left-0 mb-1.5 z-20 w-60 rounded-lg border border-border bg-popover p-1 shadow-lg text-[12.5px]">
                    <PlusItem icon={<Paperclip className="h-3.5 w-3.5" />} label="Add photos & files" onClick={() => void addFiles()} />
                    <PlusItem
                      icon={<Scan className="h-3.5 w-3.5" />}
                      label="Capture a region"
                      hint={capturable ? "Drag over the open file" : "Open a PDF, HTML file or image first"}
                      disabled={!capturable || busy}
                      onClick={captureRegion}
                    />
                    <PlusItem icon={<AtSign className="h-3.5 w-3.5" />} label="Mention a vault file" onClick={mentionVaultFile} />
                  </div>
                </>
              )}
            </div>
            <Textarea
              data-perf-target="composer"
              ref={inputRef}
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={onKey}
              onPaste={onPaste}
              placeholder={placeholder}
              disabled={!ready}
              rows={1}
              className={cn(
                "composer-input border-0 bg-transparent min-h-0 max-h-[200px] overflow-y-hidden focus-visible:ring-0 shadow-none !py-2",
                voiceMode || voiceNotice ? (chatFullscreen ? "!pr-52" : "!pr-40") : chatFullscreen && voiceError ? "!pr-32" : "!pr-20",
                "!pl-11",
              )}
            />
            <div className="absolute right-3 bottom-2 flex items-center gap-1">
              {/* Mute, by the composer while voice is on (or where voice went, when it moved to another device). */}
              <VoiceMuteButton />
              {chatFullscreen && <InlineVoiceWaves />}
              {chatFullscreen && (
                <button data-offer="app/voice.start"
                  // Voice runs in the main window (the popout's mic asks it).
                  onClick={isPopout ? () => dispatchChatAction({ kind: "toggleVoice" }) : () => toggleVoice("mic button")}
                  disabled={!vaultPath}
                  data-el="composer-voice"
                  className={cn("h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent/60 hover:text-foreground disabled:opacity-40", voiceMode ? "text-foreground" : "text-muted-foreground")}
                  title={voiceMode ? `Voice on — ${shortcutHint("voice.toggle")} to turn off` : `Voice (${shortcutHint("voice.toggle")})`}
                >
                  <Mic className="h-3.5 w-3.5" strokeWidth={voiceMode ? 2.5 : 2} />
                </button>
              )}
              {/* As in Claude Code: with something to send the button is Send (while the agent works too: it reads
                  the message at its next step); with nothing typed while it works, Stop. */}
              {(busy || held) && !hasDraft ? (
                <Button data-offer="app/composer.stop" size="icon" variant="secondary" onClick={stop} className="h-7 w-7 rounded-lg" title={held ? "Don't pick it up at the reset (Esc)" : "Stop the agent (Esc)"} data-el="composer-stop">
                  <Square className="h-3 w-3 fill-current" />
                </Button>
              ) : (
                <Button data-offer="app/composer.send" size="icon" onClick={send} disabled={!ready || !hasDraft} className="h-7 w-7 rounded-lg" title={busy ? "Send — the agent reads it at its next step" : "Send"} data-el="composer-send">
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between px-1 pt-1.5 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-3 min-w-0">
          {/* What this chat runs on, and how hard it thinks (src/chatModels.ts). */}
          <ChatModelPicker convId={activeConversationId} />
          {boxDown && (
            <span className="truncate text-amber-500/90" data-el="box-unreachable" title={reason || undefined}>
              {BOX_UNREACHABLE}: {downWhy}
            </span>
          )}
        </div>
        <ChatFooterTools ready={ready} archived={archived} />
      </div>
    </>
  );
}

function PlusItem({ icon, label, hint, disabled, onClick }: { icon: React.ReactNode; label: string; hint?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button data-offer-exempt="a UI primitive: each use names its own offer"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className="w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-foreground hover:bg-accent/60 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
  );
}
