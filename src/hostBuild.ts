// The laptop's half of "which build is running" (server/hostBuild.ts):
//   - at each launch the main window reports its build to the box once (POST /api/v1/host/build), after the first
//     screen is interactive, carrying that launch's launch-to-interactive time: the box logs it and wakes any chat
//     waiting for a new laptop build (LaptopBuild {action:"wake"});
//   - the agent's LaptopBuild asks live with a {type:"build", id} signal; src/boxChat.ts hands it here and the ack
//     carries the same record.
// Read only: the compiled-in version/revision (vite.config.ts), the native app's version, the server this app runs
// itself (if any). Nothing about Carl's content.
import { isTauri } from "@tauri-apps/api/core";
import { boxGet, boxLinkFor, boxPost, localServerLink, type Link } from "./boxChat";
import { launchTiming, runtimeVersionFor } from "./laptopPerf";
import { useStore } from "./store";

declare const __APP_REVISION__: string | undefined;
declare const __APP_VERSION__: string | undefined;

export type HostBuildInfo = {
  host: "laptop";
  version: string;
  revision: string;
  nativeVersion?: string;
  surface: string;
  runtime: string;
  runtimeVersion: string;
  reason: "launch" | "ask";
  session: string;
  launchMs?: number;
  launchMethod?: string;
  startedAt: string;
  localServer: { url: string; version?: string; rev?: string } | null;
  box?: string;
};

const session = Math.random().toString(36).slice(2, 10);

export type HostBuildDeps = {
  /** The installed native app's version (default: Tauri getVersion; none in a browser). */
  nativeVersion?: () => Promise<string | undefined>;
  /** The build info of the server this app runs itself (default: its /api/v1/health). */
  localServerBuild?: (link: Link) => Promise<{ version?: string; rev?: string }>;
  link?: Link | null;
};

async function defaultNativeVersion(): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  try {
    return await (await import("@tauri-apps/api/app")).getVersion();
  } catch {
    return undefined;
  }
}

async function defaultLocalServerBuild(link: Link): Promise<{ version?: string; rev?: string }> {
  try {
    const h = (await boxGet(link, "/api/v1/health", 4000)) as { version?: unknown; rev?: unknown };
    return { ...(typeof h?.version === "string" ? { version: h.version } : {}), ...(typeof h?.rev === "string" ? { rev: h.rev } : {}) };
  } catch {
    return {};
  }
}

/** This app's build, as the box keeps it. */
export async function hostBuildInfo(reason: "launch" | "ask", deps: HostBuildDeps = {}): Promise<HostBuildInfo> {
  const native = isTauri();
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const prod = !!(import.meta as { env?: { PROD?: boolean } }).env?.PROD;
  const vault = useStore.getState().vaultPath;
  const local = localServerLink(vault);
  const launch = await launchTiming(0);
  const nativeVersion = await (deps.nativeVersion ?? defaultNativeVersion)();
  const link = deps.link === undefined ? await boxLinkFor(vault).catch(() => null) : deps.link;
  const origin = typeof performance !== "undefined" && Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : Date.now();
  return {
    host: "laptop",
    version: typeof __APP_VERSION__ === "string" && __APP_VERSION__ ? __APP_VERSION__ : "dev",
    revision: typeof __APP_REVISION__ === "string" && __APP_REVISION__ ? __APP_REVISION__ : "unknown",
    ...(nativeVersion ? { nativeVersion } : {}),
    surface: native ? (prod ? "tauri-production" : "tauri-development") : "browser",
    runtime: !native ? "browser" : /Windows/.test(ua) ? "webview2" : /Linux/.test(ua) ? "webkitgtk" : /Macintosh/.test(ua) ? "wkwebview" : "unknown",
    runtimeVersion: runtimeVersionFor(ua),
    reason,
    session,
    ...(launch ? { launchMs: Math.round(launch.ms), launchMethod: launch.method } : {}),
    startedAt: new Date(origin).toISOString(),
    localServer: local ? { url: local.url, ...(await (deps.localServerBuild ?? defaultLocalServerBuild)(local)) } : null,
    ...(link && (!local || link.url !== local.url) ? { box: link.url } : {}),
  };
}

export type BuildSignal = { type: "build"; id: string; to?: string };
export type BuildAck = { ok: boolean; data?: HostBuildInfo; error?: string };

/** The answer to LaptopBuild's live ask. */
export async function buildOnLaptop(_sig: BuildSignal, deps: HostBuildDeps = {}): Promise<BuildAck> {
  try {
    return { ok: true, data: await hostBuildInfo("ask", deps) };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

let reporting = false;
/**
 * Once per launch, main window only: report this build to the box after the first screen is interactive (or 90 s).
 * Retries a few times while the box is unreachable; never blocks anything. Resolves true once the box took it.
 */
export async function reportBuildAtLaunch(o: { tries?: number; everyMs?: number; waitLaunchMs?: number; deps?: HostBuildDeps } = {}): Promise<boolean> {
  if (reporting) return false;
  reporting = true;
  await launchTiming(o.waitLaunchMs ?? 90_000);
  const tries = o.tries ?? 10;
  for (let i = 0; i < tries; i++) {
    try {
      const vault = useStore.getState().vaultPath;
      const link = o.deps?.link ?? (await boxLinkFor(vault));
      if (link) {
        const info = await hostBuildInfo("launch", { ...o.deps, link });
        const r = (await boxPost(link, "/api/v1/host/build", info as unknown as Record<string, unknown>)) as { ok?: boolean };
        if (r?.ok) return true;
      }
    } catch {
      /* the next try */
    }
    await new Promise((r) => setTimeout(r, o.everyMs ?? 30_000));
  }
  return false;
}
