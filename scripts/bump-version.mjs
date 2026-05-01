// Bump the patch version in package.json, src-tauri/tauri.conf.json,
// and src-tauri/Cargo.toml — keeping them in sync. Prints the new
// version on stdout so the calling workflow can read it.
//
// Run from the repo root:  node scripts/bump-version.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function bumpJson(path) {
  const src = readFileSync(path, "utf8");
  const obj = JSON.parse(src);
  const [maj, min, pat] = obj.version.split(".").map(Number);
  if ([maj, min, pat].some((n) => Number.isNaN(n))) {
    throw new Error(`${path}: cannot parse version "${obj.version}"`);
  }
  const next = `${maj}.${min}.${pat + 1}`;
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
