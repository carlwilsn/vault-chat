// Server configuration, read once from the environment. Every path the server
// touches comes from here so tests can point the whole process at temp dirs.
import { voicePort } from "./voicePorts";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

/**
 * The home this process reads and writes under. `homedir()` is the last resort
 * and it THROWS where there is no passwd entry for the uid (uv_os_homedir
 * ENOENT) — a sandbox, a container, the ship host's own gate — and it threw at
 * import time, so the bundle could not even print its build-info there. A home
 * is not something to crash over: tmpdir is somewhere to be.
 */
function homeDir(): string {
  const named = env("HOME") ?? env("USERPROFILE");
  if (named) return named;
  try {
    return homedir();
  } catch {
    return tmpdir();
  }
}

const HOME = homeDir();
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
  /** The port this process listens on: its private backend port behind the front, else the public one. */
  port: number;
  /** The port clients use (VC_PORT, 8848 on the box): the front's (server/deploy/vault-chat-front.mjs), or this
   *  process's own when it runs alone. */
  publicPort: number;
  /** Set when this server runs behind the front (VC_BACKEND_PORT): it takes over the box's data (server/owner.ts) and
   *  tells the front when it serves. */
  backend: boolean;
  voicePort: number;
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
};

let cached: ServerConfig | null = null;

export function loadConfig(): ServerConfig {
  if (cached) return cached;
  const vault = resolve(env("VC_VAULT") ?? join(HOME, "vaults", "school2"));
  const vaultName = env("VC_VAULT_NAME") ?? vault.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!;
  const stateDir = resolve(env("VC_STATE_DIR") ?? join(HOME, ".local", "state", "vault-chat-server"));
  const publicPort = Number(env("VC_PORT") ?? 8848);
  const backendPort = env("VC_BACKEND_PORT");
  const port = backendPort === undefined ? publicPort : Number(backendPort);
  // The voice port belongs to the public instance (8857 beside 8848), whichever server owns it now.
  const voice = voicePort(publicPort, process.env.VC_VOICE_PORT, process.env.VC_VOICE_PIPELINE_PORT);
  if (backendPort !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535 || port === publicPort || port === voice || port === 8848 || port === 8857))
    throw new Error(`VC_BACKEND_PORT ${backendPort} must be a free private port, not the public (${publicPort}) or voice (${voice}) one`);
  cached = {
    host: env("VC_HOST") ?? "127.0.0.1",
    port,
    publicPort,
    backend: backendPort !== undefined,
    voicePort: voice,
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
  };
  return cached;
}

/** Version baked in at build time (package.json), "dev" when unbundled. */
export const SERVER_VERSION: string =
  typeof __VC_VERSION__ !== "undefined" ? __VC_VERSION__ : "dev";
export const SERVER_REV: string = typeof __VC_REV__ !== "undefined" ? __VC_REV__ : "";

declare const __VC_VERSION__: string;
declare const __VC_REV__: string;
