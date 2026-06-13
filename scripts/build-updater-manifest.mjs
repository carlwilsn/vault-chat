// Build a COMPLETE Tauri updater manifest (latest.json) covering every platform,
// from the per-artifact `.sig` files attached to the release.
//
// Why this exists: the Windows and Linux build jobs each ran tauri-action with
// `includeUpdaterJson: true`, so each uploaded its OWN latest.json containing
// only the platforms it built. They race — last upload wins — so a release's
// manifest sometimes ended up missing a platform entirely. The app's in-app
// updater on the dropped platform then failed every check ("None of the
// fallback platforms were found in the response"), which is why the box kept
// missing shipped builds. Now the build jobs skip the manifest and this script
// assembles a single complete one from all the signatures.
//
// Run in CI after BOTH builds, with the release's `*.sig` files downloaded into
// `sigs/`. Env: VERSION (e.g. 0.4.30), NOTES (release body), GITHUB_REPOSITORY.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.VERSION;
const notes = process.env.NOTES ?? "";
const repo = process.env.GITHUB_REPOSITORY; // "owner/repo"
if (!version || !repo) {
  console.error("VERSION and GITHUB_REPOSITORY are required");
  process.exit(1);
}
const base = `https://github.com/${repo}/releases/download/v${version}`;

// Updater platform key -> the installer file it points at (its signature lives
// in `<file>.sig`). These six keys mirror exactly what tauri-action emits, so
// the updater resolves the same entries it always has — just never missing one.
const targets = {
  "windows-x86_64": `vault-chat_${version}_x64-setup.exe`,
  "windows-x86_64-nsis": `vault-chat_${version}_x64-setup.exe`,
  "windows-x86_64-msi": `vault-chat_${version}_x64_en-US.msi`,
  "linux-x86_64": `vault-chat_${version}_amd64.AppImage`,
  "linux-x86_64-appimage": `vault-chat_${version}_amd64.AppImage`,
  "linux-x86_64-deb": `vault-chat_${version}_amd64.deb`,
};

const platforms = {};
for (const [key, file] of Object.entries(targets)) {
  let sig;
  try {
    sig = readFileSync(`sigs/${file}.sig`, "utf8").trim();
  } catch {
    console.warn(`! no signature for ${key} (${file}.sig)`);
    continue;
  }
  platforms[key] = { signature: sig, url: `${base}/${file}` };
}

// Refuse to publish a manifest that would silently break a platform's updater.
// Both OSes must be present — if a build genuinely failed, fail the ship loudly
// rather than shipping a half-manifest (which is the very bug we're fixing).
const haveWindows = Object.keys(platforms).some((k) => k.startsWith("windows-"));
const haveLinux = Object.keys(platforms).some((k) => k.startsWith("linux-"));
if (!haveWindows || !haveLinux) {
  console.error(
    `incomplete manifest — windows:${haveWindows} linux:${haveLinux}. ` +
      `Found: ${Object.keys(platforms).join(", ") || "(none)"}. Refusing to publish.`,
  );
  process.exit(1);
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync("latest.json", JSON.stringify(manifest, null, 2));
console.log(`wrote latest.json — platforms: ${Object.keys(platforms).join(", ")}`);
