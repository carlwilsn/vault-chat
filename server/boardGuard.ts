// Where a visual goes: the answer appears where Carl is talking. The iPad
// board inbox is for when he asks for it ("send it to my iPad", "put it on the
// board") or is at the board now (his newest activity is on the board, or a
// voice call is live there). Otherwise BoardSend / BoardMake / Show "board" get
// a refusal that says why and what to do instead (Show it here, or put the
// image in the reply) — never a silent block, and never a send to a device
// across the room. `asked: true` is the agent's way to say Carl did ask (an
// earlier message, or words this check does not know).
import type { Device } from "./show";

const DEVICE_NAME: Record<Device, string> = { laptop: "laptop", board: "iPad", phone: "phone" };

/** Only the actual human request is passed here, never page/context text. */
const NAMES_BOARD = /\b(?:i\s?pad|board|whiteboard|inbox|tablet)\b/i;
export function asksForBoard(request: string | null | undefined): boolean {
  return NAMES_BOARD.test(String(request ?? ""));
}

export type BoardGuardInput = {
  vault: string;
  /** His latest message in this conversation (what he asked). */
  request: string | null;
  /** The agent says Carl asked for the board (earlier, or in words not matched here). */
  asked?: boolean;
  /** Which tool (for the message). */
  tool: "BoardSend" | "BoardMake" | "Show";
  /** Authoritative originating interaction, not a viewer/poll or another live call. */
  device?: Device | null;
};

/**
 * Null: the board is fine (he asked or this interaction is at the board).
 * A string: why not, and what to do instead — the tool's result, nothing sent.
 */
export function boardGuard(o: BoardGuardInput): string | null {
  if (o.asked === true) return null;
  if (asksForBoard(o.request)) return null;
  if (o.device === "board") return null;
  const dev = o.device ? DEVICE_NAME[o.device] : "unknown device";
  const what = o.tool === "BoardMake" ? "Nothing was made or sent" : "Nothing was sent";
  return (
    `Not sent to the board: Carl is on his ${dev}, not at the iPad, and his request didn't ask for the board. ${what}. ` +
    `Show it where he is talking instead: make the visual as a file in the vault (an SVG you write, or a PNG), put it in your reply as ![what it shows](its/vault/path.svg) — it shows inline in the chat on every device — and/or open it with Show {path} (where "here": his ${dev}). ` +
    `If Carl did ask for the board or iPad (in an earlier message, or in words this check missed), send again with asked: true.`
  );
}
