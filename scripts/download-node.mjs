// Downloads the Node runtime the app runs its own server with, into
// src-tauri/binaries/ so the bundle ships it.
//
// Why: with no box, the desktop app runs the vault-chat server itself
// (src-tauri/src/local_server.rs). That server is a Node bundle, and a fresh
// Windows or Linux machine has no Node — so without this the app can only say
// "connect a box instead", which is the one thing Carl should not have to do.
//
// Runs on Windows (x64) and Linux (x64), from the Tauri prebuild hook, like
// download-tectonic.mjs beside it. No-op when the right version is already here.
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// The version the box runs, so the app's own server runs on what it is tested on.
const NODE_VERSION = "22.23.2";

const IS_WINDOWS = process.platform === "win32";
const ARCHIVE = IS_WINDOWS ? `node-v${NODE_VERSION}-win-x64.zip` : `node-v${NODE_VERSION}-linux-x64.tar.xz`;
const BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;
const BIN_NAME = IS_WINDOWS ? "node.exe" : "node";
// Where it sits inside the archive.
const INNER = IS_WINDOWS ? `node-v${NODE_VERSION}-win-x64/node.exe` : `node-v${NODE_VERSION}-linux-x64/bin/node`;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = resolve(repoRoot, "src-tauri", "binaries");
const outBin = resolve(outDir, BIN_NAME);
const versionFile = resolve(outDir, "NODE_VERSION");

async function downloadTo(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  await new Promise((done, reject) => {
    const stream = createWriteStream(dest);
    res.body
      .pipeTo(new WritableStream({
        write(chunk) { stream.write(chunk); },
        close() { stream.end(done); },
        abort(err) { stream.destroy(); reject(err); },
      }))
      .catch(reject);
  });
}

/** The published sha256 for `name`, from the release's own SHASUMS256.txt. */
async function publishedSha(name) {
  const res = await fetch(`${BASE}/SHASUMS256.txt`, { redirect: "follow" });
  if (!res.ok) throw new Error(`SHASUMS256.txt: HTTP ${res.status}`);
  const line = (await res.text()).split("\n").find((l) => l.trim().endsWith(` ${name}`) || l.trim().endsWith(`  ${name}`));
  if (!line) throw new Error(`${name} is not in SHASUMS256.txt for v${NODE_VERSION}`);
  return line.trim().split(/\s+/)[0];
}

function extract(archivePath, into) {
  if (IS_WINDOWS) {
    const r = spawnSync("powershell", ["-NoProfile", "-Command",
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${into}' -Force`], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`Expand-Archive failed for ${archivePath}`);
  } else {
    // -J: the Linux build ships as .tar.xz; tar on every CI runner reads it.
    const r = spawnSync("tar", ["xJf", archivePath, "-C", into], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tar xJf failed for ${archivePath}`);
  }
}

async function main() {
  if (existsSync(outBin) && existsSync(versionFile) && readFileSync(versionFile, "utf8").trim() === NODE_VERSION) {
    console.log(`node ${NODE_VERSION} already present at ${outBin}`);
    return;
  }
  await mkdir(outDir, { recursive: true });
  const archivePath = resolve(outDir, ARCHIVE);
  console.log(`downloading ${BASE}/${ARCHIVE}`);
  await downloadTo(`${BASE}/${ARCHIVE}`, archivePath);

  // Against Node's own published sum: a truncated or swapped download must not
  // become the runtime every no-box turn runs on.
  const want = await publishedSha(ARCHIVE);
  const got = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (got !== want) throw new Error(`sha256 mismatch for ${ARCHIVE}: ${got} is not the published ${want}`);
  console.log(`sha256 ${got} (as published)`);

  const extractDir = resolve(outDir, "_node_extract");
  await rm(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  extract(archivePath, extractDir);

  const inner = resolve(extractDir, INNER);
  if (!existsSync(inner)) throw new Error(`no ${INNER} in the archive`);
  writeFileSync(outBin, readFileSync(inner));
  if (!IS_WINDOWS) chmodSync(outBin, 0o755);
  writeFileSync(versionFile, NODE_VERSION + "\n");
  await rm(extractDir, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  console.log(`node ${NODE_VERSION} installed at ${outBin}`);
}

main().catch((err) => {
  console.error("download-node failed:", err);
  process.exit(1);
});
