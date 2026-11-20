// Downloads the Tectonic LaTeX engine binary into src-tauri/binaries/ so the
// Tauri bundle can ship it as a resource.  Runs on Windows (x86_64), Linux
// (x86_64) and macOS (aarch64/x86_64).  No-op when the binary is already up-to-date.
// Called from package.json prebuild / Tauri beforeDev + beforeBuild hooks,
// and from ship.yml on CI.

import { createWriteStream, statSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const TECTONIC_VERSION = "0.16.9";

const IS_WINDOWS = process.platform === "win32";
const TARGET     = IS_WINDOWS
  ? "x86_64-pc-windows-msvc"
  : process.platform === "darwin"
    ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
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
  const expected = Number(res.headers.get("content-length") || 0);
  await new Promise((resolveP, reject) => {
    const stream = createWriteStream(dest);
    stream.on("error", reject);
    res.body.pipeTo(
      new WritableStream({
        write(chunk)  { stream.write(chunk); },
        close()       { stream.end(resolveP); },
        abort(err)    { stream.destroy(); reject(err); },
      }),
    ).catch(reject);
  });
  // A connection the CDN drops mid-body can end the stream without an error:
  // a truncated archive would then fail to expand, so it is caught here.
  const got = statSync(dest).size;
  if (expected && got !== expected) throw new Error(`download ${url}: got ${got} of ${expected} bytes`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Windows' own bsdtar (System32, every image since Windows 10 1803) reads a
// zip and needs no PowerShell module; Expand-Archive stays as the fallback.
// Named by full path: on CI runners a bare `tar` is Git's GNU tar, which
// can't read a zip and takes "C:" for a remote host.
function expandZipWindows(archivePath, into) {
  const bsdtar = resolve(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  if (existsSync(bsdtar)) {
    const t = spawnSync(bsdtar, ["-xf", archivePath, "-C", into], { stdio: "inherit" });
    if (t.status === 0) return;
    console.error(`tar.exe could not expand ${archivePath} (status ${t.status}${t.error ? `, ${t.error.message}` : ""}); trying Expand-Archive`);
  }
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${into}' -Force`], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`Expand-Archive failed for ${archivePath} (status ${r.status}${r.error ? `, ${r.error.message}` : ""})`);
}

function expandArchive(archivePath, extractDir) {
  if (IS_WINDOWS) {
    expandZipWindows(archivePath, extractDir);
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
  const extractDir = resolve(outDir, "_extract");
  // GitHub's release-asset CDN fails now and then (a reset, a 5xx, a cut-off
  // body; on Windows also a just-written file held by the scanner): that once
  // failed every Windows release in a row. Download and expand are retried
  // together with backoff, so a flaky fetch can't block a release.
  const ATTEMPTS = 6;
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`downloading ${ARCHIVE_URL} (attempt ${attempt}/${ATTEMPTS})`);
      await rm(archivePath, { force: true });
      await downloadTo(ARCHIVE_URL, archivePath);

      const sha = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
      console.log(`sha256 ${sha}`);

      await rm(extractDir, { recursive: true, force: true });
      mkdirSync(extractDir, { recursive: true });
      expandArchive(archivePath, extractDir);
      break;
    } catch (err) {
      console.error(`attempt ${attempt} failed:`, err, err?.cause ?? "");
      if (attempt >= ATTEMPTS) throw err;
      const wait = 2000 * 2 ** (attempt - 1);
      console.log(`retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }

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
