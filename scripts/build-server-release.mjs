// Package the headless server for a GitHub release (ship.yml, job build_server).
//
// Input:  dist-server/vault-chat-server.mjs  (from `npm run build:server`)
//         src-tauri/assets/{phone.html, phone-sw.js, icon-apple-touch.png, voice.html}
// Env:    VERSION (e.g. 0.6.33), REV (git sha). Optional OUT_DIR (default release-server).
// Output in OUT_DIR — exactly what server/deploy/vault-chat-update.sh downloads:
//   vault-chat-server.mjs                     the bundle
//   vault-chat-server.mjs.sha256              "<hex>  vault-chat-server.mjs"
//   vault-chat-server-assets.tar.gz           the phone/PWA files (the updater unpacks
//   vault-chat-server-assets.tar.gz.sha256      them into <version dir>/assets/)
//   vault-chat-deploy.tar.gz                  the updater and the systemd units (server/deploy/:
//   vault-chat-deploy.tar.gz.sha256             the updater reinstalls itself from them)
//   server-version.json                       {version, rev, sha256, assetsSha256, deploySha256, builtAt}
//
// The phone assets ship even if the bundle inlines them; the server may ignore them.
// Fails loudly on a missing input: a release without its server is not a release.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = (process.env.VERSION || "").replace(/^v/, "");
const rev = process.env.REV || "";
const out = process.env.OUT_DIR || "release-server";
const bundle = "dist-server/vault-chat-server.mjs";
const assetDir = "src-tauri/assets";
const assets = ["phone.html", "phone-sw.js", "icon-apple-touch.png", "voice.html"];

const fail = (msg) => {
  console.error(`build-server-release: ${msg}`);
  process.exit(1);
};
if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) fail(`VERSION must be x.y.z, got '${version}'`);
if (!/^[0-9a-f]{7,40}$/.test(rev)) fail(`REV must be a git sha, got '${rev}'`);
if (!existsSync(bundle)) fail(`${bundle} is missing — run \`npm run build:server\` first`);
for (const a of assets) if (!existsSync(join(assetDir, a))) fail(`${assetDir}/${a} is missing`);

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

copyFileSync(bundle, join(out, "vault-chat-server.mjs"));
const bundleSha = sha256(join(out, "vault-chat-server.mjs"));
writeFileSync(join(out, "vault-chat-server.mjs.sha256"), `${bundleSha}  vault-chat-server.mjs\n`);

// Proof needs dev tools after a bundle-only update. Ship exact manifests in the SAME checksummed
// asset tarball; the installed host provisions public integrity-checked npm packages without hooks/keys.
const stagedAssets = join(out, "asset-staging");
mkdirSync(join(stagedAssets, "proof"), { recursive: true });
for (const a of assets) copyFileSync(join(assetDir, a), join(stagedAssets, a));
for (const a of ["package.json", "package-lock.json"]) copyFileSync(a, join(stagedAssets, "proof", a));
const packedAssets = [...assets, "proof"];

// Reproducible-ish tarball: fixed order, owner and mtime (GNU tar on the CI runner).
const tarball = join(out, "vault-chat-server-assets.tar.gz");
const gnuFlags = ["--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mtime=@0"];
try {
  execFileSync("tar", [...gnuFlags, "-czf", tarball, "-C", stagedAssets, ...packedAssets], { stdio: "inherit" });
} catch {
  // Non-GNU tar (e.g. a dev machine): same contents, just not byte-reproducible.
  execFileSync("tar", ["-czf", tarball, "-C", stagedAssets, ...packedAssets], { stdio: "inherit" });
}
rmSync(stagedAssets, { recursive: true, force: true });
const assetsSha = sha256(tarball);
writeFileSync(`${tarball}.sha256`, `${assetsSha}  vault-chat-server-assets.tar.gz\n`);

// The updater and its units, as install.sh installs them: the updater refreshes itself from these.
const deployDir = "server/deploy";
const deployFiles = ["vault-chat-update.sh", "vault-chat-server.service", "vault-chat-update.service", "vault-chat-update.timer"];
for (const f of deployFiles) if (!existsSync(join(deployDir, f))) fail(`${deployDir}/${f} is missing`);
const deployTar = join(out, "vault-chat-deploy.tar.gz");
try {
  execFileSync("tar", [...gnuFlags, "-czf", deployTar, "-C", deployDir, ...deployFiles], { stdio: "inherit" });
} catch {
  execFileSync("tar", ["-czf", deployTar, "-C", deployDir, ...deployFiles], { stdio: "inherit" });
}
const deploySha = sha256(deployTar);
writeFileSync(`${deployTar}.sha256`, `${deploySha}  vault-chat-deploy.tar.gz\n`);

const meta = {
  version,
  rev,
  sha256: bundleSha,
  assetsSha256: assetsSha,
  deploySha256: deploySha,
  builtAt: new Date().toISOString(),
};
writeFileSync(join(out, "server-version.json"), JSON.stringify(meta, null, 2) + "\n");
console.log(`build-server-release: ${out}/ — v${version} (${rev.slice(0, 7)}), bundle ${bundleSha.slice(0, 12)}…`);
