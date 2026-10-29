// `vault-chat-server.mjs projects <command>`: moving the projects out of the vaults (server/projectsMigrate.ts), from a
// shell on the box, with the server STOPPED (systemctl --user stop vault-chat-server). Never deletes anything.
//
//   projects status   [--env FILE]                  where the home is, its projects, what each vault still holds
//   projects migrate  [--env FILE] [--dry-run]      every vault's projects into the home (copy, verify, hide originals)
//   projects back     [--env FILE] [--stamp S]      undo the last (or that) migration
//
// --env: the server's env file (default VC_ENV_FILE, else ~/.config/vault-chat-server.env): VC_VAULT, VC_MASTER,
// VC_STATE_DIR and VC_PROJECTS_HOME are read from it, so the command sees exactly what the server sees.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function arg(argv: string[], k: string): string | undefined {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** KEY=VALUE lines into process.env (what is set already wins). */
export function loadEnvFile(file: string): string[] {
  if (!existsSync(file)) return [];
  const got: string[] = [];
  for (const l of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l);
    if (!m || m[1]! in process.env) continue;
    process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    got.push(m[1]!);
  }
  return got;
}

export async function runProjectsCli(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const envFile = arg(argv, "env") ?? process.env.VC_ENV_FILE ?? join(home, ".config", "vault-chat-server.env");
  loadEnvFile(envFile);
  const { reloadConfig } = await import("./config");
  const { listVaults, vaultPaths } = await import("./sync");
  const { resolveProjectsHome } = await import("./projectsHome");
  const { migrateProjects, migrateBack } = await import("./projectsMigrate");
  const { agentWorkDir } = await import("./workArea");
  // The env file as the server reads it (something may have read the config before it was loaded).
  const cfg = reloadConfig();
  const projectsHome = resolveProjectsHome();
  const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));
  const vaults = listVaults().map((v) => {
    const path = v.main ? cfg.vault : vaultPaths(v.name).vault;
    const pi = v.main ? join(cfg.stateDir, "pi") : join(cfg.stateDir, "vaults", v.name, "pi");
    return { name: v.name, main: v.main, path, piSessions: join(pi, "sessions"), piInstr: join(pi, "instr") };
  });
  try {
    switch (cmd) {
      case "status": {
        const list = (d: string) => {
          try {
            return readdirSync(d).filter((n) => !n.startsWith("."));
          } catch {
            return [];
          }
        };
        out({ envFile, projectsHome, projects: list(projectsHome), vaults: vaults.map((v) => ({ name: v.name, path: v.path, stillInVault: list(join(v.path, "agent-projects")) })) });
        return 0;
      }
      case "migrate": {
        // Never under a running server (it writes the logs this moves): refused while its port answers.
        if (!argv.includes("--dry-run") && (await serverUp(cfg.host, cfg.port))) {
          console.error(`projects migrate: the server answers on ${cfg.host}:${cfg.port}: stop it first (systemctl --user stop vault-chat-server)`);
          return 4;
        }
        const r = migrateProjects({
          home: projectsHome,
          vaults: vaults.map((v) => ({ path: v.path, piSessions: v.piSessions, piInstr: v.piInstr })),
          mainInstr: join(cfg.stateDir, "pi", "instr"),
          mainVault: cfg.vault,
          dryRun: argv.includes("--dry-run"),
          workArea: (v) => agentWorkDir(home, v),
        });
        out({ envFile, projectsHome, dryRun: argv.includes("--dry-run"), ...r });
        return r.ok ? 0 : 3;
      }
      case "back": {
        if (await serverUp(cfg.host, cfg.port)) {
          console.error(`projects back: the server answers on ${cfg.host}:${cfg.port}: stop it first (systemctl --user stop vault-chat-server)`);
          return 4;
        }
        const r = migrateBack({ home: projectsHome, stamp: arg(argv, "stamp") });
        out({ projectsHome, ...r });
        return r.ok ? 0 : 3;
      }
      default:
        console.error("usage: projects status|migrate [--dry-run]|back [--stamp S] [--env FILE] (see server/projectsCli.ts)");
        return 2;
    }
  } catch (e) {
    console.error(`projects ${cmd}: ${(e as Error).message}`);
    return 1;
  }
}

/** Whether a vault-chat server answers on this port (its health route). */
async function serverUp(host: string, port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    return r.status > 0;
  } catch {
    return false;
  }
}
