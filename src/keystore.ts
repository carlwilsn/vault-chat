import { invoke } from "@tauri-apps/api/core";
import {
  keychainGet,
  keychainSet,
  KEY,
  listUserKeys,
  userKeyName,
  mergeUserKeyNames,
} from "./keychain";

// Cross-machine key sync via an encrypted keystore.
//
// The OS keychain is the runtime source of truth on each machine. This
// module only *transports* keys between machines: it serialises the
// machine's keys to JSON, asks Rust to age-encrypt it with the user's
// passphrase, and writes the blob to `<vault>/.vault-chat/keys.enc` —
// which git syncs like any other vault file. On another machine, the same
// passphrase decrypts the blob and the keys are written into that
// machine's keychain. The passphrase lives only in each machine's own
// keychain (never in git), so the committed blob is useless without it.
//
// Only machine-global keys travel: provider/API keys, service keys, the
// Telegram *user id*, and user-registered custom keys. The per-vault
// Telegram *bot token* is intentionally excluded — it's vault-specific and
// the bot runs on one designated machine, so it has no reason to roam.

const PASSPHRASE_KEY = "keystore.passphrase"; // machine-local, in keychain
// keys.enc is intentionally NOT gitignored — it must sync via git for the
// cross-machine flow. Safe because it's age-encrypted and useless without
// the passphrase, which lives only in each machine's own keychain.
const KEYS_ENC_REL = ".vault-chat/keys.enc";

export type KeystoreResult = { ok: boolean; message: string };

function encPath(vault: string): string {
  return `${vault}/${KEYS_ENC_REL}`;
}

// The machine-global key names eligible to sync.
function globalKeyNames(): string[] {
  return [
    KEY.anthropic,
    KEY.openai,
    KEY.google,
    KEY.openrouter,
    KEY.tavily,
    KEY.elevenlabs,
    KEY.telegram_user_id,
    ...listUserKeys().map(userKeyName),
  ];
}

export async function getPassphrase(): Promise<string | null> {
  return keychainGet(PASSPHRASE_KEY);
}

export async function setPassphrase(passphrase: string): Promise<void> {
  await keychainSet(PASSPHRASE_KEY, passphrase);
}

export async function hasKeystore(vault: string): Promise<boolean> {
  try {
    const blob = await invoke<string>("read_text_file", { path: encPath(vault) });
    return blob.trim().length > 0;
  } catch {
    return false;
  }
}

// Encrypt this machine's keys into <vault>/.vault-chat/keys.enc.
export async function exportKeys(vault: string): Promise<KeystoreResult> {
  const pass = await getPassphrase();
  if (!pass) return { ok: false, message: "set a passphrase first" };
  const names = globalKeyNames();
  const keys: Record<string, string> = {};
  for (const n of names) {
    const v = await keychainGet(n);
    if (v !== null && v !== "") keys[n] = v;
  }
  const count = Object.keys(keys).length;
  if (count === 0) return { ok: false, message: "no keys to push" };
  const payload = JSON.stringify({ keys, userKeys: listUserKeys() });
  let blob: string;
  try {
    blob = await invoke<string>("keystore_encrypt", {
      passphrase: pass,
      plaintext: payload,
    });
  } catch (e) {
    return { ok: false, message: `encrypt failed: ${String(e)}` };
  }
  try {
    await invoke("write_text_file", { path: encPath(vault), contents: blob + "\n" });
  } catch (e) {
    return { ok: false, message: `write failed: ${String(e)}` };
  }
  return { ok: true, message: `pushed ${count} keys` };
}

// Decrypt <vault>/.vault-chat/keys.enc and write the keys into this
// machine's keychain. Existing local values are overwritten (the keystore
// is the shared source for these global keys).
export async function importKeys(vault: string): Promise<KeystoreResult> {
  const pass = await getPassphrase();
  if (!pass) return { ok: false, message: "set a passphrase first" };
  let blob: string;
  try {
    blob = await invoke<string>("read_text_file", { path: encPath(vault) });
  } catch {
    return { ok: false, message: "no keys.enc in this vault yet" };
  }
  if (!blob.trim()) return { ok: false, message: "keys.enc is empty" };
  let payload: string;
  try {
    payload = await invoke<string>("keystore_decrypt", { passphrase: pass, blob });
  } catch (e) {
    return { ok: false, message: String(e) };
  }
  let parsed: { keys?: Record<string, string>; userKeys?: string[] };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, message: "decrypted payload was not valid JSON" };
  }
  const entries = Object.entries(parsed.keys ?? {});
  for (const [k, v] of entries) {
    await keychainSet(k, v);
  }
  // Restore custom-key names so Settings enumerates them on this machine.
  if (parsed.userKeys && parsed.userKeys.length) {
    mergeUserKeyNames(parsed.userKeys);
  }
  return { ok: true, message: `imported ${entries.length} keys` };
}

// On vault open: if a passphrase is set and a keystore exists, pull keys
// into the local keychain so a freshly-set-up machine inherits everything
// without re-entry. Silent no-op if either is missing.
export async function autoImportOnOpen(vault: string): Promise<void> {
  const pass = await getPassphrase();
  if (!pass) return;
  if (!(await hasKeystore(vault))) return;
  const res = await importKeys(vault);
  if (!res.ok) console.warn("[keystore] auto-import:", res.message);
}
