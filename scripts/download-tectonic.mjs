// Downloads the Tectonic LaTeX engine binary into src-tauri/binaries/ so the
// Tauri bundle can ship it as a resource.  Runs on Windows (x86_64) and Linux
// (x86_64).  No-op when the binary is already up-to-date.
// Called from package.json prebuild / Tauri beforeDev + beforeBuild hooks,
// and from ship.yml on CI.

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const TECTONIC_VERSION = "0.16.9";

const IS_WINDOWS = process.platform === "win32";
const TARGET     = IS_WINDOWS
  ? "x86_64-pc-windows-msvc"
  : "x86_64-unknown-linux-gnu";
const ARCHIVE_EXT = IS_WINDOWS ? "zip" : "tar.gz";
const ARCHIVE_URL = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${TARGET}.${ARCHIVE_EXT}`;
const BIN_NAME    = IS_WINDOWS ? "tectonic.exe" : "tectonic";

const here       = dirname(fileURLToPath(import.meta.url));
const repoRoot   = resolve(here, "..");
const outDir     = resolve(repoRoot, "src-tauri", "binaries");
const outBin     = resolve(outDir, BIN_NAME);
const versionFile = resolve(outDir, "VERSION");

async function downloadTo(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  await new Promise((resolveP, reject) => {
    const stream = createWriteStream(dest);
    res.body.pipeTo(
      new WritableStream({
        write(chunk)  { stream.write(chunk); },
        close()       { stream.end(resolveP); },
        abort(err)    { stream.destroy(); reject(err); },
      }),
    ).catch(reject);
  });
}

function expandArchive(archivePath, extractDir) {
  if (IS_WINDOWS) {
    // PowerShell ships with every Windows image.
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-Command",
       `Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force`],
      { stdio: "inherit" },
    );
    if (r.status !== 0) throw new Error(`Expand-Archive failed for ${archivePath}`);
  } else {
    // tar is always present on Linux CI runners.
    const r = spawnSync("tar", ["xzf", archivePath, "-C", extractDir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tar xzf failed for ${archivePath}`);
  }
}

async function main() {
  if (existsSync(outBin) && existsSync(versionFile)) {
    const v = readFileSync(versionFile, "utf8").trim();
    if (v === TECTONIC_VERSION) {
      console.log(`tectonic ${TECTONIC_VERSION} already present at ${outBin}`);
      return;
    }
    console.log(`tectonic version mismatch (${v} → ${TECTONIC_VERSION}), redownloading`);
  }

  await mkdir(outDir, { recursive: true });
  const archivePath = resolve(outDir, `tectonic-${TECTONIC_VERSION}.${ARCHIVE_EXT}`);
  console.log(`downloading ${ARCHIVE_URL}`);
  await downloadTo(ARCHIVE_URL, archivePath);

  const sha = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  console.log(`sha256 ${sha}`);

  const extractDir = resolve(outDir, "_extract");
  await rm(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  expandArchive(archivePath, extractDir);

  // Both the Windows zip and the Linux tar.gz place the binary at the top
  // level of the archive with the same base name.
  const candidate = resolve(extractDir, BIN_NAME);
  if (!existsSync(candidate)) {
    throw new Error(`${BIN_NAME} not found in extracted archive at ${candidate}`);
  }
  writeFileSync(outBin, readFileSync(candidate));
  if (!IS_WINDOWS) chmodSync(outBin, 0o755);
  writeFileSync(versionFile, TECTONIC_VERSION + "\n");
  await rm(extractDir, { recursive: true, force: true });
  await rm(archivePath, { force: true });

  console.log(`tectonic ${TECTONIC_VERSION} installed at ${outBin}`);
}

main().catch((err) => {
  console.error("download-tectonic failed:", err);
  process.exit(1);
});
