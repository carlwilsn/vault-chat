// Whether the AI features are on, and the one prompt every blocked AI surface
// shows. Pure: no React, no store, no box client — the phone and the board
// import this too, and neither can carry the desktop's store. The laptop's live
// answer (the hook, the health cache) is in src/claudeAuthLive.ts.
//
// vault-chat runs on Claude Code and nothing else, so "signed in" is a single
// question with a single answer, and every surface that needs the agent asks it
// here. Carl, after installing a build that gated the whole window: "the app
// should work without claude, only the AI features should be blocked by sign
// in." So nothing in this module hides a vault, a file, the editor or the
// board — it only decides whether the chat composer, voice and the board's and
// phone's AI actions are live.
//
// Two sources, either of which is enough:
//  - this laptop's keychain (src/keychain.ts KEY.claudeCode, mirrored into the
//    store as serviceKeys.claudeCode). Having the token here means the next
//    connect pushes it (src/boxKeys.ts), so the box will have it.
//  - the box's own report (/api/v1/health → engine.engines.claude.signedIn,
//    read through src/engineHealth.ts claudeOf, which copes with both health
//    shapes). This is what makes a laptop that has never held the token — keys
//    imported from another machine, or a box signed in directly — still work.
import { claudeOf } from "./engineHealth";

/** The answer, and whether it is known yet (a health read is a network call). */
export type ClaudeAuth = { signedIn: boolean; known: boolean };

/**
 * The decision, as a pure function of the two sources. `health` is the parsed
 * /api/v1/health body, or null when it has not been read (or could not be).
 */
export function claudeSignedIn(laptopKey: string | null | undefined, health: unknown): boolean {
  if (typeof laptopKey === "string" && laptopKey.trim() !== "") return true;
  return claudeOf(health)?.signedIn === true;
}

/**
 * The whole answer a surface needs, including whether anything is being asked.
 *
 * `vault` is the open vault: with none there is no box and no server of this
 * app's own, so nothing but this machine's own token could say "signed in" —
 * and that is an answer, not a wait. (A fresh install sat on "Checking your
 * Claude sign-in…" for ever, which was the first line in Settings and the one
 * place the button belongs.) With a vault open and no health yet, it IS a wait:
 * showing "sign in" to someone who is signed in is worse than a moment's delay.
 */
export function claudeAuthOf(laptopKey: string | null | undefined, vault: string | null, health: unknown): ClaudeAuth {
  if (typeof laptopKey === "string" && laptopKey.trim() !== "") return { signedIn: true, known: true };
  if (!vault) return { signedIn: false, known: true };
  if (health == null) return { signedIn: false, known: false };
  return { signedIn: claudeSignedIn(laptopKey, health), known: true };
}

/**
 * What a client with no keychain of its own (the phone, the board) makes of a
 * health body: true / false as the box reports, and null while it has not been
 * read. A box that reports no Claude Code at all blocks nothing — it may be an
 * older box, and blocking its AI over a field it never sends would be a lie.
 */
export function claudeSignedInOnBox(health: unknown): boolean | null {
  if (health == null) return null;
  const c = claudeOf(health);
  return c ? c.signedIn : true;
}

// ---- the prompt every blocked surface shows ---------------------------------

/** The one button. The same words wherever the prompt appears. */
export const SIGN_IN_BUTTON = "Sign in with Claude";

/**
 * One sentence per surface, reworded for what is blocked there. Shared with the
 * phone and the board (which draw their own markup) so the words cannot drift.
 */
export const SIGN_IN_LINE = {
  chat: "Sign in with Claude to chat",
  voice: "Sign in with Claude to talk",
  board: "Sign in with Claude to ask about this board",
  phone: "Sign in with Claude to chat",
} as const;

export type SignInSurface = keyof typeof SIGN_IN_LINE;

/**
 * Where the sign-in itself has to happen. The token comes out of a pty running
 * `claude setup-token` and goes into the laptop's own keychain
 * (src-tauri/src/claude_login.rs), so the phone and the board cannot finish it:
 * they say this instead of offering a button that would dead-end.
 */
export const SIGN_IN_ELSEWHERE = "Sign in on your laptop: vault-chat → Settings.";
