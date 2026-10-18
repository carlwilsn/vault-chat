// The preview boot: runs synchronously BEFORE /src/main.tsx (the plugin
// injects it as the first module script), so by the time any app module
// evaluates, `__TAURI_INTERNALS__`, the network wall, the clock, localStorage
// and the in-memory vault are all in place. No top-level await on purpose:
// the next module script (main.tsx) must not start before this finishes.

import { installIpc } from "./ipc";
import { installNetworkGuard, refused } from "./net";
import { installClock, now, advance } from "./clock";
import { setLlmConfig, setLlmVault, releaseHolds, llmLog } from "./llm";
import { report, reports, setOverlayHidden } from "./overlay";
import * as fs from "./shims/memfs";
import { conversationsWriteAll } from "../../server/commands/conversations";
import { dispatch, calls, unknownCommands, setOverrides, knownCommands } from "./backend/index";
import { setHostConfig, boxNext, boxPlay, boxPostLog, type BoxConv, type HostConfig } from "./backend/host";
import { seedHistory, setGitClock } from "./backend/memgit";
import { emitFromBackend } from "./ipc";
import { scenarios } from "../scenarios/index";
import { runSteps } from "./steps";
import { narrate, narrateWanted } from "./narrate";
import { namespaceLocalStorage } from "./storage";
import { playTour, ctl as tourCtl, type TourStep } from "./tour";
import type { BuildCtx, Scenario } from "../scenarios/types";

export type Base = {
  name: string;
  vaultName?: string;
  files: Record<string, string>;
  lazy: Record<string, { url: string; size: number }>;
  mtime: number;
};

export function vaultPathFor(base: Base): string {
  return `/home/carl/vaults/${base.vaultName ?? base.name}`;
}

/** The chats a scenario's build wrote (the fake box serves them: the app has no chat of its own). */
let seededChats: Record<string, unknown>[] = [];

function seedVault(vault: string, base: Base, sc: Scenario, t: number): void {
  seededChats = [];
  fs.resetFs();
  fs.seedDir("/home/carl");
  fs.seedDir(vault);
  for (const [rel, text] of Object.entries(base.files)) fs.seedText(`${vault}/${rel}`, text, base.mtime);
  for (const [rel, { url, size }] of Object.entries(base.lazy)) fs.seedLazy(`${vault}/${rel}`, url, size, base.mtime);
  fs.seedDir(`${vault}/.vault-chat/conversations`);
  const ls: Record<string, string> = {};
  const ctx: BuildCtx = {
    vault,
    base: base.name,
    now: t,
    write: (rel, text) => fs.seedText(`${vault}/${rel}`, text, t),
    read: (rel) => fs.readText(`${vault}/${rel}`),
    conversations: (convs) => {
      seededChats.push(...(convs as Record<string, unknown>[]));
      conversationsWriteAll(vault, convs.map((c) => JSON.stringify(c)));
    },
    history: (commits) => seedHistory(vault, commits),
    ls,
  };
  sc.build?.(ctx);
  // Scenario build may stage localStorage too.
  for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
}

function seedLocalStorage(vault: string, sc: Scenario): void {
  localStorage.clear();
  sessionStorage.clear();
  const ls: Record<string, string> = {
    vault_chat_last_vault: vault,
    vault_chat_tracked_vaults: JSON.stringify([vault]),
    // Never fire schedules from the preview (no scheduler turns behind your back).
    vault_chat_fire_schedules_on_this_machine: "false",
    vault_chat_theme: sc.theme ?? "graphite",
    vault_chat_model: sc.model ?? "anthropic/claude-sonnet-5.5",
    // Already "migrated" so the one-shot wipe doesn't run.
    vault_chat_voice_v2_cleared: "1",
  };
  if (sc.activeConversation) ls[`vault_chat_active_conv:${vault}`] = sc.activeConversation;
  for (const [k, v] of Object.entries({ ...ls, ...(sc.localStorage ?? {}) })) localStorage.setItem(k, v.replace(/\{vault\}/g, vault));
}

function speedTimers(map: Record<number, number> | undefined): void {
  if (!map || !Object.keys(map).length) return;
  const si = window.setInterval.bind(window);
  const st = window.setTimeout.bind(window);
  (window as any).setInterval = (fn: TimerHandler, ms?: number, ...a: any[]) => si(fn, ms !== undefined && map[ms] ? map[ms] : ms, ...a);
  (window as any).setTimeout = (fn: TimerHandler, ms?: number, ...a: any[]) => st(fn, ms !== undefined && map[ms] ? map[ms] : ms, ...a);
}

const blobUrls = new Map<string, string>();
function convertFileSrc(path: string): string {
  const lazy = fs.urlFor(path);
  if (lazy) return lazy;
  const bytes = fs.bytesOf(path);
  if (!bytes) return `${import.meta.env.BASE_URL}__preview/missing?path=${encodeURIComponent(path)}`;
  const key = `${path}:${bytes.length}`;
  const hit = blobUrls.get(key);
  if (hit) return hit;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const type =
    { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf", html: "text/html", mp4: "video/mp4" }[ext] ??
    "application/octet-stream";
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  blobUrls.set(key, url);
  return url;
}

const PREVIEW_BOX = { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" };

/** Every chat runs on the box: a scenario that wrote chats and says nothing
 *  about a box gets the preview's box serving them (its turns recorded, live).
 *  `sync.box: null` keeps a scenario without a box ("Connect your box"). */
function withBoxChats(host: HostConfig): HostConfig {
  if (!seededChats.length || (host.sync && "box" in host.sync)) return host;
  const convs: Record<string, BoxConv> = {};
  for (const c of seededChats) {
    const { id, title, source, status, messages, ...meta } = c as Record<string, any>;
    if (typeof id !== "string") continue;
    convs[id] = { title: String(title ?? "New chat"), source: source ?? "manual", status: status === "running" ? "running" : "idle", meta, messages: Array.isArray(messages) ? messages : [] };
  }
  return { ...host, sync: { ...(host.sync ?? {}), box: PREVIEW_BOX, boxChat: { convs, live: true } } };
}

export function boot(base: Base): void {
  const q = new URLSearchParams(location.search);
  const side = q.get("side") ?? "before";
  const id = q.get("scenario") ?? "home";
  const isPopout = q.get("view") === "chat";
  // ?ns= lets two frames of one side (tour preloading) keep separate storage;
  // the chat popout passes its main frame's.
  namespaceLocalStorage(q.get("ns") ?? side);
  // ?tour=1: the shell's Tour plays the steps itself (paced), not on load.
  const tourMode = q.get("tour") === "1";
  setOverlayHidden(q.get("overlay") === "0");
  const sc = scenarios.find((s) => s.id === id) ?? scenarios[0];
  if (sc.id !== id) report("error", `unknown scenario "${id}" — showing "${sc.id}"`);

  installClock(sc.clock ?? "2026-10-10T09:30:00");
  fs.setFsClock(now);
  setGitClock(now);
  installNetworkGuard();
  speedTimers(sc.fastTimers);

  const vault = vaultPathFor(base);
  if (!isPopout) seedLocalStorage(vault, sc);
  seedVault(vault, base, sc, now());
  setLlmConfig(sc.llm ?? {});
  setLlmVault(vault);
  setHostConfig(withBoxChats((typeof sc.host === "function" ? sc.host(now()) : sc.host) ?? {}), now);
  setOverrides(sc.overrides);

  installIpc(isPopout ? "chat-popout" : "main", dispatch, `${side}:${sc.id}`);
  (window as any).__TAURI_INTERNALS__.convertFileSrc = convertFileSrc;

  window.addEventListener("error", (e) => report("error", String(e.message ?? e)));
  window.addEventListener("unhandledrejection", (e) => {
    const r = (e as PromiseRejectionEvent).reason;
    const msg = typeof r === "string" ? r : r?.message ?? String(r);
    if (/AbortError|aborted/i.test(msg)) return;
    console.warn("[preview] unhandled rejection:", msg);
  });

  const api = {
    side,
    scenario: sc.id,
    base: base.name,
    vault,
    emit: (event: string, payload?: unknown) => emitFromBackend(event, payload),
    calls: () => calls,
    unknown: () => [...unknownCommands],
    refused: () => refused,
    reports: () => reports,
    llm: () => llmLog,
    release: () => releaseHolds(),
    advance: (ms: number) => advance(ms),
    /** Box-mode chat: play the fake box's next scripted step. */
    boxNext: () => boxNext(),
    /** Box-mode chat: play a step the check wrote itself. */
    boxPlay: (st: Parameters<typeof boxPlay>[0]) => boxPlay(st),
    /** What the laptop POSTed to the fake box. */
    boxPosts: () => boxPostLog(),
    /** Play one of the scenario's drive stages (the full-conversation checks). */
    play: (i: number) => runSteps(sc.drive?.[i] ?? [], vault),
    known: () => knownCommands(),
    readFile: (p: string) => fs.readText(p.startsWith("/") ? p : `${vault}/${p}`),
    ready: false,
    stepsDone: false,
    /** Tour: play the scenario's own open steps ("open": paced or "fast") and
     *  then `steps`, at a human pace. */
    tour: async (steps: TourStep[], o: { open?: "paced" | "fast" | "skip"; pace?: number } = {}) => {
      const open = (o.open ?? "paced") === "skip" ? [] : (sc.open ?? []);
      if ((o.open ?? "paced") === "fast" && open.length) {
        await runSteps(open, vault);
        return playTour(steps, { side, vault, pace: o.pace });
      }
      return playTour([...(open as TourStep[]), ...steps], { side, vault, pace: o.pace });
    },
    tourPause: (p: boolean) => void (tourCtl.paused = p),
    tourAbort: () => void (tourCtl.aborted = true),
    stepError: null as string | null,
    /** Console errors this scenario provokes on purpose (regex sources). */
    expectedErrors: () => sc.expectedErrors ?? [],
  };
  (window as any).__preview = api;

  // Tell the harness which scenario this frame is in.
  try {
    window.parent?.postMessage({ source: "vc-preview", type: "boot", side, scenario: sc.id, base: base.name }, "*");
  } catch {
    /* no parent */
  }

  // Steps run once the app has mounted (the splash is gone).
  const startSteps = () => {
    api.ready = true;
    if (isPopout || tourMode || !sc.open?.length || q.get("steps") === "0") {
      api.stepsDone = true;
      return;
    }
    // Opened directly, a scenario with beats plays narrated (captions, a human
    // pace); &narrate=0 — and any checker (navigator.webdriver) — plays `open`.
    const narrated = !!sc.narrate?.length && narrateWanted(q);
    (narrated ? narrate({ beats: sc.narrate!, surface: "desktop", exec: (s) => runSteps([s], vault) }) : runSteps(sc.open, vault))
      .then(() => {
        api.stepsDone = true;
      })
      .catch((e) => {
        api.stepError = String(e?.message ?? e);
        api.stepsDone = true;
        report("error", `scenario step failed: ${api.stepError}`);
      });
  };
  const waitMount = () => {
    if (document.getElementById("vault-splash") || !document.querySelector("#root > *")) return void setTimeout(waitMount, 50);
    setTimeout(startSteps, 150);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", waitMount);
  else waitMount();
}
