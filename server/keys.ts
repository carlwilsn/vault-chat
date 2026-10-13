// The box's key store, read in-process: vault-chat's headless fallback
// (lib.rs:5942) — `secrets.age` is base64 of an age scrypt-passphrase file
// whose plaintext is a JSON {name: value} map; the passphrase is the content
// of the adjacent `fallback.key` (lib.rs:6002, 6025, 6101). Written only by
// saveKeys (POST /api/v1/keys: the connected laptop pushes its whole keychain
// — OpenRouter, ElevenLabs, Tavily, named service keys). Values are never
// logged.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Decrypter, Encrypter } from "age-encryption";
import { writeAtomic } from "./atomic";
import type { CommandFn } from "./commands/registry";

let secrets: Map<string, string> = new Map();
let loadError: string | null = null;

/** Decrypt the store. Missing files yield an empty map plus a reason. */
export async function loadKeyStore(dir: string): Promise<{ count: number; error: string | null }> {
  secrets = new Map();
  loadError = null;
  let pass: string;
  let blob: string;
  try {
    pass = readFileSync(join(dir, "fallback.key"), "utf8").trim();
    blob = readFileSync(join(dir, "secrets.age"), "utf8").trim();
  } catch (e) {
    loadError = `key store not readable in ${dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`;
    return { count: 0, error: loadError };
  }
  try {
    const d = new Decrypter();
    d.addPassphrase(pass);
    const text = await d.decrypt(Buffer.from(blob, "base64"), "text");
    const map = JSON.parse(text) as Record<string, unknown>;
    for (const [k, v] of Object.entries(map)) if (typeof v === "string") secrets.set(k, v);
  } catch (e) {
    loadError = `key store in ${dir} could not be decrypted (${(e as Error).message})`;
    return { count: 0, error: loadError };
  }
  return { count: secrets.size, error: null };
}

/** A key's name as the laptop's keychain spells it: api.<provider>,
 * service.<name> or user.<name>. */
export function validKeyName(n: string): boolean {
  return /^(api|service|user)\.[A-Za-z0-9_-]{1,64}$/.test(n);
}

/** Make the store exactly `keys` (the laptop's keychain is the source: a key
 * it no longer has is removed here). Same format; created if there is none;
 * an existing store that does not decrypt is never overwritten. Returns
 * whether anything changed. */
export async function saveKeys(dir: string, keys: Record<string, string>): Promise<boolean> {
  const ageFile = join(dir, "secrets.age");
  const passFile = join(dir, "fallback.key");
  if (existsSync(ageFile)) {
    const r = await loadKeyStore(dir);
    if (r.error) throw new Error(r.error);
  } else {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(passFile) || !readFileSync(passFile, "utf8").trim()) {
      writeFileSync(passFile, randomBytes(32).toString("base64url"));
      try {
        chmodSync(passFile, 0o600);
      } catch {
        /* windows */
      }
    }
    secrets = new Map();
  }
  const next = new Map(Object.entries(keys).sort(([a], [b]) => a.localeCompare(b)));
  if (next.size === secrets.size && [...next].every(([k, v]) => secrets.get(k) === v)) return false;
  const e = new Encrypter();
  e.setPassphrase(readFileSync(passFile, "utf8").trim());
  const ct = await e.encrypt(JSON.stringify(Object.fromEntries(next)));
  writeAtomic(ageFile, Buffer.from(ct).toString("base64"));
  try {
    chmodSync(ageFile, 0o600);
  } catch {
    /* windows */
  }
  secrets = next;
  loadError = null;
  return true;
}

/** The names in the store (never the values). */
export function keyNames(): string[] {
  return [...secrets.keys()].filter((k) => !!secrets.get(k)).sort();
}

export function hasKey(name: string): boolean {
  return !!secrets.get(name);
}

export function keyStoreError(): string | null {
  return loadError;
}

export const keychainCommands: Record<string, CommandFn> = {
  // lib.rs:5883 keychain_get — on the box the fallback file IS the store.
  keychain_get: ({ key }) => secrets.get(String(key)) ?? null,
  // lib.rs:5903 / 5927 — the server never writes keys (no new credentials;
  // keys are managed on the box with the desktop app or by hand).
  keychain_set: ({ key }) => {
    throw `keychain is read-only on the server (refused to set ${key})`;
  },
  keychain_delete: ({ key }) => {
    throw `keychain is read-only on the server (refused to delete ${key})`;
  },
};
