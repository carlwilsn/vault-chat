// The laptop's live answer to "is Claude signed in": the box's health, cached,
// plus this machine's keychain copy out of the store. The decision itself and
// the words every prompt says are in src/claudeAuth.ts, which is pure so the
// phone and the board can share them.
import { useEffect, useState } from "react";
import { useStore } from "./store";
import { claudeSignedIn, type ClaudeAuth } from "./claudeAuth";
import { claudeOf } from "./engineHealth";

// The last health read, shared by every hook instance so one surface opening
// does not make another re-fetch. `null` until the first read answers.
let lastHealth: { at: number; body: unknown } | null = null;
const HEALTH_FRESH_MS = 30_000;

/** The cached answer for code that cannot await (voiceCall's toggle). Null: not known yet. */
export function claudeSignedInNow(): boolean | null {
  const key = useStore.getState().serviceKeys.claudeCode;
  if (typeof key === "string" && key.trim() !== "") return true;
  if (!lastHealth) return null;
  return claudeOf(lastHealth.body)?.signedIn === true;
}

/** Read the box's health (through the same box link as everything else) and keep it. */
export async function readClaudeHealth(force = false): Promise<unknown> {
  if (!force && lastHealth && Date.now() - lastHealth.at < HEALTH_FRESH_MS) return lastHealth.body;
  const vault = useStore.getState().vaultPath;
  // Imported lazily: boxChat pulls in the chat feed, and this module is reached
  // from the titlebar's voice control, which loads before any vault is open.
  const { boxGet, boxLinkFor } = await import("./boxChat");
  const link = await boxLinkFor(vault).catch(() => null);
  if (!link) return lastHealth?.body ?? null;
  const body = await boxGet(link, "/api/v1/health", 8_000).catch(() => null);
  // A failed read must not look like "signed out": keep the last answer.
  if (body) lastHealth = { at: Date.now(), body };
  return lastHealth?.body ?? null;
}

/** Forget the cached health, so the next read asks the box again (after a sign-in or sign-out). */
export function forgetClaudeHealth(): void {
  lastHealth = null;
}

/**
 * The answer for a React surface. `known` is false until one of the two sources
 * has spoken: a surface must NOT show the sign-in prompt while it is false,
 * because flashing "sign in" at someone who is signed in is worse than showing
 * the composer for a moment longer.
 */
export function useClaudeSignedIn(): ClaudeAuth {
  const laptopKey = useStore((s) => s.serviceKeys.claudeCode);
  const vault = useStore((s) => s.vaultPath);
  const on = useStore((s) => !!s.boxChat?.on);
  const [health, setHealth] = useState<{ body: unknown } | null>(() => (lastHealth ? { body: lastHealth.body } : null));
  useEffect(() => {
    if (!on || !vault) return;
    let alive = true;
    const read = () => void readClaudeHealth().then((body) => alive && body != null && setHealth({ body }));
    read();
    // A sign-in done on the box, or a box that has just come up, lands here
    // without Carl reloading anything.
    const t = window.setInterval(read, HEALTH_FRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [on, vault]);
  if (typeof laptopKey === "string" && laptopKey.trim() !== "") return { signedIn: true, known: true };
  if (!health) return { signedIn: false, known: false };
  return { signedIn: claudeSignedIn(laptopKey, health.body), known: true };
}

// ---- voice's prompt --------------------------------------------------------

// Voice has no room of its own to put a prompt in: the mic is a 28 px button in
// the titlebar. So a mic press while signed out raises this flag instead of
// starting a call, and the cockpit (src/VoiceCockpit.tsx) draws the prompt where
// the waves would have been. Module state rather than the store: it is one
// boolean that only these two files care about.
let voiceAsked = false;
const voiceSubs = new Set<(on: boolean) => void>();

export function askVoiceSignIn(on: boolean): void {
  if (voiceAsked === on) return;
  voiceAsked = on;
  for (const f of voiceSubs) f(on);
}

export function useVoiceSignInAsked(): boolean {
  const [on, setOn] = useState(voiceAsked);
  useEffect(() => {
    voiceSubs.add(setOn);
    setOn(voiceAsked);
    return () => void voiceSubs.delete(setOn);
  }, []);
  return on;
}
