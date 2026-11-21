// Build an app plugin's live copy (src/appPluginLive.ts): its folder under src/plugins bundled on its own, with what it
// shares with the running app (React, the app's modules outside the folder, the folder's state files) left out and taken
// from the app at load by name. No app build, no release: the app picks the file up from the vault within seconds.
//
//   node --import tsx scripts/app-plugin-live.ts <name> --vault <vault> [--draft --what "<one line>"]   build and write the copy (a draft)
//   node --import tsx scripts/app-plugin-live.ts <name> --vault <vault> --keep      the draft becomes the live copy
//   node --import tsx scripts/app-plugin-live.ts <name> --vault <vault> --discard   the draft is dropped
//   node --import tsx scripts/app-plugin-live.ts <name> --vault <vault> --back      live and the copy the last keep replaced swap
//   node --import tsx scripts/app-plugin-live.ts <name> --vault <vault> --remove    the live copy is dropped (built-in runs)
//
// A draft runs nowhere by itself: the gate (Plugins submit, scripts/gate.ts) keeps or discards it (records on the box,
// which moves the files: server/pluginDrafts.ts). Check it first in a hidden copy: scripts/draft-check.ts.
// --keep / --discard / --back here write the same plugin.change record the gate does, through the box
// (scripts/boxChange.ts; [--reason <line>] [--box <url>]): the box moves the files, never this script.
//   node --import tsx scripts/app-plugin-live.ts --shared                           every shared name, by plugin (JSON)
//
// <name> is the plugin's folder (filetree, chats, vaults, composer, titlebar, notes, chat-rows, viewer, chat, settings, voice, context) or its id.
import { build, type Plugin } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_PLUGIN_LIVE_DIR,
  LIVE_APP_PLUGINS,
  LIVE_SHARED_GLOBAL,
  LIVE_SHARED_PACKAGES,
  appPluginFolder,
  liveCopyFile,
  liveErrorFile,
  liveHeaderLine,
  liveStateFiles,
} from "../src/appPluginLive.ts";
import { versionOf } from "../src/pluginDrafts.ts";
import { postBoxChange } from "./boxChange.ts";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Whether a package import is taken from the app (React, Tauri's bridge) rather than bundled. */
export const sharedPackage = (spec: string): boolean => LIVE_SHARED_PACKAGES.includes(spec) || spec.startsWith("@tauri-apps/");

/** The module that reads a shared name from the app at load (CommonJS, so named imports stay live bindings). */
function shim(key: string): string {
  const k = JSON.stringify(key);
  return `var all = globalThis[${JSON.stringify(LIVE_SHARED_GLOBAL)}] || {};
var m = all[${k}];
if (!m) throw new Error("this app does not share " + ${k} + " (the live copy was built from newer code): the built-in copy runs");
var o = { __esModule: true };
Object.keys(m).forEach(function (k) { if (k !== "__esModule") Object.defineProperty(o, k, { enumerable: true, get: function () { return m[k]; } }); });
module.exports = o;
`;
}

/** Bundle the plugin in src/plugins/<folder>: its code (header line first) and the shared names it takes from the app. */
export async function buildLiveCopy(folder: string, opts: { root?: string; built?: string; what?: string } = {}): Promise<{ code: string; shared: string[] }> {
  const root = opts.root ?? REPO;
  const plugin = `app/${folder}`;
  if (!appPluginFolder(plugin)) throw new Error(`${folder} is not an app plugin with a live copy (${LIVE_APP_PLUGINS.join(", ")})`);
  const src = join(root, "src");
  const dir = join(src, "plugins", folder);
  const entry = ["index.tsx", "index.ts"].map((f) => join(dir, f)).find((f) => existsSync(f));
  if (!entry) throw new Error(`no index.tsx or index.ts in ${relative(root, dir)}`);
  const shared = new Set<string>();
  const stateFiles = liveStateFiles(plugin);
  const share: Plugin = {
    name: "vc-app-shared",
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (a) => {
        if (a.pluginData?.vcInner || a.namespace === "vc-shared") return undefined;
        if (sharedPackage(a.path)) return { path: a.path, namespace: "vc-shared" };
        // Another package, or a file inside one: bundled, as the package says (its sideEffects: false keeps it small).
        if (!a.path.startsWith(".") || a.importer.includes(`${sep}node_modules${sep}`)) return undefined;
        const r = await b.resolve(a.path, { kind: a.kind, resolveDir: a.resolveDir, importer: a.importer, pluginData: { vcInner: true } });
        if (r.errors.length) return { errors: r.errors };
        const p = r.path;
        if (!p.startsWith(src + sep)) return { path: p, sideEffects: r.sideEffects };
        const own = p.startsWith(dir + sep);
        const state = dirname(p) === dir && stateFiles.includes(basename(p).replace(/\.[^.]+$/, ""));
        if (own && !state) return { path: p, sideEffects: r.sideEffects }; // the plugin's own code: what a live copy changes
        return { path: "src/" + relative(src, p).split(sep).join("/").replace(/\.(tsx?|jsx?|mjs)$/, ""), namespace: "vc-shared" };
      });
      b.onLoad({ filter: /.*/, namespace: "vc-shared" }, (a) => {
        shared.add(a.path);
        return { contents: shim(a.path), loader: "js" };
      });
    },
  };
  const out = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    charset: "utf8",
    legalComments: "none",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [share],
  });
  const list = [...shared].sort();
  const header = liveHeaderLine({ plugin, shared: list, ...(opts.built ? { built: opts.built } : {}), ...(opts.what ? { what: opts.what.trim().slice(0, 160) } : {}) });
  return { code: `${header}\n${out.outputFiles[0]!.text}`, shared: list };
}

function revision(root: string): string {
  try {
    const rev = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "src"], { cwd: root, encoding: "utf8" }).trim() ? "+edits" : "";
    return `${rev}${dirty} ${new Date().toISOString()}`;
  } catch {
    return new Date().toISOString();
  }
}

async function main(argv: string[]): Promise<void> {
  const flag = (f: string) => argv.includes(f);
  const value = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (flag("--shared")) {
    const all: Record<string, string[]> = {};
    for (const id of LIVE_APP_PLUGINS) all[id] = (await buildLiveCopy(appPluginFolder(id)!)).shared;
    console.log(JSON.stringify(all, null, 2));
    return;
  }
  const name = argv.find((a, i) => !a.startsWith("--") && !["--vault", "--what", "--box", "--reason"].includes(argv[i - 1] ?? ""));
  const vault = value("--vault");
  if (!name || !vault) throw new Error("usage: app-plugin-live.ts <name> --vault <vault> [--draft [--what <line>] | --keep | --discard | --back | --remove]");
  const folder = name.replace(/^app\//, "");
  if (!appPluginFolder(`app/${folder}`)) throw new Error(`${name} is not an app plugin with a live copy (${LIVE_APP_PLUGINS.join(", ")})`);
  const dir = join(vault, APP_PLUGIN_LIVE_DIR);
  const live = join(dir, liveCopyFile(folder, "live"));
  const draft = join(dir, liveCopyFile(folder, "draft"));
  const drop = (f: string) => {
    rmSync(f, { force: true });
    rmSync(join(dir, liveErrorFile(basename(f))), { force: true });
  };
  // Keep / Discard / Switch back: the record the gate writes, through the box (it moves the files).
  const land = async (change: "keep" | "discard" | "switch") => {
    const version = change !== "switch" && existsSync(draft) ? versionOf(readFileSync(draft, "utf8")) : "";
    if (change !== "switch" && !version) throw new Error(`no draft: ${relative(vault, draft)}`);
    const r = await postBoxChange(vault, { plugin: `app/${folder}`, change, ...(version ? { version } : {}), ...(value("--reason") ? { reason: value("--reason") } : {}) }, value("--box"));
    console.log(`${r.text} (record ${r.seq})`);
  };
  if (flag("--keep")) return land("keep");
  if (flag("--discard")) return land("discard");
  if (flag("--back")) return land("switch");
  if (flag("--remove")) {
    drop(live);
    console.log(`removed the live copy of app/${folder}: the built-in copy runs${existsSync(draft) ? " (a draft is still there)" : ""}`);
    return;
  }
  const { code, shared } = await buildLiveCopy(folder, { built: revision(REPO), what: value("--what") });
  const to = flag("--draft") ? draft : live;
  mkdirSync(dir, { recursive: true });
  drop(to);
  writeFileSync(to, code);
  console.log(`wrote ${relative(vault, to)} (${Math.round(code.length / 1024)} KB; takes ${shared.length} modules from the app; version ${versionOf(code)})${flag("--draft") ? "\nPlugins submit lands it through the gate; check it first: node --import tsx scripts/draft-check.ts " + folder + " --vault " + vault : ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
