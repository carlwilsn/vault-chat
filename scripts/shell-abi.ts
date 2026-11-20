// The native shell's command set, versioned per command (src-tauri/shell-abi.json).
//
// A core bundle names the native commands it invokes (src/coreBundle.ts needs). A name alone does not say how the
// command is called: a bundle built after a command's arguments or result changed, run by an installed shell from
// before, would call it wrong. So every command in lib.rs shell_commands! has a signature here (its arguments as the
// bundle passes them, and its result type) and a version (the first 8 hex digits of the signature's sha256). The
// bundle's manifest carries the version of each command it needs (needs.abi); the shell carries this file
// (core_loader.rs include_str!) and refuses a bundle whose versions differ from its own, the same way it refuses one
// needing a command it lacks. Injected arguments (the app, the window, managed state) are not part of the call.
//
// The file is generated from the Rust source: `npx tsx scripts/shell-abi.ts` rewrites it; a test (server/test/
// shellAbi.test.ts) fails when it is stale. Changing a command's signature is allowed, but it makes every bundle
// that needs that command wait for the installer that carries it. To keep newer bundles running on older shells,
// add a new command (foo_v2) instead and keep the old one until no bundle needs it. A change inside a struct a
// command takes or returns is not seen here: treat such a struct as frozen, or give the command a new name.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type AbiEntry = { sig: string; v: string };
export type ShellAbi = Record<string, AbiEntry>;

/** Arguments Tauri supplies itself (never sent by the bundle). */
const INJECTED = /^(?:tauri::)?(?:AppHandle|Window|WebviewWindow|Webview|State)\b/;

/** The command paths in lib.rs's shell_commands! list (`module::name` or `name`). */
export function shellCommandPaths(lib: string): string[] {
  const start = lib.indexOf("shell_commands![");
  if (start < 0) throw new Error("lib.rs has no shell_commands! list");
  const body = lib.slice(start + "shell_commands![".length, lib.indexOf("];", start));
  return body.split(",").map((s) => s.replace(/\/\/.*$/gm, "").replace(/\s+/g, "")).filter(Boolean);
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if ("<([{".includes(ch)) depth++;
    else if (">)]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const norm = (t: string) => t.replace(/\s+/g, " ").replace(/\s*([<>(),&:])\s*/g, "$1").replace(/'_/g, "'_").trim();

/** Every `#[tauri::command]` fn in a Rust source: name -> signature (bundle-visible arguments and result). */
export function commandSignatures(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const attr = /#\[tauri::command(?:\([^)]*\))?\]/g;
  for (const m of src.matchAll(attr)) {
    const rest = src.slice(m.index! + m[0].length);
    const fn = /^(?:\s|\/\/[^\n]*\n|#\[[^\]]*\])*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-z_0-9]+)\s*(?:<[^>]*>)?\s*\(/.exec(rest);
    if (!fn) continue;
    let i = fn[0].length;
    let depth = 1;
    const open = i;
    while (i < rest.length && depth > 0) {
      const ch = rest[i]!;
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    const params = rest.slice(open, i - 1).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const tail = rest.slice(i);
    const ret = /^\s*(?:->\s*([^{]*?))?\s*(?:where\b[^{]*)?\{/.exec(tail);
    const args = splitTop(params)
      .map((p) => {
        const c = p.indexOf(":");
        return { name: p.slice(0, c).replace(/^mut\s+/, "").trim(), ty: norm(p.slice(c + 1)) };
      })
      .filter((a) => !INJECTED.test(a.ty));
    out.set(fn[1]!, `${fn[1]}(${args.map((a) => `${a.name}:${a.ty}`).join(",")})->${ret?.[1] ? norm(ret[1]) : "()"}`);
  }
  return out;
}

/** The shell's command set, read from the Rust source under `repo`. */
export function shellAbi(repo: string): ShellAbi {
  const dir = join(repo, "src-tauri", "src");
  const lib = readFileSync(join(dir, "lib.rs"), "utf8");
  const sigs = new Map<string, Map<string, string>>();
  const of = (module: string) => {
    if (!sigs.has(module)) sigs.set(module, commandSignatures(readFileSync(join(dir, `${module}.rs`), "utf8")));
    return sigs.get(module)!;
  };
  const abi: ShellAbi = {};
  for (const path of shellCommandPaths(lib)) {
    const parts = path.split("::");
    const name = parts.pop()!;
    const module = parts.length ? parts[parts.length - 1]! : "lib";
    const sig = of(module).get(name);
    if (!sig) throw new Error(`shell_commands! names ${path}, but no #[tauri::command] fn ${name} is in src-tauri/src/${module}.rs`);
    if (abi[name]) throw new Error(`two shell commands are named ${name}`);
    abi[name] = { sig, v: createHash("sha256").update(sig).digest("hex").slice(0, 8) };
  }
  return Object.fromEntries(Object.entries(abi).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export const abiText = (abi: ShellAbi) => JSON.stringify(abi, null, 1) + "\n";
export const ABI_FILE = join("src-tauri", "shell-abi.json");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repo = join(fileURLToPath(import.meta.url), "..", "..");
  writeFileSync(join(repo, ABI_FILE), abiText(shellAbi(repo)));
  console.log(`wrote ${ABI_FILE}`);
}
