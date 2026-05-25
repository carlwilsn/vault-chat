// Downloads the Tectonic LaTeX engine binary into
// `src-tauri/binaries/tectonic.exe` so the Tauri bundle can ship it as a
// resource. No-op when the binary already exists, so dev rebuilds don't
// re-download. Called from package.json prebuild / Tauri beforeDev +
// beforeBuild hooks, and from ship.yml on CI.
//
// Only Windows x86_64 is fetched today because ship.yml only builds for
// Windows. When mac/linux ship targets land, extend this with arch/os
// branches.

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const TECTONIC_VERSION = "0.16.9";
const TARGET = "x86_64-pc-windows-msvc";
const ZIP_URL = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${TARGET}.zip`;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = resolve(repoRoot, "src-tauri", "binaries");
const outBin = resolve(outDir, "tectonic.exe");
const versionFile = resolve(outDir, "VERSION");

async function downloadTo(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  await new Promise((resolveP, reject) => {
    const stream = createWriteStream(dest);
    res.body.pipeTo(
      new WritableStream({
        write(chunk) {
          stream.write(chunk);
        },
        close() {
          stream.end(resolveP);
        },
        abort(err) {
          stream.destroy();
          reject(err);
        },
      }),
    ).catch(reject);
  });
}

function expandZip(zipPath, dest) {
  // PowerShell ships with every Windows. Avoids adding a node-side zip
  // dependency just for this. Linux/mac CI runners that bootstrap this
  // script would need an `unzip` branch; not relevant yet because ship
  // only runs on windows-latest.
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${dest}' -Force`,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`Expand-Archive failed for ${zipPath}`);
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
  const zipPath = resolve(outDir, `tectonic-${TECTONIC_VERSION}.zip`);
  console.log(`downloading ${ZIP_URL}`);
  await downloadTo(ZIP_URL, zipPath);

  const sha = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  console.log(`sha256 ${sha}`);

  const extractDir = resolve(outDir, "_extract");
  await rm(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  expandZip(zipPath, extractDir);

  // Tectonic's Windows release zip has a single tectonic.exe at the
  // top level; copy it to the canonical location.
  const candidate = resolve(extractDir, "tectonic.exe");
  if (!existsSync(candidate)) {
    throw new Error(`tectonic.exe not found in extracted zip at ${candidate}`);
  }
  writeFileSync(outBin, readFileSync(candidate));
  writeFileSync(versionFile, TECTONIC_VERSION + "\n");
  await rm(extractDir, { recursive: true, force: true });
  await rm(zipPath, { force: true });

  console.log(`tectonic ${TECTONIC_VERSION} installed at ${outBin}`);
}

main().catch((err) => {
  console.error("download-tectonic failed:", err);
  process.exit(1);
});
