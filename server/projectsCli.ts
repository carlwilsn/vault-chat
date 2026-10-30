// `vault-chat-server.mjs projects <command>`: the move to one Main and folder projects (server/projectsMigrate.ts),
// from a shell on the box with the server STOPPED (systemctl --user stop vault-chat-server). Never deletes anything.
//
//   projects status   [--env FILE]
//   projects migrate  [--env FILE] [--dry-run] [--map SLUG=FOLDER]...   (FOLDER: absolute, or relative to its vault)
//   projects back     [--env FILE] [--stamp S]                          (undo the last migration, or that one)
//
// --env: the server's env file (default VC_ENV_FILE, else ~/.config/vault-chat-server.env): VC_VAULT, VC_VAULT_NAME,
// VC_MASTER and VC_STATE_DIR are read from it, so the command sees the vaults the server sees.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { envFileValue } from "./masterCli";
import { migrateBack, migrateProjects, migrations, projectsStatus, type MigrateVault } from "./projectsMigrate";

function arg(argv: string[], k: string): string | undefined {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function args(argv: string[], k: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${k}` && argv[i + 1] !== undefined) out.push(argv[++i]!);
  return out;
}

/** The server's vaults, as its env file names them: the main one, then <VC_MASTER>/vaults/*. */
export function serverVaults(envFile: string): { vaults: MigrateVault[]; stateDir: string } {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const get = (k: string) => envFileValue(envFile, k) ?? process.env[k];
  const main = resolve(get("VC_VAULT") ?? join(home, "vaults", "school2"));
  const stateDir = resolve(get("VC_STATE_DIR") ?? join(home, ".local", "state", "vault-chat-server"));
  const vaults: MigrateVault[] = [{ name: get("VC_VAULT_NAME") ?? basename(main), path: main, main: true }];
  const m = get("VC_MASTER");
  if (m) {
    const dir = join(resolve(m), "vaults");
    let names: string[] = [];
    try {
      names = readdirSync(dir).sort();
    } catch {
      names = [];
    }
    for (const n of names) {
      const p = join(dir, n);
      if (p !== main && existsSync(join(p, ".git"))) vaults.push({ name: n, path: p, main: false });
    }
  }
  return { vaults, stateDir };
}

/** Whether the server answers on its port (it must be stopped for migrate and back). */
async function serverUp(envFile: string): Promise<boolean> {
  const port = envFileValue(envFile, "VC_PORT") ?? "8848";
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.status > 0;
  } catch {
    return false;
  }
}

export async function runProjectsCli(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const envFile = arg(argv, "env") ?? process.env.VC_ENV_FILE ?? join(home, ".config", "vault-chat-server.env");
  const { vaults, stateDir } = serverVaults(envFile);
  const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));
  try {
    switch (cmd) {
      case "status":
        out({ vaults: projectsStatus(vaults), migrations: migrations(stateDir) });
        return 0;
      case "migrate": {
        const dryRun = argv.includes("--dry-run");
        if (!dryRun && !argv.includes("--server-stopped-check-skip") && (await serverUp(envFile))) {
          console.error("the server is running: stop it first (systemctl --user stop vault-chat-server)");
          return 3;
        }
        const map: Record<string, string> = {};
        for (const m of args(argv, "map")) {
          const i = m.indexOf("=");
          if (i > 0) map[m.slice(0, i)] = m.slice(i + 1);
        }
        const man = migrateProjects({ vaults, stateDir, map, dryRun, log: (s) => console.error(s) });
        out({ stamp: man.stamp, dryRun: man.dryRun, report: man.report, changes: man.changes.length });
        return 0;
      }
      case "back": {
        if (!argv.includes("--server-stopped-check-skip") && (await serverUp(envFile))) {
          console.error("the server is running: stop it first (systemctl --user stop vault-chat-server)");
          return 3;
        }
        out(migrateBack({ stateDir, stamp: arg(argv, "stamp"), log: (s) => console.error(s) }));
        return 0;
      }
      default:
        console.error("usage: projects status|migrate|back (see server/projectsCli.ts)");
        return 2;
    }
  } catch (e) {
    console.error(String((e as Error)?.message ?? e));
    return 1;
  }
}
