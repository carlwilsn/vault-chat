// Files Carl attaches to a chat message from outside the vault (dropped from
// Explorer, picked with +, pasted, or an @ of a path on this laptop). The agent
// runs on the box, which cannot open a path on this laptop, so — the way Claude
// Code reads a file you attach — the bytes are read here when attached and go
// to the box with the message (boxChat.ts boxSend → boxUploadFile). A file
// inside the vault stays an @-reference: the box has its own copy.
import { invoke } from "@tauri-apps/api/core";
import { ATTACH_MAX_BYTES, tooBig } from "./boxChat";
import type { FileUpload } from "./store";

export type Attached = { ok: true; file: FileUpload } | { ok: false; error: string };

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** A path inside the open vault (the box has it), compared without case on Windows-style paths. */
export function insideVault(path: string, vault: string | null): boolean {
  if (!vault) return false;
  const p = norm(path);
  const v = norm(vault);
  const win = /^[a-z]:\//i.test(v);
  return win ? p.toLowerCase().startsWith(v.toLowerCase() + "/") : p.startsWith(v + "/");
}

export function baseName(path: string): string {
  return norm(path).split("/").pop() || path;
}

async function blobToBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A dropped or pasted file (its bytes are at hand). */
export async function attachBlob(name: string, blob: Blob): Promise<Attached> {
  if (blob.size > ATTACH_MAX_BYTES) return { ok: false, error: tooBig(name, blob.size) };
  if (blob.size === 0) return { ok: false, error: `${name} is empty (or a folder): nothing to attach.` };
  try {
    return { ok: true, file: { name, size: blob.size, dataBase64: await blobToBase64(blob) } };
  } catch (e) {
    return { ok: false, error: `Couldn't read ${name}: ${String((e as Error)?.message ?? e)}` };
  }
}

/** A file on this laptop, by its path (the + picker, an @ of a path). */
export async function attachPath(path: string): Promise<Attached> {
  const name = baseName(path);
  let bytes: number[];
  try {
    bytes = await invoke<number[]>("read_binary_file", { path });
  } catch (e) {
    return { ok: false, error: `Couldn't read ${name}: ${String((e as Error)?.message ?? e)}` };
  }
  return attachBlob(name, new Blob([new Uint8Array(bytes)]));
}

/**
 * `@` followed by an absolute path on this laptop, as typed or pasted: `@C:\Users\me\x.pdf`,
 * `@/home/me/x.pdf`, or quoted when it has spaces: `@"C:\Users\me\Downloads\My notes.pdf"`.
 */
export function pathMentions(text: string): { raw: string; path: string }[] {
  const out: { raw: string; path: string }[] = [];
  const re = /(^|\s)(@"((?:[a-zA-Z]:[\\/]|\/)[^"]+)"|@((?:[a-zA-Z]:[\\/]|\/)[^\s"]+))/g;
  for (const m of text.matchAll(re)) out.push({ raw: m[2]!, path: (m[3] ?? m[4])! });
  return out;
}

export function sizeLabel(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
