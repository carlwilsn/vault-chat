// Settings → Models: whether the box can run turns on Claude Code, and the way
// to sign it in.
//
// Signing in is a token, not a password: `claude setup-token` on a machine with
// a browser prints a long-lived one. The button drives that command here (see
// src-tauri/src/claude_login.rs — it needs a pty, and the token it prints goes
// straight into this machine's keychain without ever coming back across the
// IPC boundary). The paste field stays underneath it for the machines where
// there is no `claude` to drive, and for anyone who would rather run the
// command themselves.
//
// Either way the token is kept in this machine's keychain like every other key
// and travels to the box the same way (src/keystore.ts), where only the Claude
// Code process is given it — never anything the agent runs (src/keyEnv.ts
// NOT_FOR_COMMANDS).
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Input } from "./ui";
import { useStore } from "./store";
import { boxGet, boxLinkFor } from "./boxChat";
import { pushKeysToBox } from "./boxKeys";
import { claudeOf } from "./engineHealth";
import { keychainGet, KEY } from "./keychain";
import { openUrl } from "./opener";

type Agent = { signedIn: boolean; version: string | null } | null;

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
function liveIo(vault: string | null, remember: (token: string) => void): SignInIo {
  return {
    start: () => invoke<string>("claude_setup_token_start"),
    finish: (code) => invoke<void>("claude_setup_token_finish", { code }),
    cancel: () => invoke<void>("claude_setup_token_cancel"),
    openUrl,
    storedToken: () => keychainGet(KEY.claudeCode),
    remember,
    push: async () => {
      const link = await boxLinkFor(vault);
      // No box yet is not an error to recover from: the whole set goes over on
      // connect anyway (src/boxKeys.ts).
      if (!link) return null;
      return pushKeysToBox(link.url);
    },
  };
}

export function ClaudeCodeSignIn() {
  const vault = useStore((s) => s.vaultPath);
  const on = useStore((s) => !!s.boxChat?.on);
  const saved = useStore((s) => s.serviceKeys.claudeCode);
  const setServiceKey = useStore((s) => s.setServiceKey);
  const [agent, setAgent] = useState<Agent>(null);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether this machine has a `claude` the button can drive at all. Undefined
  // until asked, so the button doesn't flash in and out while Settings opens.
  const [canDrive, setCanDrive] = useState<boolean | undefined>(undefined);
  // The page the running command is waiting on, and the code coming back.
  const [awaiting, setAwaiting] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const read = async () => {
    if (!on || !vault) return setAgent(null);
    const link = await boxLinkFor(vault);
    if (!link) return;
    const h = await boxGet(link, "/api/v1/health", 8_000).catch(() => null);
    if (!h) return;
    // The box only reports Claude Code once it has one it can run. Both health
    // shapes are read (src/engineHealth.ts), so an older box still answers.
    const claude = claudeOf(h);
    if (!claude) return setAgent(null);
    setAgent(claude);
  };
  useEffect(() => {
    void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, vault]);

  // Asked once the panel opens, not on every render of Settings: it runs
  // `claude --version`, which is a 340 MB binary starting up.
  useEffect(() => {
    if (!open || canDrive !== undefined) return;
    invoke<{ version: string } | null>("claude_setup_token_cli")
      .then((c) => setCanDrive(!!c))
      .catch(() => setCanDrive(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!agent) return null;

  const io = liveIo(vault, (t) => setServiceKey("claudeCode", t));

  /** Leave the panel, and stop any command still waiting for a code. */
  const close = () => {
    if (awaiting) void io.cancel().catch(() => {});
    setAwaiting(null);
    setCode("");
    setDraft("");
    setOpen(false);
  };

  const signIn = async () => {
    setBusy(true);
    setError(null);
    const r = await beginSignIn(io);
    setBusy(false);
    if ("fallback" in r) {
      // Nothing was started. The paste field is right below, so the way in is
      // already on screen; saying why is all that's left. The button stays —
      // a CLI that was slow to start this once may well answer the next try.
      setError(`Could not start the sign-in: ${r.fallback}`);
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
    setAwaiting(null);
    setCode("");
    setOpen(false);
    await read();
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const err = await saveTypedToken(io, draft);
    setBusy(false);
    if (err) return setError(err);
    setDraft("");
    setOpen(false);
    await read();
  };

  return (
    <div className="flex items-start justify-between gap-3" data-el="claude-code-signin">
      <span className="text-[12px] text-foreground/90 shrink-0 pt-1">Claude Code</span>
      <div className="min-w-0 flex-1 max-w-[62%] space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className={`text-[11px] ${agent.signedIn ? "text-muted-foreground" : "text-amber-500/90"}`}>
            {agent.signedIn ? `signed in${agent.version ? ` · v${agent.version}` : ""}` : "not signed in"}
          </span>
          {!open && (
            <button onClick={() => setOpen(true)} className="text-[10.5px] text-muted-foreground hover:text-foreground underline shrink-0">
              {agent.signedIn ? "sign in again" : "sign in"}
            </button>
          )}
          {open && (
            <button onClick={close} className="text-[10.5px] text-muted-foreground hover:text-foreground underline shrink-0">
              cancel
            </button>
          )}
        </div>
        {open && (
          <>
            {canDrive !== false && !awaiting && (
              <Button size="sm" variant="outline" className="w-full" onClick={() => void signIn()} disabled={busy || canDrive === undefined}>
                {busy ? "Opening browser…" : "Sign in with Claude"}
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
                  />
                  <Button size="sm" variant="outline" onClick={() => void submitCode()} disabled={!code.trim() || busy}>
                    {busy ? "Signing in…" : "Continue"}
                  </Button>
                </div>
              </div>
            )}
            <p className="text-[10.5px] text-muted-foreground/80">
              Or run <code className="font-mono">claude setup-token</code> and paste what it prints.
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
          </>
        )}
        {/* The messages say for themselves whether anything was saved — a push
            that failed still left the token in the keychain — so no prefix. */}
        {error && <p className="text-[10.5px] text-amber-500/90 break-words">{error}</p>}
      </div>
    </div>
  );
}
