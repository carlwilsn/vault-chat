// The pinned Codex binary. The server installs `@openai/codex@<pin>` with npm
// into $VC_STATE_DIR/codex/<pin> on first start and runs the platform binary
// from the package's vendor dir directly (not the node launcher), so the
// supervisor's signals reach the real process. VC_CODEX_BIN overrides the
// whole lookup (a pre-installed binary of the same pin).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const CODEX_VERSION = "0.162.1";

export type CodexInstall = { bin: string; version: string; dir: string; installed: boolean };

/** Find `vendor/<triple>/bin/codex[.exe]` (or `vendor/<triple>/codex/codex`) under node_modules/@openai. */
export function findCodexBinary(dir: string): string | null {
  const scope = join(dir, "node_modules", "@openai");
  let pkgs: string[] = [];
  try {
    pkgs = readdirSync(scope);
  } catch {
    return null;
  }
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  // Platform packages first (codex-linux-x64, codex-win32-x64, …), then the
  // umbrella package (older layouts vendored the binaries there).
  pkgs.sort((a, b) => (a === "codex" ? 1 : b === "codex" ? -1 : a.localeCompare(b)));
  for (const p of pkgs) {
    const vendor = join(scope, p, "vendor");
    let triples: string[] = [];
    try {
      triples = readdirSync(vendor);
    } catch {
      continue;
    }
    for (const t of triples) {
      for (const cand of [join(vendor, t, "bin", exe), join(vendor, t, "codex", exe)]) {
        try {
          if (statSync(cand).isFile()) return cand;
        } catch {
          /* next */
        }
      }
    }
  }
  return null;
}

export function codexVersionOf(bin: string): string | null {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (r.status !== 0) return null;
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout ?? "");
  return m ? m[1]! : null;
}

/** Ensure the pinned Codex exists; install it with npm when missing. Throws a
 * readable error (never a key) when it cannot. */
export function ensureCodex(stateDir: string, opts: { allowInstall?: boolean } = {}): CodexInstall {
  const override = process.env.VC_CODEX_BIN;
  if (override) {
    if (!existsSync(override)) throw new Error(`VC_CODEX_BIN=${override} does not exist`);
    const v = codexVersionOf(override);
    if (v !== CODEX_VERSION) throw new Error(`VC_CODEX_BIN is codex ${v ?? "?"}, the pin is ${CODEX_VERSION}`);
    return { bin: override, version: v, dir: override, installed: false };
  }
  const dir = join(stateDir, "codex", CODEX_VERSION);
  let bin = findCodexBinary(dir);
  let installed = false;
  if (!bin) {
    if (opts.allowInstall === false) throw new Error(`Codex ${CODEX_VERSION} is not installed in ${dir}`);
    mkdirSync(dir, { recursive: true });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const r = spawnSync(
      npm,
      ["install", "--prefix", dir, "--no-audit", "--no-fund", "--no-save", `@openai/codex@${CODEX_VERSION}`],
      { encoding: "utf8", timeout: 600_000, windowsHide: true, shell: process.platform === "win32" },
    );
    if (r.error || r.status !== 0) {
      const why = r.error ? r.error.message : (r.stderr || r.stdout || "").trim().split("\n").slice(-5).join(" | ");
      throw new Error(
        `could not install @openai/codex@${CODEX_VERSION} into ${dir} (npm ${r.error ? "not runnable" : `exit ${r.status}`}: ${why}). ` +
          `Install it by hand: npm install --prefix ${dir} @openai/codex@${CODEX_VERSION}`,
      );
    }
    installed = true;
    bin = findCodexBinary(dir);
    if (!bin) throw new Error(`@openai/codex@${CODEX_VERSION} installed in ${dir} but no platform binary was found`);
  }
  const v = codexVersionOf(bin);
  if (v !== CODEX_VERSION) throw new Error(`${bin} reports codex ${v ?? "?"}; the pin is ${CODEX_VERSION}`);
  return { bin, version: v, dir, installed };
}
