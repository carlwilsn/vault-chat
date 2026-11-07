// Package the headless server for a GitHub release (ship.yml, job build_server).
//
// Input:  dist-server/vault-chat-server.mjs  (from `npm run build:server`)
//         src-tauri/assets/{phone.html, phone-sw.js, icon-apple-touch.png}
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
const assets = ["phone.html", "phone-sw.js", "icon-apple-touch.png"];

const fail = (msg) => {
  console.error(`build-server-release: ${msg}`);
  process.exit(1);
};
if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) fail(`VERSION must be x.y.z, got '${version}'`);
if (!/^[0-9a-f]{40}$/.test(rev)) fail(`REV must be a full git sha, got '${rev}'`);
if (!existsSync(bundle)) fail(`${bundle} is missing — run \`npm run build:server\` first`);
// Query the actual executable, not server-version.json or the build environment's intent.
// build-info uses the lazy bundle entry before app initialization: no listener, keys or voice.
const verifiedBundleSha = createHash("sha256").update(readFileSync(bundle)).digest("hex");
let compiled;
try {
  compiled = JSON.parse(execFileSync(process.execPath, [bundle, "build-info"], {
    encoding: "utf8", timeout: 15_000, maxBuffer: 4096,
    env: { PATH: process.env.PATH, VC_VOICE_PIPELINE: "0" },
  }));
} catch { fail("bundle build-info failed; refusing an unverified executable"); }
if (compiled.version !== version || compiled.rev !== rev) fail("compiled bundle identity does not match VERSION/REV");
if (createHash("sha256").update(readFileSync(bundle)).digest("hex") !== verifiedBundleSha) fail("bundle changed during executable identity verification");
for (const a of assets) if (!existsSync(join(assetDir, a))) fail(`${assetDir}/${a} is missing`);

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

copyFileSync(bundle, join(out, "vault-chat-server.mjs"));
const bundleSha = sha256(join(out, "vault-chat-server.mjs"));
if (bundleSha !== verifiedBundleSha) fail("bundle changed after executable identity verification");
writeFileSync(join(out, "vault-chat-server.mjs.sha256"), `${bundleSha}  vault-chat-server.mjs\n`);

// Application assets only. The one box acceptance script is installed separately from releases.
const stagedAssets = join(out, "asset-staging");
mkdirSync(stagedAssets, { recursive: true });
for (const a of assets) copyFileSync(join(assetDir, a), join(stagedAssets, a));

const packedAssets = [...assets];

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

// The Claude Code CLI the Agent SDK pins, so a box gets the matching one from the
// release it installs. A box unpacks a bundle and assets, never node_modules, so
// this file is the only way a fresh box has a Claude Code to run at all
// (the updater hands it to `install-claude-cli`; server/engine/claude/cliInstall.ts).
// Built where the platform package is installed — the CI runner and a dev box —
// and left out, loudly but not fatally, where it is not: a release without it
// still installs, and such a box falls back to a `claude` on PATH.
const cliPkg = `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const cliBin = join(cliPkg, "claude");
let claudeCli = null;
if (existsSync(cliBin)) {
  const cliTar = join(out, "vault-chat-claude-cli.tar.gz");
  // The quick setting, deliberately: this one asset is a 340 MB binary, and the
  // slow setting spends minutes to save ~8% of an already huge download — long
  // enough that it timed out the release test it runs inside.
  const fast = ["-I", "gzip -1"];
  try {
    execFileSync("tar", [...gnuFlags, ...fast, "-cf", cliTar, "-C", cliPkg, "claude"], { stdio: "inherit" });
  } catch {
    execFileSync("tar", [...fast, "-cf", cliTar, "-C", cliPkg, "claude"], { stdio: "inherit" });
  }
  const cliSha = sha256(cliTar);
  writeFileSync(`${cliTar}.sha256`, `${cliSha}  vault-chat-claude-cli.tar.gz\n`);
  // The version the CLI itself reports, not the package's: it is what the box runs.
  let cliVersion = "";
  try {
    cliVersion = String(execFileSync(cliBin, ["--version"], { encoding: "utf8", timeout: 30_000 })).trim();
  } catch {
    // A generic Linux binary that this machine cannot run directly (NixOS) still
    // ships: the box runs it through its own loader (findClaude).
    cliVersion = "";
  }
  claudeCli = { sha: cliSha, version: cliVersion.split(/\s+/)[0] || null };
} else {
  console.warn(`build-server-release: ${cliPkg} is not installed — the release will carry no Claude Code CLI`);
}

const meta = {
  version,
  rev,
  sha256: bundleSha,
  assetsSha256: assetsSha,
  deploySha256: deploySha,
  ...(claudeCli ? { claudeCliSha256: claudeCli.sha, ...(claudeCli.version ? { claudeCliVersion: claudeCli.version } : {}) } : {}),
  builtAt: new Date().toISOString(),
};
writeFileSync(join(out, "server-version.json"), JSON.stringify(meta, null, 2) + "\n");
console.log(`build-server-release: ${out}/ — v${version} (${rev.slice(0, 7)}), bundle ${bundleSha.slice(0, 12)}…`);
