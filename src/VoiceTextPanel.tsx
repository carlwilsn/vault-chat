import { useEffect, useRef, useState } from "react";
import { Camera, X, GripHorizontal, ArrowUp } from "lucide-react";
import { Button } from "./ui";
import { useStore } from "./store";
import { fileKind } from "./fileKind";
import {
  isVoiceSessionActive,
  setVoiceMicMuted,
  setVoiceOutputMuted,
  sendVoiceUserText,
  sendVoiceUserMultimodal,
  sendVoiceTypingHint,
} from "./voice-elevenlabs";

// Plug-replacement for talking back to the voice agent: a floating
// popup with an auto-grow textarea + the same marquee/camera button
// the chat composer has. While it's open the mic is muted so background
// noise doesn't barge in. The agent still speaks its replies aloud —
// only the user side flips from voice to text.
//
// Why a popup instead of a panel sash: this is intended for shared
// spaces (library, commute) where you might want to drag it out of
// the way of whatever paper you're reading. Fixed position + drag
// handle is the lightest version of that.

const PANEL_W = 360;
const TEXTAREA_MIN_H = 36;
const TEXTAREA_MAX_H = 200;

export function VoiceTextPanel() {
  const open = useStore((s) => s.voiceTextPanelOpen);
  const setOpen = useStore((s) => s.setVoiceTextPanelOpen);
  const voiceMode = useStore((s) => s.voiceMode);
  const currentFile = useStore((s) => s.currentFile);
  const voiceLastCapture = useStore((s) => s.voiceLastCapture);
  const setVoiceLastCapture = useStore((s) => s.setVoiceLastCapture);
  const setVoiceCapturePending = useStore((s) => s.setVoiceCapturePending);
  const setChatPaneCapturePending = useStore((s) => s.setChatPaneCapturePending);
  const setEditPromptCapturePending = useStore((s) => s.setEditPromptCapturePending);
  const setNoteCapturePending = useStore((s) => s.setNoteCapturePending);

  const [text, setText] = useState("");
  const [pendingImage, setPendingImage] = useState<{
    imageDataUrl: string;
    sourcePath: string;
    sourceAnchor: string | null;
  } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragState = useRef<{ dx: number; dy: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Force-close if voice mode ends while the panel is open. Keeping a
  // panel up after the session is gone would silently swallow input.
  useEffect(() => {
    if (open && !voiceMode) setOpen(false);
  }, [open, voiceMode, setOpen]);

  // Mute the mic while the panel is open. The popup itself is the
  // "stop listening to me" gesture — opening it implies the user
  // doesn't want ambient room noise treated as speech. On close we
  // unmute (and unmute output too, belt-and-suspenders) so a hand-off
  // back to voice picks up immediately.
  //
  // Also tell the agent we're typing. Without the heads-up it reads
  // the muted silence as a drop-off and escalates to end_call after
  // three check-ins.
  useEffect(() => {
    if (!open) return;
    if (!isVoiceSessionActive()) return;
    setVoiceMicMuted(true);
    sendVoiceTypingHint("opened");
    return () => {
      setVoiceMicMuted(false);
      setVoiceOutputMuted(false);
    };
  }, [open]);

  // Re-send the hint if the user's drafting drags on. The first hint
  // arrived before they started writing — by the time they're 90s in
  // on a long question the agent may have drifted back toward filling
  // silence. Resets on every keystroke so it only fires during a
  // genuine long pause inside the panel.
  useEffect(() => {
    if (!open) return;
    if (!isVoiceSessionActive()) return;
    const id = setTimeout(() => sendVoiceTypingHint("still-typing"), 60_000);
    return () => clearTimeout(id);
  }, [open, text]);

  // Barge-in via typing: once the draft crosses 2 characters, the
  // user is clearly intending to take the turn — cut the agent's TTS
  // so they can think. Restore audio on send (the next reply should
  // be audible) or when the draft drops back below the threshold
  // (rare, but handles a paste-then-clear).
  useEffect(() => {
    if (!open) return;
    if (!isVoiceSessionActive()) return;
    setVoiceOutputMuted(text.trim().length >= 2);
  }, [text, open]);

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // Pull marquee captures meant for this panel out of the store —
  // mirrors what ChatPane does with chatPaneLastCapture.
  useEffect(() => {
    if (!open) return;
    if (!voiceLastCapture) return;
    setPendingImage(voiceLastCapture);
    setVoiceLastCapture(null);
  }, [open, voiceLastCapture, setVoiceLastCapture]);

  // Auto-grow the textarea up to TEXTAREA_MAX_H, then scroll inside.
  // Toggle overflow-y to hidden until we're actually capped — on
  // Windows the scrollbar reserves visible space even when nothing
  // overflows, which reads as a useless permanent gutter.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    const measured = el.scrollHeight;
    const next = Math.min(TEXTAREA_MAX_H, Math.max(TEXTAREA_MIN_H, measured));
    el.style.height = `${next}px`;
    el.style.overflowY = measured > TEXTAREA_MAX_H ? "auto" : "hidden";
  }, [text, open]);

  if (!open) return null;

  const defaultPos = (): { x: number; y: number } => {
    const margin = 16;
    const x = Math.max(margin, window.innerWidth - PANEL_W - margin);
    const y = 56;
    return { x, y };
  };
  const p = pos ?? defaultPos();

  const onDragStart = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const start = pos ?? defaultPos();
    dragState.current = { dx: e.clientX - start.x, dy: e.clientY - start.y };
    const onMove = (ev: MouseEvent) => {
      const d = dragState.current;
      if (!d) return;
      const margin = 4;
      const x = Math.max(
        margin,
        Math.min(window.innerWidth - PANEL_W - margin, ev.clientX - d.dx),
      );
      const y = Math.max(
        margin,
        Math.min(window.innerHeight - 80 - margin, ev.clientY - d.dy),
      );
      setPos({ x, y });
    };
    const onUp = () => {
      dragState.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    e.preventDefault();
  };

  const canMarquee = (() => {
    if (!currentFile) return false;
    const k = fileKind(currentFile).kind;
    return k === "pdf" || k === "html" || k === "image";
  })();

  const onCapture = () => {
    if (!canMarquee) return;
    // Steal the marquee queue from the other consumers — viewers route
    // by the first pending flag they see, so clear the others to be safe.
    setChatPaneCapturePending(false);
    setEditPromptCapturePending(false);
    setNoteCapturePending(false);
    setVoiceCapturePending(true);
    window.dispatchEvent(new CustomEvent("vc-marquee-toggle"));
  };

  const removeImage = () => setPendingImage(null);

  const send = async () => {
    if (!isVoiceSessionActive()) return;
    const t = text.trim();
    if (!t && !pendingImage) return;
    if (pendingImage) {
      const ok = await sendVoiceUserMultimodal(t, pendingImage.imageDataUrl);
      if (!ok) return;
    } else {
      const ok = sendVoiceUserText(t);
      if (!ok) return;
    }
    setText("");
    setPendingImage(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const onTextareaKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const canSend = !!text.trim() || !!pendingImage;

  return (
    <div
      style={{ left: p.x, top: p.y, width: PANEL_W }}
      className="fixed z-50 rounded-lg border border-border bg-card shadow-xl"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Handle row: grip + title on the left, camera + close on the
          right. Camera lives here (not in a bottom action row) so the
          panel stays lean — the textarea is the body, the handle is
          the chrome, that's it. */}
      <div
        className="flex items-center gap-1 px-2 h-7 border-b border-border/70 cursor-move select-none text-muted-foreground"
        onMouseDown={onDragStart}
        title="Drag to reposition"
      >
        <GripHorizontal className="h-3 w-3" />
        <span className="text-[11px] font-medium">Type to voice agent</span>
        <div className="flex-1" />
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onCapture}
          disabled={!canMarquee}
          className="h-5 w-5 flex items-center justify-center rounded hover:bg-accent/60 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
          title={
            canMarquee
              ? "Capture a region from the current viewer"
              : "Open a PDF, HTML file, or image to capture a region"
          }
        >
          <Camera className="h-3 w-3" />
        </button>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setOpen(false)}
          className="h-5 w-5 flex items-center justify-center rounded hover:bg-accent/60 hover:text-foreground"
          title="Close (Esc)"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {pendingImage && (
        <div className="px-2 pt-2">
          <div className="relative inline-block">
            <img
              src={pendingImage.imageDataUrl}
              alt="capture"
              className="max-h-24 rounded border border-border"
            />
            <button
              onClick={removeImage}
              className="absolute -top-1.5 -right-1.5 h-4 w-4 flex items-center justify-center rounded-full bg-card border border-border text-muted-foreground hover:text-foreground"
              title="Remove image"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        </div>
      )}

      {/* Textarea + trailing send button, matching the main composer:
          a real rounded primary button at bottom-right (claude-code
          style), not an inline glyph. Padding-right reserves space so
          long lines don't slide under it. */}
      <div className="p-2">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onTextareaKey}
            placeholder="Type a reply…"
            spellCheck={false}
            className="w-full resize-none rounded-md border border-border bg-background pl-2 pr-10 py-1.5 text-[13px] leading-snug outline-none focus:border-primary/60"
            style={{ minHeight: TEXTAREA_MIN_H, maxHeight: TEXTAREA_MAX_H, overflowY: "hidden" }}
          />
          <Button
            size="icon"
            onClick={() => void send()}
            disabled={!canSend}
            className="absolute right-1.5 bottom-1.5 h-7 w-7 rounded-lg"
            title="Send (Enter)"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
