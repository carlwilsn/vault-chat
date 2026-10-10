// Posix `node:path` for the reused server/commands ports. Vault paths in the
// preview are posix (`/vaults/<name>`), so this is all they need.
import { norm } from "./memfs";

export const sep = "/";
export function join(...parts: string[]): string {
  return norm(parts.filter((p) => p !== "").join("/"));
}
export function isAbsolute(p: string): boolean {
  return String(p).replace(/\\/g, "/").startsWith("/");
}
export function resolve(...parts: string[]): string {
  let out = "";
  for (const p of parts) out = isAbsolute(p) ? p : out ? out + "/" + p : p;
  return norm(isAbsolute(out) ? out : "/" + out);
}
export function dirname(p: string): string {
  const s = norm(p);
  const i = s.lastIndexOf("/");
  if (i < 0) return ".";
  return i === 0 ? "/" : s.slice(0, i);
}
export function basename(p: string, ext?: string): string {
  const b = norm(p).split("/").pop() ?? "";
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
}
export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i) : "";
}
export function relative(from: string, to: string): string {
  const a = resolve(from).split("/").filter(Boolean);
  const b = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}
export function normalize(p: string): string {
  return norm(p);
}
export const posix = { sep, join, isAbsolute, resolve, dirname, basename, extname, relative, normalize };
export default posix;
