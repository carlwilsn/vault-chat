// What to say when a box can't be reached, in one line.
//
// Carl, on connecting a box: a failed check said `School2 didn't answer:
// error sending request for url (…)`, which says nothing he can act on. A box
// is reached over his tailnet, so the one thing worth saying is whether
// Tailscale is installed and connected — and the one thing to offer is opening
// it (or getting it). vault-chat never asks for a Tailscale login itself.
import { unreachableWhy } from "./boxChat";
import type { TailscaleState } from "./vaultSync";

/** Where Tailscale is downloaded from, for a laptop that hasn't got it. */
export const GET_TAILSCALE_URL = "https://tailscale.com/download";

export type TailscaleHelp = {
  /** The line to show, as a whole sentence. */
  line: string;
  /** The one thing to offer: the app (installed) or the download (not). */
  action: { label: string; kind: "open" | "get" } | null;
};

/**
 * The Tailscale line for this laptop's state, or null when Tailscale is not
 * the problem — connected, or never asked (a null check is "don't know", and
 * guessing would put a wrong sentence on screen).
 */
export function tailscaleHelp(ts: TailscaleState | null | undefined): TailscaleHelp | null {
  if (!ts) return null;
  if (!ts.installed) {
    return {
      line: "Tailscale isn't installed on this laptop, so there is no tailnet to find a box on.",
      action: { label: "Get Tailscale", kind: "get" },
    };
  }
  if (!ts.connected) {
    const how = ts.state === "NoService" ? "isn't running" : ts.state === "NeedsLogin" ? "isn't signed in" : `is “${ts.state}”`;
    return {
      line: `Tailscale ${how} on this laptop, so the box can't be reached. Connect it and look again.`,
      // Without the app there is nothing to open — the line still says what is wrong.
      action: ts.canOpen ? { label: "Open Tailscale", kind: "open" } : null,
    };
  }
  return null;
}

/**
 * Why a box didn't answer, as the one line to show: Tailscale's when that is
 * the reason (with the one thing to do about it), else the box's own, short and
 * in words. `name` is what Carl called the box (or its address), so he knows
 * which one this is about.
 */
export function connectTrouble(name: string, raw: string, ts: TailscaleState | null | undefined): TailscaleHelp {
  return tailscaleHelp(ts) ?? { line: `${name} didn't answer: ${unreachableWhy(raw, ts ?? null)}.`, action: null };
}
