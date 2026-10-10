// The box's key store, read in-process: vault-chat's headless fallback
// (lib.rs:5942) — `secrets.age` is base64 of an age scrypt-passphrase file
// whose plaintext is a JSON {name: value} map; the passphrase is the content
// of the adjacent `fallback.key` (lib.rs:6002, 6025, 6101). Read-only here.
// Values are never logged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Decrypter } from "age-encryption";
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
