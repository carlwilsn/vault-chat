import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, X, Plus } from "lucide-react";
import { useStore, type Theme } from "../../store";
import { Button, Input } from "../../ui";
import { cleanKeyName } from "../../keychain";
import {
  readBoxConfig,
  subscribeBoxSync,
  fmtSize,
  githubPlain,
  type BoxConfig,
  type BoxSyncState,
  boxName,
  discoverBoxes,
  type FoundBox,
  tailscaleCheck,
  openTailscale,
} from "../../vaultSync";
import { connectTrouble, tailscaleHelp, GET_TAILSCALE_URL, type TailscaleHelp } from "../../tailscaleHelp";
import { openUrl } from "../../opener";
import { boxGet } from "../../boxChat";
import { pushKeysToBox, keysChanged, subscribeKeyPush } from "../../boxKeys";
import { ClaudeAccountLine } from "../../ClaudeCodeSignIn";
import { disconnectFromBox, syncBoxNow, syncWithBox } from "../../settingsBox";
import { MasterSection } from "../../MasterSection";
import { Picker, type PickOption } from "../../SearchPicker";

// The Claude sign-in on one line at the top, then the sections: Appearance, Keys, vault-chat folder, Box. No shortcut
// sheet: Carl asks the agent (app/settings' state shortcuts). There is no voice section: the core voice is local (Kokoro, af_heart) with nothing to
// pick, and the ElevenLabs voice is box:settings' voice (the ElevenLabs voice plugin draws nothing).
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
  { id: "appearance", title: "Appearance" },
  { id: "keys", title: "Keys" },
  { id: "master", title: "vault-chat folder" },
  { id: "box", title: "Box" },
];

export function Pane() {
  const setShowSettings = useStore((s) => s.setShowSettings);
  return (
    <div className="h-full flex flex-col bg-card border-l border-border" data-el="settings-pane">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Button data-offer="app/settings.close" variant="ghost" size="icon" onClick={() => setShowSettings(false)} data-el="settings-back">
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="text-[13px] font-semibold">Settings</span>
      </div>
      <div className="flex-1 overflow-auto p-5 space-y-6" data-el="settings-scroll">
        <div data-settings="account">
          <ClaudeAccountLine />
        </div>
        <Divider />
        <div data-settings="appearance">
          <AppearanceSection />
        </div>
        <Divider />
        <div data-settings="keys">
          <KeysSection />
        </div>
        <Divider />
        <MasterSection />
        <Divider />
        <BoxSection />
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
      <SectionHead data-offer-exempt="Keys: a key is a secret, never state the agent reads or sets"
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
          <Button data-offer-exempt="Keys: a key is a secret, never state the agent reads or sets" size="sm" onClick={() => void save()} disabled={!edit.name.trim() || !edit.value.trim()}>
            Save
          </Button>
          <Button data-offer-exempt="Keys: a key is a secret, never state the agent reads or sets" size="sm" variant="ghost" onClick={() => setEdit(null)} title="Cancel">
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
                <Button data-offer-exempt="Keys: a key is a secret, never state the agent reads or sets" size="sm" variant="ghost" onClick={() => setEdit({ name: n, value: "", replacing: true })} title="Replace">
                  Replace
                </Button>
                <Button data-offer-exempt="Keys: a key is a secret, never state the agent reads or sets" size="sm" variant="ghost" onClick={() => void removeKey(n)} title="Remove">
                  <X className="h-3 w-3" />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        !edit && <p className="text-[11px] text-muted-foreground/60 italic">No keys yet.</p>
      )}
    </section>
  );
}

// ---- Appearance --------------------------------------------------------------

// Each theme's own tokens (src/App.css :root, [data-theme="light"], [data-theme="contrast"]): a tile is a small
// picture of the app in it, so the pick needs no menu (Carl: the dropdown opened past the bottom of the pane).
const THEME_TILES: { value: Theme; label: string; bg: string; card: string; fg: string; muted: string; border: string }[] = [
  { value: "graphite", label: "Graphite", bg: "hsl(0 0% 10%)", card: "hsl(0 0% 13%)", fg: "hsl(0 0% 92%)", muted: "hsl(0 0% 60%)", border: "hsl(0 0% 22%)" },
  { value: "light", label: "Light", bg: "hsl(0 0% 98%)", card: "hsl(0 0% 100%)", fg: "hsl(0 0% 12%)", muted: "hsl(0 0% 42%)", border: "hsl(0 0% 88%)" },
  { value: "contrast", label: "High contrast", bg: "hsl(0 0% 0%)", card: "hsl(0 0% 0%)", fg: "hsl(0 0% 100%)", muted: "hsl(0 0% 81.6%)", border: "hsl(0 0% 100%)" },
];

function AppearanceSection() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  // The pick is the box's settings action (box:settings set theme); what it refuses is shown, not applied.
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <section className="space-y-2">
      <SectionHead title="Appearance" />
      <div className="flex gap-3" data-el="theme-tiles">
        {THEME_TILES.map((t) => {
          const on = theme === t.value;
          return (
            <button
              key={t.value}
              data-offer="box:settings.set"
              data-theme-tile={t.value}
              aria-pressed={on}
              onClick={() => {
                setRefused(null);
                void setTheme(t.value).then(setRefused);
              }}
              className="group flex flex-col items-center gap-1.5"
            >
              <span
                className={`block h-[52px] w-[84px] overflow-hidden rounded-md ring-offset-2 ring-offset-card ${on ? "ring-2 ring-foreground/80" : "ring-1 ring-border group-hover:ring-muted-foreground"}`}
                style={{ background: t.bg }}
              >
                <span className="flex h-full">
                  <span className="block h-full w-[22px]" style={{ background: t.card, borderRight: `1px solid ${t.border}` }}>
                    <span className="mx-[4px] mt-[7px] block h-[2px] rounded-full" style={{ background: t.muted }} />
                    <span className="mx-[4px] mt-[4px] block h-[2px] rounded-full" style={{ background: t.muted }} />
                    <span className="mx-[4px] mt-[4px] block h-[2px] w-[8px] rounded-full" style={{ background: t.muted }} />
                  </span>
                  <span className="block flex-1 px-[6px] pt-[7px]">
                    <span className="block h-[3px] w-[28px] rounded-full" style={{ background: t.fg }} />
                    <span className="mt-[5px] block h-[2px] w-[44px] rounded-full" style={{ background: t.muted }} />
                    <span className="mt-[3px] block h-[2px] w-[36px] rounded-full" style={{ background: t.muted }} />
                    <span className="mt-[3px] block h-[2px] w-[40px] rounded-full" style={{ background: t.muted }} />
                  </span>
                </span>
              </span>
              <span className={`text-[11px] ${on ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"}`}>{t.label}</span>
            </button>
          );
        })}
      </div>
      {refused && <p className="text-[11px] text-destructive">{refused}</p>}
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
    void connected; // boxConnectionChanged (src/settingsBox.ts) moved the chat already
    setRev((n) => n + 1);
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
        <button data-offer="app/titlebar.openTailscale" onClick={() => void act()} className="ml-1.5 underline hover:text-foreground" data-testid="tailscale-action">
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
    // (app/settings findBoxes runs the same discovery: src/settingsBox.ts.)
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
    // (app/settings connectBox checks the same way: src/settingsBox.ts checkBox.)
  };
  const sync = async () => {
    if (!picked || !health) return;
    setBusy("sync");
    setError(null);
    try {
      // The one connect (src/settingsBox.ts), as app/settings' connectBox.
      await syncWithBox(vault, picked, health.name);
      onConnected();
    } catch (e) {
      setError(`Couldn't sync with ${health.name}: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(null);
    }
  };

  if (!open) {
    return (
      <Button data-offer="app/settings.findBoxes" size="sm" variant="outline" onClick={() => void start()}>
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
            <Button data-offer="app/settings.connectBox" size="sm" variant="outline" onClick={() => void check(address)} disabled={!address.trim() || busy === "checking"}>
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
            <button data-offer="app/settings.findBoxes" onClick={() => setHealth(null)} className="text-[10.5px] text-muted-foreground hover:text-foreground underline shrink-0">
              change
            </button>
          </div>
          {/* Nothing to paste first: syncing needs the box, not a key. The
              Claude sign-in is the one thing the agent waits on, and it has its
              own line at the top of Settings. */}
          <Button data-offer="app/settings.connectBox" size="sm" onClick={() => void sync()} disabled={busy === "sync"}>
            {busy === "sync" ? "Syncing…" : `Sync this vault with ${health.name}`}
          </Button>
        </>
      )}
      {error && (
        <p className="text-[11px] text-amber-500/90 break-words">
          {error}
          {health && busy === null && (
            <button data-offer="app/settings.connectBox" onClick={() => void sync()} className="ml-1.5 underline hover:text-foreground">
              Retry
            </button>
          )}
        </p>
      )}
      <button data-offer="app/settings.findBoxes"
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

// The box sync in two lines: its status with "Sync now", then the GitHub backup. Problems show only when they
// happen, in plain words below. Everything comes from the last cycle's report (src/boxSync/cycle.ts); the agent
// reads the same through app/settings (src/settingsBox.ts).
/** One plain sentence for a failed sync. The raw git output stays in the sync state (the agent reads it); Carl asks
 *  the agent for the detail rather than reading git's words here. */
export function syncFailReason(err: string, box: string): string {
  const e = err.toLowerCase();
  if (/could not resolve host|name or service not known|no such host|connection refused|timed out|network is unreachable|failed to connect|couldn't connect/.test(e))
    return `Can't reach ${box}. Check that Tailscale is on and ${box} is awake.`;
  if (/authentication|permission denied|403|401/.test(e)) return `${box} refused this laptop. Ask the agent to check the sync access.`;
  if (/no space left|disk full/.test(e)) return `${box} or this laptop is out of disk space.`;
  return `The last sync with ${box} failed. Ask the agent why if it keeps happening.`;
}

function BoxSyncPanel({ box, onDisconnected }: { vault: string; box: BoxConfig; onDisconnected: () => void }) {
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
      await disconnectFromBox();
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
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(t).toLocaleString();
  };
  const syncNow = async () => {
    setBusy(true);
    try {
      await syncBoxNow();
    } finally {
      setBusy(false);
    }
  };
  const syncing = busy || (!!st?.running && !r);
  const failRed = st?.attention?.level === "red";
  const [dot, status] = r?.conflict
    ? ["bg-amber-500", `Sync paused · last synced ${ago(st?.lastOkAt)}`]
    : r?.error
      ? [failRed ? "bg-destructive" : "bg-amber-500", `Sync failed · last good ${ago(st?.lastOkAt)}`]
      : syncing
        ? ["bg-muted-foreground/50 animate-pulse", "Syncing…"]
        : st?.lastOkAt
          ? ["bg-emerald-500", `Synced with ${boxName(box)} · ${ago(st.lastOkAt)}`]
          : ["bg-muted-foreground/40", `Not synced with ${boxName(box)} yet`];
  const backup = gh
    ? gh.line
    : r?.github_uploading
      ? `Uploading to GitHub…${r.github_pending ? ` (${r.github_pending} change${r.github_pending === 1 ? "" : "s"} to go)` : ""}`
      : r?.github_pushed_at
        ? `Backed up to GitHub ${ago(r.github_pushed_at)}`
        : null;
  const bigStuck = !!r && !!r.big_upload_error && r.big_files.length > 0;
  const problems = !!(r?.conflict || r?.error || bigStuck || gh || keyFail || discError);
  return (
    <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2" data-el="box-sync">
      <div className="flex items-center gap-2 text-[11.5px]">
        <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="min-w-0 flex-1 truncate text-foreground/90" data-el="box-sync-status">{status}</span>
        <button data-offer="app/settings.syncBoxNow"
          onClick={syncNow}
          disabled={busy || !!st?.running}
          className="shrink-0 text-[10.5px] text-muted-foreground hover:text-foreground underline disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Sync now
        </button>
      </div>
      {backup && (
        <p className={`pl-3.5 text-[11px] ${gh ? "text-amber-500/90" : "text-muted-foreground"}`} data-el="box-sync-backup">
          {backup}
        </p>
      )}
      {problems && (
        <div className="space-y-1.5 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] leading-relaxed text-foreground/90" data-el="box-sync-problems">
          {r?.conflict && (
            <p>
              The same files changed here and on {boxName(box)}: {r.conflict.files.join(", ")}. Sync waits until that is sorted out. Ask the agent
              to resolve the sync conflict.
            </p>
          )}
          {r?.error && (
            <p data-el="box-sync-fail">{syncFailReason(r.error, boxName(box))} It tries again by itself.</p>
          )}
          {bigStuck && (
            <p>
              Not on {boxName(box)} yet (over 50 MB, sending failed; it retries every sync):{" "}
              {r!.big_files.map((b) => `${b.path} (${fmtSize(b.size)})`).join(", ")}
            </p>
          )}
          {gh && (
            <>
              <p>{gh.detail}</p>
            </>
          )}
          {keyFail && (
            <p className="break-words">
              Your keys didn't reach {boxName(box)}: {keyFail}
              <button data-offer-exempt="pushes this laptop's keys to the box again: keys are secrets" onClick={() => void pushKeysToBox(box.box)} className="ml-1.5 underline hover:text-foreground">
                Retry
              </button>
            </p>
          )}
          {discError && <p className="text-destructive">{discError}</p>}
        </div>
      )}
      {confirming ? (
        <div className="space-y-1.5 pt-1">
          <p className="text-[11px] text-foreground/90">
            Disconnect {boxName(box)}? Chat goes back to running on this laptop. {boxName(box)} keeps its copy of this vault.
          </p>
          <div className="flex gap-2">
            <Button data-offer="app/settings.disconnectBox" size="sm" variant="destructive" onClick={() => void disconnect()} disabled={busy}>
              Disconnect
            </Button>
            <Button data-offer="app/settings.disconnectBox" size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button data-offer="app/settings.disconnectBox"
          onClick={() => setConfirming(true)}
          disabled={busy}
          className="pl-3.5 text-[10.5px] text-muted-foreground/70 hover:text-foreground underline disabled:opacity-40 disabled:cursor-not-allowed"
        >
          disconnect
        </button>
      )}
    </div>
  );
}
