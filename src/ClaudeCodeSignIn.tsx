// Settings → Models: whether the box can run turns on Claude Code, and the way
// to sign it in.
//
// Signing in is a token, not a password: `claude setup-token` on a machine with
// a browser prints a long-lived one. It is kept in this machine's keychain like
// every other key and travels to the box the same way (src/keystore.ts), where
// only the Claude Code process is given it — never anything the agent runs
// (src/keyEnv.ts NOT_FOR_COMMANDS).
import { useEffect, useState } from "react";
import { Button, Input } from "./ui";
import { useStore } from "./store";
import { boxGet, boxLinkFor } from "./boxChat";
import { pushKeysToBox } from "./boxKeys";

type Agent = { signedIn: boolean; version: string | null } | null;

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

  const read = async () => {
    if (!on || !vault) return setAgent(null);
    const link = await boxLinkFor(vault);
    if (!link) return;
    const h = await boxGet(link, "/api/v1/health", 8_000).catch(() => null);
    if (!h) return;
    const claude = h.engine?.claude ?? (h.engine?.backend === "claude" ? h.engine?.claude : null);
    // The box only reports Claude Code once it has one it can run.
    if (!claude) return setAgent(null);
    setAgent({ signedIn: !!claude.signedIn, version: typeof claude.version === "string" ? claude.version : null });
  };
  useEffect(() => {
    void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, vault]);

  if (!agent) return null;

  const save = async () => {
    const token = draft.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setServiceKey("claudeCode", token);
      const link = await boxLinkFor(vault);
      const err = link ? await pushKeysToBox(link.url) : "no box is connected";
      if (err) throw new Error(err);
      setDraft("");
      setOpen(false);
      await read();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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
        </div>
        {open && (
          <>
            <p className="text-[10.5px] text-muted-foreground/80">
              Run <code className="font-mono">claude setup-token</code> and paste what it prints.
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
        {error && <p className="text-[10.5px] text-amber-500/90 break-words">Not saved: {error}</p>}
      </div>
    </div>
  );
}
