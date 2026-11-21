import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, X, Plus } from "lucide-react";
import { useStore } from "../../store";
import { Button, Input, MenuSelect } from "../../ui";
import { cleanKeyName } from "../../keychain";
import {
  readBoxConfig,
  subscribeBoxSync,
  boxSyncNow,
  fmtSize,
  githubPlain,
  type BoxConfig,
  type BoxSyncState,
  boxName,
  boxVaultName,
  discoverBoxes,
  connectBox,
  disconnectBox,
  type FoundBox,
  tailscaleCheck,
  openTailscale,
} from "../../vaultSync";
import { connectTrouble, tailscaleHelp, GET_TAILSCALE_URL, type TailscaleHelp } from "../../tailscaleHelp";
import { openUrl } from "../../opener";
import { boxGet, boxPost } from "../../boxChat";
import { pushKeysToBox, keysChanged, subscribeKeyPush } from "../../boxKeys";
import { ClaudeAccountLine } from "../../ClaudeCodeSignIn";
import { MasterSection } from "../../MasterSection";
import { openShortcutSheet } from "../../ShortcutSheet";
import { chordText } from "../../shortcuts";
import { Picker, type PickOption } from "../../SearchPicker";

// The Claude sign-in on one line at the top, then the sections: Keys, vault-chat folder, Box, Appearance; then Keyboard
// shortcuts (the Ctrl+/ sheet). There is no voice section: the core voice is local (Kokoro, af_heart) with nothing to
// pick, and the ElevenLabs voice and its picker are the ElevenLabs voice plugin's (src/plugins/elevenlabs-voice).
//
// The sign-in is at the TOP and is one line, because it is the first thing to
// settle on a fresh install and the only thing the AI features wait on. It used
// to be a tiny underlined link inside Models that opened a panel with three
// ways in at once; Carl, on that release: "when I click the sign in button its
// not a clean obvious and nice thing."

function SectionHead({ title, hint, right }: { title: string; hint?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        {hint && <p className="text-[11.5px] text-muted-foreground/80 mt-0.5">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

const Divider = () => <div className="h-px bg-border" />;

/** The pane's sections, top to bottom (data-settings on each: the offers' scrollTo finds them by it). */
export const SETTINGS_SECTIONS: readonly { id: string; title: string }[] = [
  { id: "account", title: "Claude sign-in" },
  { id: "keys", title: "Keys" },
  { id: "master", title: "vault-chat folder" },
  { id: "box", title: "Box" },
  { id: "appearance", title: "Appearance" },
  { id: "shortcuts", title: "Keyboard shortcuts" },
];

export function Pane() {
  const setShowSettings = useStore((s) => s.setShowSettings);
  return (
    <div className="h-full flex flex-col bg-card border-l border-border" data-el="settings-pane">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Button variant="ghost" size="icon" onClick={() => setShowSettings(false)} data-el="settings-back">
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="text-[13px] font-semibold">Settings</span>
      </div>
      <div className="flex-1 overflow-auto p-5 space-y-6" data-el="settings-scroll">
        <div data-settings="account">
          <ClaudeAccountLine />
        </div>
        <Divider />
        <div data-settings="keys">
          <KeysSection />
        </div>
        <Divider />
        <MasterSection />
        <Divider />
        <BoxSection />
        <Divider />
        <div data-settings="appearance">
          <AppearanceSection />
        </div>
        <button
          onClick={openShortcutSheet}
          className="w-full flex items-center justify-between rounded px-2 py-1.5 -mx-2 text-[12px] text-foreground/90 hover:bg-accent/60"
          data-el="settings-shortcuts"
          data-settings="shortcuts"
        >
          <span>Keyboard shortcuts</span>
          <span className="text-[11px] text-muted-foreground">{chordText("Mod+/")}</span>
        </button>
        <button
          onClick={() => window.dispatchEvent(new Event("vc:check-updates"))}
          className="w-full flex items-center justify-between rounded px-2 py-1.5 -mx-2 text-[12px] text-foreground/90 hover:bg-accent/60"
          data-el="settings-check-updates"
        >
          <span>Check for updates</span>
        </button>
      </div>
    </div>
  );
}

// ---- Keys --------------------------------------------------------------------

function KeysSection() {
  // A key is a name and a secret: every key is listed, added, replaced and
  // removed the same way, whatever it is for. Nothing here knows a provider.
  const keys = useStore((s) => s.keys);
  const setKey = useStore((s) => s.setKey);
  const removeKey = useStore((s) => s.removeKey);
  const serviceKeys = useStore((s) => s.serviceKeys);
  const [edit, setEdit] = useState<{ name: string; value: string; replacing: boolean } | null>(null);
  const save = async () => {
    if (!edit) return;
    const n = cleanKeyName(edit.name);
    const v = edit.value.trim();
    if (!n || !v) return;
    await setKey(n, v);
    setEdit(null);
  };
  // Any add / change / removal here goes to the connected box too (the whole
  // set; see boxKeys.ts). Not on first render: connecting already pushed.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const t = window.setTimeout(() => void keysChanged(), 400);
    return () => window.clearTimeout(t);
  }, [keys, serviceKeys]);

  const names = Object.keys(keys).sort((a, b) => a.localeCompare(b));
  return (
    <section className="space-y-2.5" data-settings="keys">
      {/* No row per provider: the agent is Claude Code, and its sign-in is the
          line at the top of Settings, not a key. Every key is a name and a secret. */}
      <SectionHead
        title="Keys"
        hint="Kept in this machine's keychain, and given to whatever runs your vault."
        right={
          !edit && (
            <Button size="sm" variant="ghost" onClick={() => setEdit({ name: "", value: "", replacing: false })} title="Add a key" data-el="key-add">
              <Plus className="h-3 w-3" />
            </Button>
          )
        }
      />
      {edit && (
        <div className="flex gap-2">
          <Input
            placeholder="name (e.g. LAMBDA_API_KEY)"
            value={edit.name}
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            className="flex-[2] font-mono"
            disabled={edit.replacing}
            autoFocus={!edit.replacing}
          />
          <Input
            type="password"
            placeholder={edit.replacing ? "new value" : "value"}
            value={edit.value}
            onChange={(e) => setEdit({ ...edit, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setEdit(null);
            }}
            className="flex-[3]"
            autoFocus={edit.replacing}
          />
          <Button size="sm" onClick={() => void save()} disabled={!edit.name.trim() || !edit.value.trim()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEdit(null)} title="Cancel">
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
      {names.length > 0 ? (
        <ul className="divide-y divide-border/40 rounded-md border border-border/60">
          {names.map((n) => (
            <li key={n} className="flex items-center justify-between px-3 py-1 text-[12px]" data-key={n}>
              <span className="font-mono text-foreground/90">{n}</span>
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEdit({ name: n, value: "", replacing: true })} title="Replace">
                  Replace
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void removeKey(n)} title="Remove">
                  <X className="h-3 w-3" />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        !edit && <p className="text-[11px] text-muted-foreground/60 italic">No keys yet.</p>
      )}
      <p className="text-[11px] text-muted-foreground/80">
        The agent's commands get each key as an environment variable of the same name (upper-cased); plugins and vault tools
        (<code className="font-mono bg-muted px-1 rounded text-[10.5px]">requires_keys</code> in TOOL.md) ask for one by name.
      </p>
    </section>
  );
}

// ---- Appearance --------------------------------------------------------------

function AppearanceSection() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  return (
    <section className="space-y-2">
      <SectionHead title="Appearance" />
      <MenuSelect
        value={theme}
        onChange={(v) => setTheme(v as "graphite" | "light")}
        groups={[
          {
            options: [
              { value: "graphite", label: "Graphite (default)" },
              { value: "light", label: "Light" },
            ],
          },
        ]}
      />
    </section>
  );
}

// ---- Box ---------------------------------------------------------------------

function BoxSection() {
  const vaultPath = useStore((s) => s.vaultPath);
  // undefined = still reading sync.json; null = no box (no chat until one is connected).
  const [box, setBox] = useState<BoxConfig | null | undefined>(undefined);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    if (!vaultPath) {
      setBox(undefined);
      return;
    }
    let cancelled = false;
    void readBoxConfig(vaultPath).then((b) => !cancelled && setBox(b));
    return () => {
      cancelled = true;
    };
  }, [vaultPath, rev]);
  // Connect / disconnect: re-read sync.json, and move the chat (box mode is
  // decided when the conversations load).
  const changed = async (connected: boolean) => {
    if (!connected) (await import("../../boxChat")).stopBoxChat();
    setRev((n) => n + 1);
    void useStore.getState().loadConversations();
  };

  // Sync exists only with a box. Without one, the vault is saved locally for
  // history (always on, no setting) and nothing is pushed anywhere.
  return (
    <section className="space-y-3" data-settings="box">
      <SectionHead
        title="Box"
        hint={!vaultPath || box === undefined ? "Open a vault to see its sync." : box ? `Runs on ${boxName(box)}` : "No box: the chat runs on one. Connect it here."}
      />
      {vaultPath &&
        box !== undefined &&
        (box ? (
          <BoxSyncPanel vault={vaultPath} box={box} onDisconnected={() => void changed(false)} />
        ) : (
          <BoxConnect vault={vaultPath} onConnected={() => void changed(true)} />
        ))}
      <PhoneLink box={box ?? null} />
    </section>
  );
}

type BoxHealth = { name: string; version: string | null };

/** One line about this laptop's Tailscale, with the one thing to do about it.
 *  Nothing is drawn when Tailscale is fine or hasn't been asked. vault-chat
 *  never asks for a Tailscale login itself — that happens in Tailscale. */
export function TailscaleNote({ help }: { help: TailscaleHelp | null }) {
  const [err, setErr] = useState<string | null>(null);
  if (!help) return null;
  const act = async () => {
    setErr(null);
    try {
      if (help.action?.kind === "open") await openTailscale();
      else await openUrl(GET_TAILSCALE_URL);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <p className="text-[11px] text-amber-500/90 break-words" data-testid="tailscale-note">
      {help.line}
      {help.action && (
        <button onClick={() => void act()} className="ml-1.5 underline hover:text-foreground" data-testid="tailscale-action">
          {help.action.label}
        </button>
      )}
      {err && <span className="ml-1.5 text-muted-foreground">({err})</span>}
    </p>
  );
}

/** Not connected: find a box on the tailnet (or type its address), then sync
 *  this vault with it — which also gives it this laptop's keys (boxKeys.ts). */
function BoxConnect({ vault, onConnected }: { vault: string; onConnected: () => void }) {
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<FoundBox[] | null>(null);
  const [address, setAddress] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [health, setHealth] = useState<BoxHealth | null>(null);
  const [busy, setBusy] = useState<null | "checking" | "sync">(null);
  const [error, setError] = useState<string | null>(null);
  // Why nothing answered, in one line. Asked only after a failure (Tailscale is
  // never polled), and it carries its own button, so no second error line.
  const [trouble, setTrouble] = useState<TailscaleHelp | null>(null);
  const link = (url: string) => ({ url, token: useStore.getState().boxToken || null });

  const start = async () => {
    setOpen(true);
    setFound(null);
    setError(null);
    setTrouble(null);
    try {
      const boxes = await discoverBoxes();
      setFound(boxes);
      // Nothing on the tailnet is usually not a missing box: it is Tailscale.
      if (boxes.length === 0) setTrouble(tailscaleHelp(await tailscaleCheck()));
    } catch (e) {
      setFound([]);
      setTrouble(connectTrouble("the tailnet", e instanceof Error ? e.message : String(e), await tailscaleCheck()));
    }
  };
  const check = async (raw: string) => {
    let url = raw.trim().replace(/\/+$/, "");
    if (!url) return;
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    const fallback = found?.find((b) => b.url === url)?.name ?? url.replace(/^https?:\/\//, "").split(".")[0];
    setPicked(url);
    setHealth(null);
    setError(null);
    setTrouble(null);
    setBusy("checking");
    try {
      const h = await boxGet(link(url), "/api/v1/health", 6000);
      const isServer = h?.app === "vault-chat-server" || (h?.ok === true && h?.version && h?.keys);
      if (!isServer) throw new Error("it doesn't answer as a vault-chat server");
      setHealth({ name: h.name || fallback, version: h.version ?? null });
    } catch (e) {
      setTrouble(connectTrouble(fallback, e instanceof Error ? e.message : String(e), await tailscaleCheck()));
    } finally {
      setBusy(null);
    }
  };
  const sync = async () => {
    if (!picked || !health) return;
    setBusy("sync");
    setError(null);
    try {
      const r = await boxPost(link(picked), "/api/v1/vaults", { name: boxVaultName(vault) });
      if (!r.ok) throw new Error(r.error ?? "the box refused");
      const keyErr = await pushKeysToBox(picked);
      if (keyErr) throw new Error(`your keys didn't reach it (${keyErr})`);
      await connectBox(vault, picked, health.name);
      onConnected();
    } catch (e) {
      setError(`Couldn't sync with ${health.name}: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(null);
    }
  };

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => void start()}>
        Connect a box
      </Button>
    );
  }
  const options: PickOption[] = (found ?? []).map((b) => ({
    value: b.url,
    label: b.name,
    hint: b.online ? `online${b.version ? ` · v${b.version}` : ""}` : "offline",
  }));
  return (
    <div className="space-y-2 rounded-md border border-border/60 px-2.5 py-2">
      {!health ? (
        <>
          <Picker
            value={picked ?? ""}
            label={found === null ? "Looking for boxes…" : found.length ? "Pick a box" : "No box answered on your tailnet"}
            options={options}
            placeholder="Search boxes…"
            onChange={(v) => void check(v)}
            defaultOpen
          />
          <div className="flex gap-2">
            <Input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void check(address)}
              placeholder="Or enter an address"
              className="font-mono text-[11.5px]"
            />
            <Button size="sm" variant="outline" onClick={() => void check(address)} disabled={!address.trim() || busy === "checking"}>
              Check
            </Button>
          </div>
          {busy === "checking" && <p className="text-[10.5px] text-muted-foreground/70">Checking…</p>}
          <TailscaleNote help={trouble} />
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 text-[11.5px]">
            <span className="min-w-0 truncate">
              <span className="text-foreground/90">{health.name}</span>
              <span className="text-muted-foreground">{health.version ? ` · v${health.version}` : ""}</span>
            </span>
            <button onClick={() => setHealth(null)} className="text-[10.5px] text-muted-foreground hover:text-foreground underline shrink-0">
              change
            </button>
          </div>
          {/* Nothing to paste first: syncing needs the box, not a key. The
              Claude sign-in is the one thing the agent waits on, and it has its
              own line at the top of Settings. */}
          <Button size="sm" onClick={() => void sync()} disabled={busy === "sync"}>
            {busy === "sync" ? "Syncing…" : `Sync this vault with ${health.name}`}
          </Button>
        </>
      )}
      {error && (
        <p className="text-[11px] text-amber-500/90 break-words">
          {error}
          {health && busy === null && (
            <button onClick={() => void sync()} className="ml-1.5 underline hover:text-foreground">
              Retry
            </button>
          )}
        </p>
      )}
      <button
        onClick={() => {
          setOpen(false);
          setHealth(null);
          setPicked(null);
          setError(null);
          setTrouble(null);
        }}
        className="block text-[10.5px] text-muted-foreground hover:text-foreground underline"
      >
        cancel
      </button>
    </div>
  );
}

// Read-only status of the box sync, plus "Sync now". Everything here comes
// from the last cycle's report (src-tauri/src/box_sync.rs).
function BoxSyncPanel({ vault, box, onDisconnected }: { vault: string; box: BoxConfig; onDisconnected: () => void }) {
  const [st, setSt] = useState<BoxSyncState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [discError, setDiscError] = useState<string | null>(null);
  const [keyFail, setKeyFail] = useState<string | null>(null);
  useEffect(() => subscribeKeyPush(setKeyFail), []);
  const disconnect = async () => {
    setBusy(true);
    setDiscError(null);
    try {
      await disconnectBox(vault);
      onDisconnected();
    } catch (e) {
      setDiscError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };
  const [, tick] = useState(0);
  useEffect(() => subscribeBoxSync(setSt), []);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 5000);
    return () => window.clearInterval(id);
  }, []);
  const r = st?.report ?? null;
  const gh = r ? githubPlain(r) : null;
  const ago = (t: number | null | undefined) => {
    if (!t) return "never";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : new Date(t).toLocaleString();
  };
  const row = (label: string, value: React.ReactNode, tone?: "warn" | "bad") => (
    <div className="flex items-start gap-3 text-[11.5px]">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 break-words ${tone === "bad" ? "text-destructive" : tone === "warn" ? "text-amber-500" : "text-foreground/90"}`}
      >
        {value}
      </span>
    </div>
  );
  const syncNow = async () => {
    setBusy(true);
    try {
      await boxSyncNow(vault);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
      {row("Box", <span className="font-mono text-[11px]">{`${box.box}/git/${box.vault}.git`}</span>)}
      {row(
        "Last sync",
        st?.running && !r ? "syncing…" : r?.error ? `failed · last good ${ago(st?.lastOkAt)}` : ago(st?.lastOkAt),
        r?.error ? (st?.attention?.level === "red" ? "bad" : "warn") : undefined,
      )}
      {r && row("Waiting for box", `${r.changes_waiting} commit${r.changes_waiting === 1 ? "" : "s"}`)}
      {r?.conflict &&
        row(
          "Merge gate",
          `closed since ${new Date(r.conflict.since).toLocaleString()}: ${r.conflict.files.join(", ")}. Ask the agent: resolve the sync conflict.`,
          "warn",
        )}
      {r && !r.conflict && row("Merge gate", "open")}
      {r && r.big_upload_error && r.big_files.length > 0 &&
        row(
          "Not on the box yet",
          r.big_files.map((b) => `${b.path} (${fmtSize(b.size)})`).join(", ") + " — over 50 MB; sending failed, retried every sync",
          "warn",
        )}
      {r &&
        row(
          "GitHub backup",
          gh
            ? gh.line
            : r.github_uploading
              ? `uploading…${r.github_pending ? ` (${r.github_pending} commit${r.github_pending === 1 ? "" : "s"} to go)` : ""}`
              : r.github_pushed_at
                ? ago(r.github_pushed_at)
                : "no github remote, or not yet",
          gh ? "warn" : undefined,
        )}
      {gh && <div className="text-[11.5px] leading-relaxed text-foreground/90 pt-0.5">{gh.detail}</div>}
      {r?.error && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-muted-foreground pt-1">
          {r.error}
        </pre>
      )}
      {r?.github_warning && (
        <details className="text-[10.5px] text-muted-foreground">
          <summary className="cursor-pointer select-none">What git said</summary>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono leading-relaxed pt-1">{r.github_warning}</pre>
        </details>
      )}
      <div className="pt-1 flex items-center gap-2">
        <button
          onClick={syncNow}
          disabled={busy || !!st?.running}
          className="text-[10.5px] text-muted-foreground hover:text-foreground underline disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy || st?.running ? "syncing…" : "sync now"}
        </button>
        <span className="text-[10.5px] text-muted-foreground/70">·</span>
        <button
          onClick={() => setConfirming(true)}
          disabled={busy}
          className="text-[10.5px] text-muted-foreground hover:text-foreground underline disabled:opacity-40 disabled:cursor-not-allowed"
        >
          disconnect
        </button>
      </div>
      {confirming && (
        <div className="space-y-1.5 pt-1">
          <p className="text-[11px] text-foreground/90">
            Disconnect {boxName(box)}? Chat goes back to running on this laptop. {boxName(box)} keeps its copy of this vault.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" onClick={() => void disconnect()} disabled={busy}>
              Disconnect
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {discError && <p className="text-[11px] text-destructive">{discError}</p>}
      {keyFail && (
        <p className="text-[11px] text-amber-500/90 break-words pt-1">
          Your keys didn't reach {boxName(box)}: {keyFail}
          <button onClick={() => void pushKeysToBox(box.box)} className="ml-1.5 underline hover:text-foreground">
            Retry
          </button>
        </p>
      )}
    </div>
  );
}

/** The phone app's one home is the box (always on): its fixed https link, no
 *  token — the box knows the phone by its Tailscale login. */
function PhoneLink({ box }: { box: BoxConfig | null }) {
  const [copied, setCopied] = useState<"phone" | null>(null);
  const link = box ? `${box.box.replace(/\/+$/, "")}/phone` : null;
  return (
    <div className="space-y-1.5">
      <h4 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">Phone</h4>
      {link ? (
        <>
          <div className="flex items-center gap-2">
            <code className="text-[11px] font-mono bg-muted px-2 py-1 rounded truncate flex-1 min-w-0">{link}</code>
            <button
              className="text-[11px] px-2.5 py-1 rounded border border-border hover:bg-muted shrink-0"
              onClick={() => {
                void navigator.clipboard?.writeText(link);
                setCopied("phone");
                setTimeout(() => setCopied(null), 1500);
              }}
            >
              {copied === "phone" ? "copied" : "copy"}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground/70">Open it on your phone (signed in to Tailscale) and add it to the Home Screen.</p>
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground/70">The phone app runs on a box — connect one above.</p>
      )}
    </div>
  );
}
