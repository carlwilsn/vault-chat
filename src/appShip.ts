// The laptop app's errors and its box connection, on the box (2026-10-22): console errors, uncaught errors and
// rejections, and box.feed (the box dropped, with the error; connected again, with how long it was down) go from
// the local trail (src/debugLog.ts → app-log.txt) to the box too — POST /api/v1/board/log with source "app" →
// <state>/logs/app.jsonl, redacted by the box — batched every 15 s and when the page hides. While the box is out
// of reach they wait (a failed batch goes back in front), so a drop arrives with its end.
import { onVlog } from "./debugLog";
import { APP_SHIPPED, VoiceLogShipper } from "./voiceShip";
import { useStore } from "./store";

let installed = false;
const ship = new VoiceLogShipper({ device: "laptop", source: "app", only: APP_SHIPPED });

/** Start shipping (main.tsx, the main window only). Idempotent. */
export function installAppShip(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  ship.post = async (body) => {
    const { boxLinkFor, boxPost } = await import("./boxChat");
    const link = await boxLinkFor(useStore.getState().vaultPath);
    if (!link) throw new Error("no box");
    const r = await boxPost(link, "/api/v1/board/log", body);
    if (!r.ok) throw new Error(r.error ?? "not sent");
  };
  onVlog((tag, data) => {
    // The voice's own console lines go with the voice's (voice.jsonl, src/voice-elevenlabs.ts).
    if (typeof data === "string" && data.startsWith("[voice-eleven]")) return;
    ship.add(tag, data);
  });
  ship.installPageHide();
}

/** [tests] The app's shipper. */
export function appShipperForTests(): VoiceLogShipper {
  return ship;
}
