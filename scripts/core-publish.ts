// Build one core bundle (src/coreBundle.ts) on the box: run by server/coreBundles.ts as a job, from a snapshot of the
// commit it builds (its cwd), never inside a vault.
//
//   node --import tsx scripts/core-publish.ts --repo <repo> --commit <sha> --root <state>/core-bundles --work <dir>
//
// vite build of the snapshot (the commit's revision compiled in), the needs scanned from its source, the files and the
// manifest stored under <root>/<version>/, then <work>/result.json: {ok, version, sha256, commit} or {ok: false, error}.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_BOX_API, CORE_SCHEMA, coreVersionOf, manifestProblem, manifestText, safeCorePath, scanNeeds, type CoreManifest, type CoreNeeds } from "../src/coreBundle.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

/** The needs of the source tree at `root`: its src/ files (tests left out), and this commit's box API. */
export function needsOf(root: string, boxApi = CORE_BOX_API): CoreNeeds {
  const files = walk(join(root, "src")).filter((p) => /\.(tsx?|jsx?|mjs)$/.test(p) && !/\.test\./.test(p));
  const scanned = scanNeeds(files.map((p) => readFileSync(join(root, "src", p), "utf8")));
  // Each needed command's signature version, from the commit's own shell-abi.json (absent before it existed).
  const abiFile = join(root, "src-tauri", "shell-abi.json");
  const shell: Record<string, { v: string }> = existsSync(abiFile) ? JSON.parse(readFileSync(abiFile, "utf8")) : {};
  const abi = Object.fromEntries(scanned.commands.filter((c) => shell[c]).map((c) => [c, shell[c]!.v]));
  return { ...scanned, boxApi, ...(Object.keys(abi).length ? { abi } : {}) };
}

/**
 * Store a built dist as a bundle under `root`: <version>/files/* and <version>/manifest.json, written beside and renamed
 * into place (a reader never sees half a bundle). Returns its version and the manifest's sha256. The same bytes twice:
 * the same version, stored once.
 */
export function storeCore(root: string, dist: string, meta: { commit: string; commitTime: number; needs: CoreNeeds; builtAt?: string }): { version: string; sha256: string; manifest: CoreManifest } {
  const paths = walk(dist).filter((p) => !p.endsWith(".map")).sort();
  const bad = paths.find((p) => !safeCorePath(p));
  if (bad) throw new Error(`a built file with a name a bundle cannot carry: ${bad}`);
  const files = paths.map((p) => {
    const b = readFileSync(join(dist, p));
    return { path: p, sha256: sha(b), size: b.length };
  });
  const manifest: CoreManifest = { schema: CORE_SCHEMA, commit: meta.commit, commitTime: meta.commitTime, builtAt: meta.builtAt ?? new Date().toISOString(), needs: meta.needs, files };
  const problem = manifestProblem(manifest);
  if (problem) throw new Error(`the manifest is not valid: ${problem}`);
  const text = manifestText(manifest);
  const hash = sha(text);
  const version = coreVersionOf(hash);
  const final = join(root, version);
  if (existsSync(join(final, "manifest.json"))) return { version, sha256: hash, manifest };
  const tmp = join(root, `.${version}.${process.pid}.tmp`);
  rmSync(tmp, { recursive: true, force: true });
  for (const f of files) {
    const to = join(tmp, "files", f.path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(dist, f.path), to);
  }
  writeFileSync(join(tmp, "manifest.json"), text);
  rmSync(final, { recursive: true, force: true });
  renameSync(tmp, final);
  return { version, sha256: hash, manifest };
}

/**
 * The version a box-built core reports (vite's __APP_VERSION__): package.json on main never moves (CI bumps the version
 * only on each release tag's own version-only child, off main), so a core built from raw main said "0.7.25". Instead:
 * the newest stable release whose code it contains (the tag's parent, the main commit that release was built from, is
 * an ancestor of `commit`), plus "+core.<commit>": "0.9.49+core.6d84f139". No such tag in the repo: "0.0.0+core.<commit>".
 */
export function coreAppVersion(repo: string, commit: string): string {
  const git = (args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const tags = (git(["tag", "--list", "v*", "--sort=-version:refname"]).stdout ?? "").split("\n").filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).slice(0, 30);
  const base = tags.find((t) => git(["merge-base", "--is-ancestor", `${t}^`, commit]).status === 0 || git(["merge-base", "--is-ancestor", t, commit]).status === 0);
  return `${base ? base.slice(1) : "0.0.0"}+core.${commit.slice(0, 8)}`;
}

function arg(argv: string[], k: string): string {
  const i = argv.indexOf(k);
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (!v) throw new Error(`${k} is required`);
  return v;
}

/** Where a stored bundle's boot check is written (beside its manifest; not one of its files). */
export const BOOT_FILE = "boot.json";

/**
 * The one gate's boot of a built bundle (src/gateResult.ts, frontend-core): the stored files booted in the preview
 * harness in place of the source of the same commit (scripts/draft-check.ts, core mode: ?core=1, the synthetic vault, no
 * scenario steps), side by side with that source: it must come up (its plugins mount) with no errors the source does
 * not have. Never throws: a check that cannot run says so ({verdict: null, error}).
 */
export async function bootCheck(root: string, version: string, src: string): Promise<{ verdict: "pass" | "borderline" | "fail" | null; reasons: string[]; at: number; error?: string }> {
  try {
    const { draftCheck } = await import("./draft-check.ts");
    const v = await draftCheck({ plugin: "app/core", vault: src, synthetic: true, runs: 1, keys: 0, core: { files: join(root, version, "files"), version } });
    return { verdict: v.verdict, reasons: v.reasons, at: Date.now() };
  } catch (e) {
    return { verdict: null, reasons: [], at: Date.now(), error: String((e as Error)?.message ?? e).slice(0, 400) };
  }
}

async function main(argv: string[]): Promise<void> {
  const repo = arg(argv, "--repo");
  const commit = arg(argv, "--commit");
  const root = resolve(arg(argv, "--root"));
  const work = resolve(arg(argv, "--work"));
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("--commit: a full commit hash");
  const src = process.cwd();
  // The repo's node_modules serve the build when the lockfile is the same; else this snapshot gets its own.
  if (readFileSync(join(src, "package-lock.json"), "utf8") !== readFileSync(join(repo, "package-lock.json"), "utf8")) {
    rmSync(join(src, "node_modules"), { force: true, recursive: true });
    execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: src, stdio: "inherit" });
  }
  const dist = join(work, "dist");
  const r = spawnSync(process.execPath, [join(src, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", dist, "--emptyOutDir"], {
    cwd: src,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096", VC_APP_REVISION: commit, VC_APP_VERSION: coreAppVersion(repo, commit) },
  });
  if (r.status !== 0) throw new Error(`vite build failed (exit ${r.status})`);
  const commitTime = Number(execFileSync("git", ["-C", repo, "log", "-1", "--format=%ct", commit], { encoding: "utf8" }).trim());
  // The box API this commit's own source says it needs (not this script's copy: they are the same file here).
  const out = storeCore(root, dist, { commit, commitTime, needs: needsOf(src) });
  rmSync(dist, { recursive: true, force: true });
  // The gate's boot of the stored bundle (server/coreBundles.ts judgeCore reads it): before the build counts as done.
  writeFileSync(join(root, out.version, BOOT_FILE), JSON.stringify(await bootCheck(root, out.version, src)) + "\n");
  writeFileSync(join(work, "result.json"), JSON.stringify({ ok: true, version: out.version, sha256: out.sha256, commit, needs: out.manifest.needs }) + "\n");
  console.log(`stored core ${out.version} (${out.manifest.files.length} files) from ${commit.slice(0, 12)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  main(argv).catch((e) => {
    console.error(String(e?.message ?? e));
    try {
      writeFileSync(join(resolve(arg(argv, "--work")), "result.json"), JSON.stringify({ ok: false, error: String(e?.message ?? e).slice(0, 400) }) + "\n");
    } catch {
      /* no work folder named */
    }
    process.exit(1);
  });
}
