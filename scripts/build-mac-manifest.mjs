// The Mac update manifest of ONE release (mac-update.json), written by ship.yml's mac_publish only after build_macos
// passed every check and the .app.tar.gz was signed. It is a complete Tauri static manifest, but no updater reads it
// where it lies: the Mac app reads latest-mac.json on the mac-stable release, which mac-promote.yml copies from a
// release's mac-update.json when the box promotes it (server/macFriend.ts). Its presence on a release = "Mac passed".
//
// Env: VERSION, NOTES, GITHUB_REPOSITORY, DIR (holding vault-chat_<v>_<arch>.app.tar.gz + .sig and arch.txt).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.env.VERSION;
const repo = process.env.GITHUB_REPOSITORY;
const dir = process.env.DIR ?? "mac-update";
if (!version || !repo) {
  console.error("VERSION and GITHUB_REPOSITORY are required");
  process.exit(1);
}
const arch = readFileSync(join(dir, "arch.txt"), "utf8").trim();
if (arch !== "aarch64" && arch !== "x64") {
  console.error(`unknown arch "${arch}"`);
  process.exit(1);
}
const file = `vault-chat_${version}_${arch}.app.tar.gz`;
let signature;
try {
  signature = readFileSync(join(dir, `${file}.sig`), "utf8").trim();
} catch {
  console.error(`no signature for ${file}: refusing to write a Mac manifest`);
  process.exit(1);
}
if (!signature) {
  console.error(`empty signature for ${file}`);
  process.exit(1);
}
const key = `darwin-${arch === "x64" ? "x86_64" : "aarch64"}`;
const entry = { signature, url: `https://github.com/${repo}/releases/download/v${version}/${file}` };
const manifest = { version, notes: process.env.NOTES ?? "", pub_date: new Date().toISOString(), platforms: { [key]: entry, [`${key}-app`]: entry } };
writeFileSync(join(dir, "mac-update.json"), JSON.stringify(manifest, null, 2));
console.log(`wrote ${join(dir, "mac-update.json")}: ${Object.keys(manifest.platforms).join(", ")} -> ${file}`);
