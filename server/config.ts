// Server configuration, read once from the environment. Every path the server
// touches comes from here so tests can point the whole process at temp dirs.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

const HOME = env("HOME") ?? env("USERPROFILE") ?? homedir();
const APP_DATA = join(HOME, ".local", "share", "com.vault-chat.app");
const APP_CONFIG = join(HOME, ".config", "com.vault-chat.app");

/** Directory holding the encrypted key store (`secrets.age` + `fallback.key`).
 * Mirrors lib.rs fallback_secret_dir (lib.rs:5955): $XDG_CONFIG_HOME/vault-chat,
 * else ~/.config/vault-chat. */
function secretDir(): string {
  if (env("VC_SECRETS_DIR")) return resolve(env("VC_SECRETS_DIR")!);
  const xdg = env("XDG_CONFIG_HOME");
  return join(xdg ?? join(HOME, ".config"), "vault-chat");
}

export type ServerConfig = {
  host: string;
  port: number;
  /** The box working copy (`~/vaults/<vault>` on branch `box`). */
  vault: string;
  /** Vault name used in `/git/<name>.git` and sync paths. */
  vaultName: string;
  /** Bare repo backing git hosting (`~/vaults/<vault>.git`). */
  bareRepo: string;
  localStoragePath: string;
  pushSubsPath: string;
  tokenPath: string;
  secretsDir: string;
  stateDir: string;
  allowedLogins: string[];
  syncEnabled: boolean;
  syncIntervalMs: number;
  init: boolean;
  /** Test hook: rewrite https://openrouter.ai/api/v1 to this base. */
  openrouterBase?: string;
};

let cached: ServerConfig | null = null;

export function loadConfig(): ServerConfig {
  if (cached) return cached;
  const vault = resolve(env("VC_VAULT") ?? join(HOME, "vaults", "school2"));
  const vaultName = env("VC_VAULT_NAME") ?? vault.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!;
  const stateDir = resolve(env("VC_STATE_DIR") ?? join(HOME, ".local", "state", "vault-chat-server"));
  cached = {
    host: env("VC_HOST") ?? "127.0.0.1",
    port: Number(env("VC_PORT") ?? 8848),
    vault,
    vaultName,
    // A vault in the vault-chat folder (VC_MASTER, server/master.ts) has its hub in <folder>/.hub/vaults/.
    bareRepo: resolve(
      env("VC_BARE_REPO") ??
        (env("VC_MASTER") && resolve(vault, "..") === resolve(env("VC_MASTER")!, "vaults")
          ? join(env("VC_MASTER")!, ".hub", "vaults", `${vaultName}.git`)
          : join(vault, "..", `${vaultName}.git`)),
    ),
    localStoragePath: resolve(env("VC_LOCALSTORAGE") ?? join(APP_DATA, "mission-engine.localstorage")),
    // voice_server.rs:1435 subs_path() = app_config_dir()/phone-push-subs.json;
    // Tauri's app_config_dir on Linux is ~/.config/<identifier>.
    pushSubsPath: resolve(env("VC_PUSH_SUBS") ?? join(APP_CONFIG, "phone-push-subs.json")),
    tokenPath: resolve(env("VC_TOKEN_FILE") ?? join(APP_DATA, "phone-token")),
    secretsDir: secretDir(),
    stateDir,
    allowedLogins: (env("VC_ALLOWED_LOGINS") ?? "carwilson0929@gmail.com")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    syncEnabled: env("VC_SYNC") !== "0",
    syncIntervalMs: Number(env("VC_SYNC_INTERVAL_MS") ?? 15_000),
    init: env("VC_INIT") === "1",
    openrouterBase: env("VC_OPENROUTER_BASE"),
  };
  return cached;
}

/** Version baked in at build time (package.json), "dev" when unbundled. */
export const SERVER_VERSION: string =
  typeof __VC_VERSION__ !== "undefined" ? __VC_VERSION__ : "dev";
export const SERVER_REV: string = typeof __VC_REV__ !== "undefined" ? __VC_REV__ : "";

declare const __VC_VERSION__: string;
declare const __VC_REV__: string;

/** Read the environment again (a CLI that loaded the server's env file after something read the config). */
export function reloadConfig(): ServerConfig {
  cached = null;
  return loadConfig();
}
