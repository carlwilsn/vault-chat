// The app's status for an installing agent, and the vault it may have picked
// (src-tauri/src/first_run.rs has the file, `vault-chat --status` and the rules).
//
// Main window only. The status is written at start, whenever the open vault or
// the Claude sign-in changes, and on a timer (10 s until the app is signed in
// with a healthy server, then 60 s) so `server.healthy` stays true to life.
// What goes over is the fields below and nothing else: never a key, a token or
// a box token (the native side keeps only these fields and redacts them again).
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { claudeSignedIn } from "./claudeAuth";

export type AppStatusReport = {
  signedIn: boolean;
  vault: string | null;
  serverHealthy: boolean;
  serverUrl: string | null;
  git: string | null;
  gitHelp: string | null;
  signInError: string | null;
};

/** The report, from the store's sign-in copy, the open vault and the server's health body (null: no answer). */
export function statusReport(o: { laptopKey: string | null | undefined; vault: string | null; health: unknown; serverUrl: string | null; signInError?: string | null }): AppStatusReport {
  const h = o.health && typeof o.health === "object" ? (o.health as Record<string, unknown>) : null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  return {
    signedIn: claudeSignedIn(o.laptopKey, o.health),
    vault: o.vault,
    serverHealthy: !!h,
    serverUrl: h ? o.serverUrl : null,
    git: str(h?.git),
    gitHelp: str(h?.gitHelp),
    signInError: o.signInError ?? null,
  };
}

let lastSignInError: string | null = null;
let poke: (() => void) | null = null;

/** The last one-click sign-in failure (null after a success), so an agent can see why. */
export function noteSignInError(why: string | null): void {
  lastSignInError = why;
  poke?.();
}

async function readHealth(vault: string | null): Promise<{ body: unknown; url: string | null }> {
  if (!vault) return { body: null, url: null };
  const { boxGet, boxLinkFor } = await import("./boxChat");
  const link = await boxLinkFor(vault).catch(() => null);
  if (!link) return { body: null, url: null };
  const body = await boxGet(link, "/api/v1/health", 5_000).catch(() => null);
  return { body: body && typeof body === "object" ? body : null, url: link.url };
}

/** Start writing the status; returns a stop. */
export function installAppStatus(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let writing = false;
  let again = false;
  const write = async () => {
    if (writing) {
      again = true;
      return;
    }
    writing = true;
    let next = 10_000;
    try {
      const s = useStore.getState();
      const { body, url } = await readHealth(s.vaultPath);
      const report = statusReport({ laptopKey: s.serviceKeys.claudeCode, vault: s.vaultPath, health: body, serverUrl: url, signInError: lastSignInError });
      if (report.signedIn && report.serverHealthy) next = 60_000;
      await invoke("app_status_write", { status: report });
    } catch (e) {
      console.warn("[status]", e);
    } finally {
      writing = false;
    }
    if (stopped) return;
    if (again) {
      again = false;
      return schedule(300);
    }
    schedule(next);
  };
  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void write(), ms);
  };
  poke = () => schedule(300);
  const unsub = useStore.subscribe((s, prev) => {
    if (s.vaultPath !== prev.vaultPath || s.serviceKeys.claudeCode !== prev.serviceKeys.claudeCode) schedule(300);
  });
  schedule(0);
  return () => {
    stopped = true;
    poke = null;
    unsub();
    if (timer) clearTimeout(timer);
  };
}

/** At start: open the vault an installer picked (setup.json / VC_SETUP_VAULT), when none is open. */
export async function openSetupVault(): Promise<string | null> {
  const vaultOpen = !!useStore.getState().vaultPath;
  const picked = await invoke<string | null>("setup_take", { vaultOpen }).catch((e) => {
    console.warn("[setup]", e);
    return null;
  });
  if (!picked || useStore.getState().vaultPath) return null;
  const { openVaultAt } = await import("./openVault");
  await openVaultAt(picked);
  return picked;
}
