// Where a visual goes: the answer appears where Carl is talking. The iPad
// board inbox is for when he asks for it ("send it to my iPad", "put it on the
// board") or is at the board now (his newest activity is on the board, or a
// voice call is live there). Otherwise BoardSend / BoardMake / Show "board" get
// a refusal that says why and what to do instead (Show it here, or put the
// image in the reply) — never a silent block, and never a send to a device
// across the room. `asked: true` is the agent's way to say Carl did ask (an
// earlier message, or words this check does not know).
import { resolve } from "node:path";
import { currentDevice, type Device } from "./show";
import { liveVoiceSession } from "./voice";
import { liveCalls } from "./voiceBrain";

const DEVICE_NAME: Record<Device, string> = { laptop: "laptop", board: "iPad", phone: "phone" };

/** Words in his request that name the board / iPad (or say he is away from the laptop). */
const NAMES_BOARD = /\b(?:i\s?pad|board|whiteboard|inbox|tablet)\b|\b(?:not|away from)\s+(?:near\s+)?(?:at\s+)?my\s+(?:laptop|computer)\b/i;

/** Does his request ask for the board? Only his own words: the context lines the surfaces prepend (a PDF page's
 *  text, the "[Carl, on …]" line, attachments) are not his request. */
export function asksForBoard(request: string | null | undefined): boolean {
  return NAMES_BOARD.test(requestWords(request));
}

/** His words in a user message: the surface's context lines out. */
export function requestWords(request: string | null | undefined): string {
  const t = String(request ?? "");
  // The laptop's context block: everything up to the page text it quotes ends where his words start, on the
  // last paragraph after the context markers. Keep only lines that are not the surface's.
  const lines = t.split("\n");
  const out: string[] = [];
  let inCtx = false;
  for (const l of lines) {
    if (/^\[Carl, on [^\]]*\]$/.test(l.trim())) continue;
    if (/^(?:>>> USER IS|FILE ATTACHMENTS|Page \d+ text content:|Any ambiguous reference|@.* — absolute path:|The user attached)/.test(l.trim())) {
      inCtx = true;
      continue;
    }
    if (inCtx && l.trim() === "") {
      inCtx = false;
      continue;
    }
    if (inCtx) continue;
    out.push(l);
  }
  return out.join("\n");
}

/** A voice call live on the board right now (either voice). */
function boardCallLive(vault: string): boolean {
  try {
    const v = liveVoiceSession();
    if (v && v.device === "board" && resolve(v.vault).toLowerCase() === resolve(vault).toLowerCase()) return true;
  } catch {
    /* */
  }
  try {
    return liveCalls().some((c) => c.device === "board");
  } catch {
    return false;
  }
}

export type BoardGuardInput = {
  vault: string;
  /** His latest message in this conversation (what he asked). */
  request: string | null;
  /** The agent says Carl asked for the board (earlier, or in words not matched here). */
  asked?: boolean;
  /** Which tool (for the message). */
  tool: "BoardSend" | "BoardMake" | "Show";
  now?: number;
  /** Tests: the board call check. */
  callLive?: (vault: string) => boolean;
};

/**
 * Null: the board is fine (he asked, he is at the board, or nothing says where he is).
 * A string: why not, and what to do instead — the tool's result, nothing sent.
 */
export function boardGuard(o: BoardGuardInput): string | null {
  if (o.asked === true) return null;
  if (asksForBoard(o.request)) return null;
  if ((o.callLive ?? boardCallLive)(o.vault)) return null;
  const cur = currentDevice(o.vault, o.now);
  if (!cur || cur.device === "board") return null;
  const dev = DEVICE_NAME[cur.device];
  const what = o.tool === "BoardMake" ? "Nothing was made or sent" : "Nothing was sent";
  return (
    `Not sent to the board: Carl is on his ${dev}, not at the iPad, and his request didn't ask for the board. ${what}. ` +
    `Show it where he is talking instead: make the visual as a file in the vault (an SVG you write, or a PNG), put it in your reply as ![what it shows](its/vault/path.svg) — it shows inline in the chat on every device — and/or open it with Show {path} (where "here": his ${dev}). ` +
    `If Carl did ask for the board or iPad (in an earlier message, or in words this check missed), send again with asked: true.`
  );
}
