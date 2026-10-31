// Bump the version in package.json, src-tauri/tauri.conf.json, and
// src-tauri/Cargo.toml — keeping them in sync. Prints the new version on
// stdout so the calling workflow can read it.
//
// Rollover: this is a patch increment, but each component caps at 99 and
// carries into the next — so patch 99 rolls the minor (0.2.99 -> 0.3.0)
// and minor 99 rolls the major (0.99.99 -> 1.0.0). Keeps versions
// two-digit-clean instead of climbing into three-digit patch land.
//
// Run from the repo root:  node scripts/bump-version.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
// Already present in the locked build toolchain; use semver, not string ordering.
const semver = createRequire(import.meta.url)("semver");

const root = process.cwd();

function nextVersion(version) {
  const [maj, min, pat] = version.split(".").map(Number);
  if ([maj, min, pat].some((n) => Number.isNaN(n))) {
    throw new Error(`cannot parse version "${version}"`);
  }
  let nMaj = maj;
  let nMin = min;
  let nPat = pat + 1;
  if (nPat > 99) {
    nPat = 0;
    nMin += 1;
  }
  if (nMin > 99) {
    nMin = 0;
    nMaj += 1;
  }
  return `${nMaj}.${nMin}.${nPat}`;
}

// Select above ALL fetched release tags, including prereleases and tags whose
// build child is not on main. An exact source revert may restore an old version.
const paths = [join(root, "package.json"), join(root, "src-tauri", "tauri.conf.json")];
const sources = paths.map(path => readFileSync(path, "utf8"));
const versions = sources.map(src => JSON.parse(src).version);
const cargoPath = join(root, "src-tauri", "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const cargoMatch = /^(version\s*=\s*)"([^"]+)"/m.exec(cargo);
if (!cargoMatch || versions.some(v => !semver.valid(v) || v !== versions[0]) || cargoMatch[2] !== versions[0]) {
  throw new Error("package.json, tauri.conf.json and Cargo.toml must have the same valid version");
}
const tags = execFileSync("git", ["tag", "--list", "v*"], { cwd: root, encoding: "utf8" }).trim().split("\n");
let highest = versions[0];
for (const tag of tags) {
  const version = semver.valid(tag.slice(1));
  if (version && semver.gt(version, highest)) highest = version;
}
const next = nextVersion(`${semver.major(highest)}.${semver.minor(highest)}.${semver.patch(highest)}`);
if (!semver.gt(next, highest)) throw new Error("Release version must advance past every fetched tag");
// Validate everything before writing; replace only version lines, never reformat
// a frozen product source file or change non-version metadata.
for (let i = 0; i < paths.length; i++) {
  const updated = sources[i].replace(/^(\s*"version"\s*:\s*)"[^"]+"/m, `$1"${next}"`);
  if (updated === sources[i] || JSON.parse(updated).version !== next) throw new Error("Missing top-level version line");
}
for (let i = 0; i < paths.length; i++) writeFileSync(paths[i], sources[i].replace(/^(\s*"version"\s*:\s*)"[^"]+"/m, `$1"${next}"`));
writeFileSync(cargoPath, cargo.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${next}"`));
console.log(next);
