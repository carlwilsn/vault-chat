// `vault-chat-server.mjs master <command>`: the vault-chat folder from a shell, on the box or the laptop
// (server/masterMigrate.ts). Never deletes or moves an original.
//
//   master status   [--master DIR]
//   master copy     --master DIR --vault PATH [--bare PATH|--no-bare] [--name NAME]
//   master adopt    --master DIR --project PATH [--name NAME] [--vault COPIED_VAULT]
//   master verify   --master DIR --name NAME
//   master switch   --master DIR --name NAME [--env FILE]    (box: the server's env file names the copy)
//   master back     --master DIR [--env FILE]                (box: the env file exactly as before)
import { homedir } from "node:os";
import { join } from "node:path";
import { adoptProject, copyVault, migrationRecord, switchBack, switchToCopy, verifyCopy } from "./masterMigrate";

function arg(argv: string[], k: string): string | undefined {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function need(argv: string[], k: string): string {
  const v = arg(argv, k);
  if (!v) throw new Error(`--${k} is required`);
  return v;
}

export async function runMasterCli(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const master = arg(argv, "master") ?? process.env.VC_MASTER ?? join(home, "vc");
  const envFile = arg(argv, "env") ?? process.env.VC_ENV_FILE ?? join(home, ".config", "vault-chat-server.env");
  const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));
  try {
    switch (cmd) {
      case "status":
        out({ master, record: migrationRecord(master) });
        return 0;
      case "copy": {
        const r = copyVault({ master, from: need(argv, "vault"), bareFrom: argv.includes("--no-bare") ? null : arg(argv, "bare"), name: arg(argv, "name") });
        out(r);
        return r.verify.ok ? 0 : 3;
      }
      case "adopt":
        out(adoptProject({ master, from: need(argv, "project"), name: arg(argv, "name"), vault: arg(argv, "vault") }));
        return 0;
      case "verify": {
        const v = migrationRecord(master).vaults[need(argv, "name")];
        if (!v) throw new Error("not copied yet");
        const r = verifyCopy(v.from, v.to, v.bareFrom, v.bareTo);
        out(r);
        return r.ok ? 0 : 3;
      }
      case "switch":
        out({ ...switchToCopy({ master, name: need(argv, "name"), envFile }), next: "systemctl --user restart vault-chat-server" });
        return 0;
      case "back":
        out({ ...switchBack({ master, envFile }), next: "systemctl --user restart vault-chat-server" });
        return 0;
      default:
        console.error("usage: master status|copy|adopt|verify|switch|back (see server/masterCli.ts)");
        return 2;
    }
  } catch (e) {
    console.error(`master ${cmd}: ${(e as Error).message}`);
    return 1;
  }
}
