// The pinned pi. The server installs `@earendil-works/pi-coding-agent@<pin>`
// with npm into $VC_STATE_DIR/pi/<pin> on first start and runs its cli.js with
// the server's own node. VC_PI_DIR overrides the prefix (a pre-installed copy
// of the same pin). Also finds bubblewrap, which the pi engine requires on Linux.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export const PI_VERSION = "1.1.0";
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

export type PiInstall = { cli: string; node: string; version: string; dir: string; installed: boolean };

function pkgDir(prefix: string): string {
  return join(prefix, "node_modules", ...PI_PACKAGE.split("/"));
}

export function piVersionAt(prefix: string): string | null {
  try {
    return String(JSON.parse(readFileSync(join(pkgDir(prefix), "package.json"), "utf8")).version ?? "") || null;
  } catch {
    return null;
  }
}

function cliOf(prefix: string): string | null {
  const p = join(pkgDir(prefix), "dist", "bundle", "cli.js");
  return existsSync(p) ? p : null;
}

/** Ensure the pinned pi exists; install it with npm when missing. Throws a readable error. */
export async function ensurePi(stateDir: string, opts: { allowInstall?: boolean } = {}): Promise<PiInstall> {
  const node = process.execPath;
  const override = process.env.VC_PI_DIR;
  if (override) {
    const v = piVersionAt(override);
    const cli = cliOf(override);
    if (!cli) throw new Error(`VC_PI_DIR=${override} has no ${PI_PACKAGE}`);
    if (v !== PI_VERSION) throw new Error(`VC_PI_DIR has pi ${v ?? "?"}, the pin is ${PI_VERSION}`);
    return { cli, node, version: v, dir: override, installed: false };
  }
  const dir = join(stateDir, "pi", PI_VERSION);
  let installed = false;
  if (piVersionAt(dir) !== PI_VERSION || !cliOf(dir)) {
    if (opts.allowInstall === false) throw new Error(`pi ${PI_VERSION} is not installed in ${dir}`);
    mkdirSync(dir, { recursive: true });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    // Async, so the server answers (health: "starting") while npm runs.
    const r = await new Promise<{ status: number | null; error?: Error; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(npm, ["install", "--prefix", dir, "--no-audit", "--no-fund", "--no-save", `${PI_PACKAGE}@${PI_VERSION}`], {
        windowsHide: true,
        shell: process.platform === "win32",
      });
      let stdout = "";
      let stderr = "";
      p.stdout?.on("data", (d) => (stdout += d));
      p.stderr?.on("data", (d) => (stderr += d));
      const t = setTimeout(() => p.kill(), 600_000);
      p.on("error", (error) => {
        clearTimeout(t);
        resolve({ status: null, error, stdout, stderr });
      });
      p.on("close", (status) => {
        clearTimeout(t);
        resolve({ status, stdout, stderr });
      });
    });
    if (r.error || r.status !== 0) {
      const why = r.error ? r.error.message : (r.stderr || r.stdout || "").trim().split("\n").slice(-5).join(" | ");
      throw new Error(
        `could not install ${PI_PACKAGE}@${PI_VERSION} into ${dir} (npm ${r.error ? "not runnable" : `exit ${r.status}`}: ${why}). ` +
          `Install it by hand: npm install --prefix ${dir} ${PI_PACKAGE}@${PI_VERSION}`,
      );
    }
    installed = true;
  }
  const v = piVersionAt(dir);
  const cli = cliOf(dir);
  if (v !== PI_VERSION || !cli) throw new Error(`${dir} holds pi ${v ?? "?"}; the pin is ${PI_VERSION}`);
  return { cli, node, version: v, dir, installed };
}

/** bubblewrap: $VC_BWRAP, then PATH, then the Nix store (highest version). null when absent. */
export function findBwrap(): string | null {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const env = process.env.VC_BWRAP;
  if (env) return isFile(env) ? env : null;
  if (process.platform !== "linux") return null;
  for (const d of (process.env.PATH ?? "").split(delimiter)) if (d && isFile(join(d, "bwrap"))) return join(d, "bwrap");
  for (const d of ["/run/current-system/sw/bin", "/usr/bin", "/bin"]) if (isFile(join(d, "bwrap"))) return join(d, "bwrap");
  try {
    const hits = readdirSync("/nix/store")
      .filter((n) => /-bubblewrap-\d[\d.]*$/.test(n))
      .map((n) => ({ p: join("/nix/store", n, "bin", "bwrap"), v: (/-bubblewrap-([\d.]+)$/.exec(n)?.[1] ?? "0").split(".").map(Number) }))
      .filter((h) => isFile(h.p))
      .sort((a, b) => a.v.map((x, i) => x - (b.v[i] ?? 0)).find((d) => d !== 0) ?? 0);
    return hits.length ? hits[hits.length - 1]!.p : null;
  } catch {
    return null;
  }
}
