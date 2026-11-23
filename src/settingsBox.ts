// Settings → Box and Settings → vault-chat folder as state and actions (report 28: they were the pane's local flow).
// What the box sync says (connected box, last sync, merge gate, GitHub backup, files not on the box yet), and the
// connect / sync now / disconnect steps; the laptop's vault-chat folder and its repos, and setting it. The pane
// (src/plugins/settings/Pane.tsx, src/MasterSection.tsx) and app/settings' offers call these same functions.
import { useStore } from "./store";
import { boxName, boxSyncNow, boxVaultName, connectBox, disconnectBox, discoverBoxes, githubPlain, readBoxConfig, subscribeBoxSync, tailscaleCheck, type BoxConfig, type BoxSyncState, type FoundBox } from "./vaultSync";
import { connectTrouble, tailscaleHelp } from "./tailscaleHelp";
import { boxGet, boxPost } from "./boxChat";
import { pushKeysToBox, subscribeKeyPush } from "./boxKeys";
import { boxMasterInfo, localProjects, localVaults, masterPath, setMasterPath, syncMasterFolder, type BoxMasterInfo } from "./master";

const fns = new Set<() => void>();
const changed = () => {
  for (const f of [...fns]) f();
};
/** Hear the box or the folder state change (a sync cycle, a key push, connect / disconnect, the folder set). */
export function onSettingsBoxChanged(fn: () => void): () => void {
  fns.add(fn);
  const a = subscribeBoxSync((s) => ((last = s), fn()));
  const b = subscribeKeyPush((e) => ((keyFail = e), fn()));
  return () => {
    fns.delete(fn);
    a();
    b();
  };
}
let last: BoxSyncState | null = null;
let keyFail: string | null = null;
let config: { vault: string | null; box: BoxConfig | null } = { vault: null, box: null };

/** The open vault's box (sync.json), read again (connect / disconnect change it). */
export async function refreshBoxConfig(): Promise<BoxConfig | null> {
  const vault = useStore.getState().vaultPath;
  const box = vault ? await readBoxConfig(vault).catch(() => null) : null;
  const was = JSON.stringify(config);
  config = { vault, box };
  if (JSON.stringify(config) !== was) changed();
  return box;
}

/** The Box section's status rows, now. */
export function boxStatusNow() {
  const vault = useStore.getState().vaultPath;
  if (config.vault !== vault) void refreshBoxConfig();
  const box = config.vault === vault ? config.box : null;
  if (!box) return { connected: null };
  const r = last?.vault === vault || !last?.vault ? last?.report ?? null : null;
  const gh = r ? githubPlain(r) : null;
  return {
    connected: { name: boxName(box), box: box.box, vault: box.vault },
    syncing: !!last?.running,
    lastSyncOk: last?.lastOkAt ? new Date(last.lastOkAt).toISOString() : null,
    ...(r?.error ? { error: r.error } : {}),
    ...(r ? { waitingForBox: r.changes_waiting, mergeGate: r.conflict ? { closedSince: new Date(r.conflict.since).toISOString(), files: r.conflict.files } : "open" } : {}),
    ...(r && r.big_upload_error && r.big_files.length ? { notOnBoxYet: r.big_files.map((b) => ({ path: b.path, size: b.size })) } : {}),
    ...(r ? { github: gh ? gh.line : r.github_uploading ? "uploading" : r.github_pushed_at ? new Date(r.github_pushed_at).toISOString() : "no github remote, or not yet" } : {}),
    ...(keyFail ? { keysDidNotReach: keyFail } : {}),
  };
}

/** Connect a box, step 1: the boxes on the tailnet (none: why, from Tailscale). */
export async function findBoxes(): Promise<{ boxes: FoundBox[]; trouble: string | null }> {
  try {
    const boxes = await discoverBoxes();
    return { boxes, trouble: boxes.length ? null : tailscaleHelp(await tailscaleCheck())?.line ?? null };
  } catch (e) {
    return { boxes: [], trouble: connectTrouble("the tailnet", e instanceof Error ? e.message : String(e), await tailscaleCheck())?.line ?? String(e) };
  }
}

const link = (url: string) => ({ url, token: useStore.getState().boxToken || null });
export const boxUrlOf = (raw: string) => {
  let url = raw.trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//.test(url)) url = `https://${url}`;
  return url;
};

/** Step 2: does this address answer as a vault-chat server (its name and version), or why not. */
export async function checkBox(raw: string, fallbackName?: string): Promise<{ ok: true; name: string; version: string | null } | { ok: false; error: string }> {
  const url = boxUrlOf(raw);
  const fallback = fallbackName ?? url.replace(/^https?:\/\//, "").split(".")[0] ?? url;
  try {
    const h = await boxGet(link(url), "/api/v1/health", 6000);
    const isServer = h?.app === "vault-chat-server" || (h?.ok === true && h?.version && h?.keys);
    if (!isServer) throw new Error("it doesn't answer as a vault-chat server");
    return { ok: true, name: h.name || fallback, version: h.version ?? null };
  } catch (e) {
    return { ok: false, error: connectTrouble(fallback, e instanceof Error ? e.message : String(e), await tailscaleCheck())?.line ?? String(e) };
  }
}

/** Step 3: sync this vault with the box (it gets this laptop's keys); the chat moves to it. */
export async function syncWithBox(vault: string, raw: string, name: string): Promise<void> {
  const url = boxUrlOf(raw);
  const r = await boxPost(link(url), "/api/v1/vaults", { name: boxVaultName(vault) });
  if (!r.ok) throw new Error(r.error ?? "the box refused");
  const keyErr = await pushKeysToBox(url);
  if (keyErr) throw new Error(`your keys didn't reach it (${keyErr})`);
  await connectBox(vault, url, name);
  await boxConnectionChanged(true);
}

/** Sync now (the status's sync now). */
export async function syncBoxNow(): Promise<void> {
  const vault = useStore.getState().vaultPath;
  if (!vault) throw new Error("no vault is open");
  await boxSyncNow(vault);
}

/** Disconnect (after its confirm): the chat goes back to the laptop; the box keeps its copy. */
export async function disconnectFromBox(): Promise<void> {
  const vault = useStore.getState().vaultPath;
  if (!vault) throw new Error("no vault is open");
  await disconnectBox(vault);
  await boxConnectionChanged(false);
}

/** After connect / disconnect: sync.json read again and the chat moved (box mode is decided when conversations load). */
export async function boxConnectionChanged(connected: boolean): Promise<void> {
  if (!connected) (await import("./boxChat")).stopBoxChat();
  await refreshBoxConfig();
  void useStore.getState().loadConversations();
}

// ---- the vault-chat folder ----

let folder: { path: string | null; vaults: string[]; projects: string[]; box: BoxMasterInfo | null } = { path: null, vaults: [], projects: [], box: null };
/** The folder and its repos, read again. */
export async function refreshFolder() {
  const m = masterPath();
  folder = { path: m, vaults: await localVaults(m), projects: await localProjects(m), box: await boxMasterInfo().catch(() => null) };
  changed();
  return folder;
}
/** The folder as last read (the pane and the offers read it again on open). */
export function folderNow() {
  const onBox = (kind: "vaults" | "projects", n: string) => (kind === "projects" ? folder.box?.projects : folder.box?.vaults)?.some((x) => x.name === n) ?? false;
  return {
    path: folder.path,
    boxFolder: folder.box?.master ?? null,
    repos: [...folder.vaults.map((n) => ({ kind: "vault", name: n, onBox: onBox("vaults", n) })), ...folder.projects.map((n) => ({ kind: "project", name: n, onBox: onBox("projects", n) }))],
  };
}
/** Set the folder (the section's Set / Change): what the box has that the laptop doesn't is brought over. */
export async function setFolder(path: string): Promise<string | null> {
  const r = await setMasterPath(path);
  if ("error" in r) return r.error;
  const s = await syncMasterFolder();
  await refreshFolder();
  return s.errors.length ? s.errors.join("; ") : s.made.length ? `Brought from the box: ${s.made.join(", ")}.` : null;
}
