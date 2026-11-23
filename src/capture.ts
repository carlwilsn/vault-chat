// Region capture (a marquee dragged over the viewer): who the picture goes to. Every Capture button (the composer's +
// menu, the voice text panel, the note composer, Ctrl+M's ask) starts one here, and app/viewer's capture action starts
// the same; the flags it sets are what app/viewer's capture state reads.
import { useStore } from "./store";
import { isPopout } from "./windowKind";
import { dispatchChatAction } from "./sync";

export type CaptureFor = "chat" | "voice" | "note" | "ask";

/** Start a capture whose picture goes to `to`: the chat's composer, the voice text panel, the note composer (it hides
 *  while Carl drags, src/noteComposer.ts captureForNote), or a Ctrl+K box at the region (Ctrl+M). */
export function startCapture(to: CaptureFor): void {
  const s = useStore.getState();
  if (to === "note") {
    void import("./noteComposer").then((m) => m.captureForNote());
    return;
  }
  s.setEditPromptCapturePending(false);
  s.setNoteCapturePending(false);
  if (to !== "voice") s.setVoiceCapturePending(false);
  if (to !== "chat") s.setChatPaneCapturePending(false);
  if (to === "chat" && isPopout) {
    // The popout: the main window runs the marquee and bounces the picture back.
    dispatchChatAction({ kind: "startCapture" });
    return;
  }
  if (to === "chat") s.setChatPaneCapturePending(true);
  if (to === "voice") s.setVoiceCapturePending(true);
  // Fullscreen chat has no viewer: App shows the open file over the chat and starts the marquee there.
  const st = useStore.getState();
  window.dispatchEvent(new CustomEvent(to !== "ask" && st.chatFullscreen && !st.popoutOpen ? "vc-fullscreen-capture" : "vc-marquee-toggle"));
}

/** Who a capture under way is for (box: an open Ctrl+K box's own Capture, app/ask capture), or null. */
export function captureNow(): CaptureFor | "box" | null {
  const s = useStore.getState();
  return s.chatPaneCapturePending ? "chat" : s.voiceCapturePending ? "voice" : s.noteCapturePending ? "note" : s.editPromptCapturePending ? "box" : null;
}
