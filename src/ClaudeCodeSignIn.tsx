// Signing in with Claude, and the two places it shows: the one line at the top
// of Settings, and the small prompt a blocked AI surface draws in place of
// itself.
//
// Signing in is a token, not a password: `claude setup-token` on a machine with
// a browser prints a long-lived one. Carl runs that command himself, in a real
// terminal, and pastes what it prints — the app drove it for him once, through
// a pty, and it broke four different ways on his Windows laptop before he said
// to stop. There is no other way in ("I don't want the other sign on options").
//
// Either way the token is kept in this machine's keychain like every other key
// and travels to the box the same way (src/keystore.ts), where only the Claude
// Code process is given it — never anything the agent runs (src/keyEnv.ts
// NOT_FOR_COMMANDS). Signing out removes it from the keychain and from the
// store, and the key push that follows removes it from the box too (the box
// makes its store exactly what is pushed: src/boxKeys.ts).
import { useState } from "react";
import { Button, Input } from "./ui";
import { useStore } from "./store";
import { boxLinkFor } from "./boxChat";
import { pushKeysToBox } from "./boxKeys";
import { keychainDelete, keychainGet, KEY } from "./keychain";
import { SIGN_IN_BUTTON, SIGN_IN_LINE, type SignInSurface } from "./claudeAuth";
import { forgetClaudeHealth, useClaudeSignedIn } from "./claudeAuthLive";

/**
 * Everything the sign-in needs from outside itself. Named so the flow below can
 * be driven in a test without Tauri, a browser or a box.
 */
export type SignInIo = {
  /** The keychain's copy, which is the only place the token exists on this machine. */
  storedToken: () => Promise<string | null>;
  /** Mirror it into the store, which is what the box push reads. */
  remember: (token: string) => void;
  /** Push the whole key set to the open vault's box; null, or why not. */
  push: () => Promise<string | null>;
  /** Take the token off this machine (signing out). */
  forget: () => Promise<void>;
};

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The paste field's path: a token the user minted themselves. */
export async function saveTypedToken(io: SignInIo, token: string): Promise<string | null> {
  // Whatever came along with it (spaces, a line break, the prompt text) is not
  // part of it: the token is the one run that starts sk-ant-oat.
  const trimmed = token.match(/sk-ant-oat[A-Za-z0-9_-]+/)?.[0] ?? token.trim();
  if (!trimmed) return "Paste the token first";
  if (!/^sk-ant-oat[A-Za-z0-9_-]{80,}$/.test(trimmed)) {
    return "That doesn't look like the whole token. Copy the full line that starts with sk-ant-oat01-.";
  }
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

/** The command that mints the token, shown with a copy button. */
export const SETUP_COMMAND = "claude setup-token";

/**
 * The flow itself. Carl, after a day of the button driving `claude setup-token`
 * in a hidden Windows console and breaking four different ways: run the command
 * in a real terminal and paste what it prints. Claude does its own sign-in
 * there, so nothing here can break it. The token lasts about a year and is kept
 * in this machine's keychain and pushed to the box like every key. `onDone`
 * fires once it is saved.
 */
function SignInFlow({ onDone }: { onDone?: () => void }) {
  const vault = useStore((s) => s.vaultPath);
  const setServiceKey = useStore((s) => s.setServiceKey);
  const clearServiceKey = useStore((s) => s.clearServiceKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);

  const io = liveIo(
    vault,
    (t) => setServiceKey("claudeCode", t),
    () => clearServiceKey("claudeCode"),
  );

  const copy = () => {
    void navigator.clipboard?.writeText(SETUP_COMMAND).then(
      () => setCopied(true),
      () => {},
    );
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const err = await saveTypedToken(io, token);
    setBusy(false);
    if (err) return setError(err);
    setToken("");
    // The box's answer about Claude is now stale (src/claudeAuth.ts).
    forgetClaudeHealth();
    onDone?.();
  };

  return (
    <div className="space-y-1.5" data-el="claude-signin-flow">
      <p className="text-[11px] text-muted-foreground">
        Run this in a terminal, sign in in the browser it opens, then paste the token it prints.
      </p>
      <div className="flex items-center gap-2">
        <code className="font-mono text-[11.5px] px-2 py-1 rounded border border-border/60 select-all" data-el="claude-signin-command">
          {SETUP_COMMAND}
        </code>
        <button onClick={copy} className="text-[10.5px] text-muted-foreground hover:text-foreground underline" data-el="claude-signin-copy">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="flex gap-2">
        <Input
          type="password"
          value={token}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            setToken(e.target.value);
            setError(null);
          }}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && void save()}
          placeholder="sk-ant-oat01-…"
          className="font-mono text-[11.5px]"
          data-el="claude-signin-token"
        />
        <Button size="sm" onClick={() => void save()} disabled={busy} data-el="claude-signin-save">
          {busy ? "Saving…" : SIGN_IN_BUTTON}
        </Button>
      </div>
      {error && <p className="text-[10.5px] text-amber-500/90 break-words">{error}</p>}
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
