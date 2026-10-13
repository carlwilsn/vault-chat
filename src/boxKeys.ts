// The connected box gets this laptop's keys. One rule: the laptop's keychain
// is the source. On connect the whole set goes to the box (POST /api/v1/keys,
// {name: value}, over the tailnet); any add / change / removal under
// Settings → Keys pushes the set again (a key gone here is removed there).
// The box keeps them in its own key store, never in the vault or git.
import { useStore } from "./store";
import { KEY, listUserKeys, getUserKey, userKeyName } from "./keychain";
import { boxPost } from "./boxChat";
import { readBoxConfig } from "./vaultSync";

/** Every key this laptop has, by keychain name (api.*, service.*, user.*). */
export async function laptopKeys(): Promise<Record<string, string>> {
  const s = useStore.getState();
  const out: Record<string, string> = {};
  for (const [p, v] of Object.entries(s.apiKeys)) {
    const name = (KEY as Record<string, string>)[p];
    if (name && v) out[name] = v;
  }
  if (s.serviceKeys.tavily) out[KEY.tavily] = s.serviceKeys.tavily;
  if (s.serviceKeys.elevenlabs) out[KEY.elevenlabs] = s.serviceKeys.elevenlabs;
  for (const n of listUserKeys()) {
    const v = await getUserKey(n).catch(() => null);
    if (v) out[userKeyName(n)] = v;
  }
  return out;
}

// The last push's failure, for one quiet line + Retry in Settings → Box.
let failure: string | null = null;
const listeners = new Set<(f: string | null) => void>();
function setFailure(f: string | null): void {
  failure = f;
  for (const l of listeners) l(f);
}
export function subscribeKeyPush(fn: (f: string | null) => void): () => void {
  listeners.add(fn);
  fn(failure);
  return () => listeners.delete(fn);
}

/** Push the whole set to the box at `url`. Null on success, else the error. */
export async function pushKeysToBox(url: string): Promise<string | null> {
  const r = await boxPost({ url, token: useStore.getState().boxToken || null }, "/api/v1/keys", { keys: await laptopKeys() });
  const err = r.ok ? null : r.error || "the box refused the keys";
  setFailure(err);
  return err;
}

/** Settings → Keys changed something: push to the open vault's box, if any. */
export async function keysChanged(): Promise<void> {
  const vault = useStore.getState().vaultPath;
  const cfg = vault ? await readBoxConfig(vault) : null;
  if (cfg) await pushKeysToBox(cfg.box);
}
