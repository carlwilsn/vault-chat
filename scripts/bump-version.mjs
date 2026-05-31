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

function bumpJson(path) {
  const src = readFileSync(path, "utf8");
  const obj = JSON.parse(src);
  const next = nextVersion(obj.version);
  obj.version = next;
  const trailingNl = src.endsWith("\n") ? "\n" : "";
  writeFileSync(path, JSON.stringify(obj, null, 2) + trailingNl);
  return next;
}

const pkgVer = bumpJson(join(root, "package.json"));
const tauriVer = bumpJson(join(root, "src-tauri", "tauri.conf.json"));

if (pkgVer !== tauriVer) {
  throw new Error(
    `Version mismatch after bump: package.json=${pkgVer} tauri.conf.json=${tauriVer}`,
  );
}

const cargoPath = join(root, "src-tauri", "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const updated = cargo.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${pkgVer}"`);
if (updated === cargo) {
  throw new Error(`Failed to find a 'version = "..."' line in ${cargoPath}`);
}
writeFileSync(cargoPath, updated);

console.log(pkgVer);
