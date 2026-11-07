// Signing in with Claude, and the two places it shows: the one line at the top
// of Settings, and the small prompt a blocked AI surface draws in place of
// itself.
//
// Signing in is a token, not a password: `claude setup-token` on a machine with
// a browser prints a long-lived one. The button drives that command here (see
// src-tauri/src/claude_login.rs — it needs a pty, and the token it prints goes
// straight into this machine's keychain without ever coming back across the
// IPC boundary). Running the command yourself and pasting what it prints still
// works, but it is now behind "Other ways to sign in", closed: Carl, on the
// release that showed the button, the code field and the paste field all at
// once, "when I click the sign in button its not a clean obvious and nice
// thing." One button is the way in; the rest is for the machines that have no
// `claude` to drive.
//
// Either way the token is kept in this machine's keychain like every other key
// and travels to the box the same way (src/keystore.ts), where only the Claude
// Code process is given it — never anything the agent runs (src/keyEnv.ts
// NOT_FOR_COMMANDS). Signing out removes it from the keychain and from the
// store, and the key push that follows removes it from the box too (the box
// makes its store exactly what is pushed: src/boxKeys.ts).
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Input } from "./ui";
import { useStore } from "./store";
import { boxLinkFor } from "./boxChat";
import { pushKeysToBox } from "./boxKeys";
import { keychainDelete, keychainGet, KEY } from "./keychain";
import { openUrl } from "./opener";
import { SIGN_IN_BUTTON, SIGN_IN_LINE, type SignInSurface } from "./claudeAuth";
import { forgetClaudeHealth, useClaudeSignedIn } from "./claudeAuthLive";

/**
 * Everything the sign-in needs from outside itself. Named so the flow below can
 * be driven in a test without Tauri, a browser or a box.
 */
export type SignInIo = {
  /** Start `claude setup-token`; resolves with the page to sign in on. */
  start: () => Promise<string>;
  /** Hand over the code from that page. The token never comes back here — it
   *  goes from the command's output straight into the keychain. */
  finish: (code: string) => Promise<void>;
  cancel: () => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  /** The keychain's copy, which is the only place the captured token exists. */
  storedToken: () => Promise<string | null>;
  /** Mirror it into the store, which is what the box push reads. */
  remember: (token: string) => void;
  /** Push the whole key set to the open vault's box; null, or why not. */
  push: () => Promise<string | null>;
  /** Take the token off this machine (signing out). */
  forget: () => Promise<void>;
};

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Start the flow. On success the caller shows the code field; a `fallback` means
 * nothing was started and the paste field is the way in on this machine.
 */
export async function beginSignIn(io: SignInIo): Promise<{ url: string } | { fallback: string }> {
  let url: string;
  try {
    url = await io.start();
  } catch (e) {
    return { fallback: why(e) };
  }
  // A browser that would not open is not a dead end: the command is running and
  // waiting, and the page is shown as a link the user can take themselves.
  await io.openUrl(url).catch(() => {});
  return { url };
}

/**
 * Hand the code over and get the token to the box. Null when it worked, else
 * what to tell the user — which never includes the token, because the token is
 * never in this function's hands in the first place.
 */
export async function finishSignIn(io: SignInIo, code: string): Promise<string | null> {
  const trimmed = code.trim();
  if (!trimmed) return "paste the code from the sign-in page first";
  try {
    await io.finish(trimmed);
  } catch (e) {
    return why(e);
  }
  return afterStored(io, "signed in");
}

/** The paste field's path: a token the user minted themselves. */
export async function saveTypedToken(io: SignInIo, token: string): Promise<string | null> {
  const trimmed = token.trim();
  if (!trimmed) return "paste the token first";
  io.remember(trimmed);
  const err = await io.push().catch(why);
  return err ? `saved on this machine, but the box did not take it: ${err}` : null;
}

/**
 * Sign out: the token off this machine, then the set pushed again so the box
 * drops it too. A push that fails is worth saying — the box can still run turns
 * until something else pushes — but this machine is signed out either way, so
 * it must not read as a failed sign-out.
 */
export async function signOut(io: SignInIo): Promise<string | null> {
  try {
    await io.forget();
  } catch (e) {
    return `could not remove the token from this machine's keychain: ${why(e)}`;
  }
  const err = await io.push().catch(why);
  return err ? `signed out here, but the box kept its copy: ${err}` : null;
}

/**
 * Shared tail of both paths: read the keychain's copy, mirror it into the store
 * (what src/boxKeys.ts laptopKeys reads) and push the set to the box. A push
 * that fails is NOT a failed sign-in — the token is stored, and the next
 * connect pushes the whole set again — so it must not read as one.
 */
async function afterStored(io: SignInIo, did: string): Promise<string | null> {
  let token: string | null;
  try {
    token = await io.storedToken();
  } catch (e) {
    return `${did}, but the keychain could not be read back: ${why(e)}`;
  }
  if (!token) return `${did}, but nothing was found in the keychain afterwards`;
  io.remember(token);
  const err = await io.push().catch(why);
  return err ? `${did}, but the box did not take the token: ${err}` : null;
}

/** The sign-in driven over Tauri, for the real app. */
function liveIo(vault: string | null, remember: (token: string) => void, forget: () => void): SignInIo {
  const push = async () => {
    const link = await boxLinkFor(vault);
    // No box yet is not an error to recover from: the whole set goes over on
    // connect anyway (src/boxKeys.ts).
    if (!link) return null;
    return pushKeysToBox(link.url);
  };
  return {
    start: () => invoke<string>("claude_setup_token_start"),
    finish: (code) => invoke<void>("claude_setup_token_finish", { code }),
    cancel: () => invoke<void>("claude_setup_token_cancel"),
    openUrl,
    storedToken: () => keychainGet(KEY.claudeCode),
    remember,
    push,
    forget: async () => {
      // The store first: it is what the push reads, and the keychain delete is
      // best-effort (keychain.ts swallows its own failures).
      forget();
      await keychainDelete(KEY.claudeCode);
    },
  };
}

/**
 * The flow itself: one button, then the code field the browser's page feeds,
 * and — only if asked for — the raw `claude setup-token` paste. `onDone` fires
 * once the token is on this machine.
 */
function SignInFlow({ onDone }: { onDone?: () => void }) {
  const vault = useStore((s) => s.vaultPath);
  const saved = useStore((s) => s.serviceKeys.claudeCode);
  const setServiceKey = useStore((s) => s.setServiceKey);
  const clearServiceKey = useStore((s) => s.clearServiceKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The page the running command is waiting on, and the code coming back.
  const [awaiting, setAwaiting] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // The disclosure, and the token typed into it. Closed until asked for.
  const [other, setOther] = useState(false);
  const [draft, setDraft] = useState("");

  const io = liveIo(
    vault,
    (t) => setServiceKey("claudeCode", t),
    () => clearServiceKey("claudeCode"),
  );

  // A command left waiting for a code is a pty sitting open. Stop it when this
  // prompt goes away without finishing — Settings closed, or the composer went
  // live because the box was signed in from somewhere else. A finished flow has
  // already cleared `awaiting`, so a success never kills anything.
  const pending = useRef<string | null>(null);
  pending.current = awaiting;
  const cancelRef = useRef(io.cancel);
  cancelRef.current = io.cancel;
  useEffect(
    () => () => {
      if (pending.current) void cancelRef.current().catch(() => {});
    },
    [],
  );

  const done = () => {
    setAwaiting(null);
    setCode("");
    setDraft("");
    setOther(false);
    // The box's answer about Claude is now stale (src/claudeAuth.ts).
    forgetClaudeHealth();
    onDone?.();
  };

  const signIn = async () => {
    setBusy(true);
    setError(null);
    const r = await beginSignIn(io);
    setBusy(false);
    if ("fallback" in r) {
      // Nothing was started. Open the disclosure so the way in is on screen
      // instead of just an error. The button stays — a CLI that was slow to
      // start this once may well answer the next try.
      setError(`Could not start the sign-in: ${r.fallback}`);
      setOther(true);
      return;
    }
    setAwaiting(r.url);
  };

  const submitCode = async () => {
    setBusy(true);
    setError(null);
    const err = await finishSignIn(io, code);
    setBusy(false);
    if (err) return setError(err);
    done();
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const err = await saveTypedToken(io, draft);
    setBusy(false);
    if (err) return setError(err);
    done();
  };

  return (
    <div className="space-y-1.5" data-el="claude-signin-flow">
      {/* The one way in: a solid primary button, not an underlined link. */}
      {!awaiting && (
        <Button size="sm" onClick={() => void signIn()} disabled={busy} data-el="claude-signin-start">
          {busy ? "Opening browser…" : SIGN_IN_BUTTON}
        </Button>
      )}
      {awaiting && (
        <div className="space-y-1" data-el="claude-code-awaiting-code">
          <p className="text-[10.5px] text-muted-foreground/80">
            Sign in in the browser, then paste the code it shows.{" "}
            <button onClick={() => void io.openUrl(awaiting).catch(() => {})} className="underline hover:text-foreground">
              Open the page again
            </button>
          </p>
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCode(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && void submitCode()}
              placeholder="code from the browser"
              className="font-mono text-[11.5px]"
              autoFocus
            />
            <Button size="sm" variant="outline" onClick={() => void submitCode()} disabled={!code.trim() || busy}>
              {busy ? "Signing in…" : "Continue"}
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-[10.5px] text-amber-500/90 break-words">{error}</p>}
      {!other ? (
        <button onClick={() => setOther(true)} className="text-[10.5px] text-muted-foreground/70 hover:text-foreground underline" data-el="claude-signin-other">
          Other ways to sign in
        </button>
      ) : (
        <div className="space-y-1" data-el="claude-signin-other-open">
          <p className="text-[10.5px] text-muted-foreground/80">
            Run <code className="font-mono">claude setup-token</code> on this machine and paste what it prints.
          </p>
          <div className="flex gap-2">
            <Input
              type="password"
              value={draft}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && void save()}
              placeholder={saved ? "••••••••" : "sk-ant-oat…"}
              className="font-mono text-[11.5px]"
            />
            <Button size="sm" variant="outline" onClick={() => void save()} disabled={!draft.trim() || busy}>
              {busy ? "Sending…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The one line at the top of Settings: signed in, with Sign out; or the button.
 * Nothing else about Claude belongs anywhere else in Settings.
 */
export function ClaudeAccountLine() {
  const vault = useStore((s) => s.vaultPath);
  const setServiceKey = useStore((s) => s.setServiceKey);
  const clearServiceKey = useStore((s) => s.clearServiceKey);
  const { signedIn, known } = useClaudeSignedIn();
  const [error, setError] = useState<string | null>(null);

  // Not known yet (the box has not answered and this machine holds no token):
  // one quiet line, never a button that may be wrong a moment later.
  if (!known) {
    return (
      <div className="text-[12px] text-muted-foreground" data-el="claude-account">
        Checking your Claude sign-in…
      </div>
    );
  }

  if (signedIn) {
    const out = async () => {
      setError(null);
      const io = liveIo(
        vault,
        (t) => setServiceKey("claudeCode", t),
        () => clearServiceKey("claudeCode"),
      );
      const err = await signOut(io);
      forgetClaudeHealth();
      if (err) setError(err);
    };
    return (
      <div className="space-y-1" data-el="claude-account">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden />
          <span className="text-foreground/90">Signed in to Claude</span>
          <span className="text-muted-foreground/50">·</span>
          <button onClick={() => void out()} className="text-[11.5px] text-muted-foreground hover:text-foreground underline" data-el="claude-sign-out">
            Sign out
          </button>
        </div>
        {error && <p className="text-[10.5px] text-amber-500/90 break-words">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-1" data-el="claude-account">
      <SignInFlow />
    </div>
  );
}

/**
 * What a blocked AI surface draws in place of itself: one sentence and one
 * button. Signed in, or not known yet, it draws nothing and the surface shows
 * as it always did (see src/claudeAuth.ts on why `known` must hold it back).
 */
export function ClaudeSignInPrompt({ surface }: { surface: SignInSurface }) {
  const { signedIn, known } = useClaudeSignedIn();
  if (signedIn || !known) return null;
  return (
    <div
      className="rounded-2xl border border-border bg-background px-3.5 py-3 space-y-2"
      data-el="claude-signin-prompt"
      data-surface={surface}
    >
      <p className="text-[12.5px] text-foreground/90">{SIGN_IN_LINE[surface]}</p>
      <SignInFlow />
    </div>
  );
}

/** Whether a surface should draw ClaudeSignInPrompt instead of itself. */
export function useAiBlocked(): boolean {
  const { signedIn, known } = useClaudeSignedIn();
  return known && !signedIn;
}
