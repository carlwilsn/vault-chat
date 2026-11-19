// Promote one release to the Mac friend channel: check its mac-update.json and write latest-mac.json (the manifest the
// Mac app's updater reads, on the mac-stable release). Run by .github/workflows/mac-promote.yml when the box pushes the
// tag mac-friend-v<version> (server/macFriend.ts decides; the workflow re-checks what GitHub can see).
//
//   node scripts/mac-promote.mjs <version> <candidate mac-update.json> [<current latest-mac.json>]  -> ./latest-mac.json
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const num = (v) => String(v).replace(/^v/, "").split(".").map((x) => Number(x) || 0);
export function cmpVersion(a, b) {
  const pa = num(a), pb = num(b);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** The friend manifest for `version`, or a refusal (a string). */
export function promoteManifest(version, candidate, current, repo) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return `bad version "${version}"`;
  if (!candidate || typeof candidate !== "object") return `v${version} has no mac-update.json: its Mac checks did not pass`;
  if (candidate.version !== version) return `mac-update.json says v${candidate.version}, the tag v${version}`;
  const platforms = Object.entries(candidate.platforms ?? {});
  if (!platforms.length) return "mac-update.json names no platform";
  for (const [key, p] of platforms) {
    if (!key.startsWith("darwin-")) return `mac-update.json names ${key}: only darwin entries belong in the Mac manifest`;
    if (!p?.signature) return `${key} has no signature`;
    if (!String(p.url ?? "").startsWith(`https://github.com/${repo}/releases/download/v${version}/`)) return `${key} points outside the v${version} release: ${p.url}`;
  }
  if (current?.version && cmpVersion(version, current.version) <= 0) return `the friend is already on v${current.version}: never the same or older`;
  return { ...candidate, pub_date: new Date().toISOString() };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [version, candPath, curPath] = process.argv.slice(2);
  const readJson = (p) => {
    try {
      return p ? JSON.parse(readFileSync(p, "utf8")) : null;
    } catch {
      return null;
    }
  };
  const out = promoteManifest(version ?? "", readJson(candPath), readJson(curPath), process.env.GITHUB_REPOSITORY ?? "");
  if (typeof out === "string") {
    console.error(`refused: ${out}`);
    process.exit(1);
  }
  writeFileSync("latest-mac.json", JSON.stringify(out, null, 2));
  console.log(`latest-mac.json -> v${out.version}`);
}
