import { Buffer } from "buffer";
// gray-matter (used by skills/tools loaders) expects Node's Buffer global.
// Polyfill it for the renderer before any module that imports gray-matter
// runs.
(globalThis as any).Buffer ??= Buffer;

import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { applyHljsTheme } from "./hljsTheme";
import App from "./App";
import { LaptopReleaseHealthMount } from "./laptopReleaseHealth";
import { ChatWindow } from "./ChatWindow";
import { installMainSync, installPopoutSync } from "./sync";
import {
  hydrateKeychain,
  useStore,
} from "./store";
import { installDebugLog, flushDebugLogToDisk, vlog } from "./debugLog";
import { afterVaultReady, bootMark, installBootTiming } from "./bootTiming";
import { installAutosaveNet } from "./autosave";
import { initBackgroundMode } from "./background";
import { installClientEvents } from "./clientEvents";
import { installAppLiveBridge } from "./liveBridgeApp";
import { installAppShip } from "./appShip";
import { installDiagShortcut } from "./diag";
import { installLaptopPerf } from "./laptopPerf";

// Install the freeze diagnostic logger before anything else runs, so a
// crash during boot still leaves a trail.
installDebugLog();
vlog("boot", { view: new URLSearchParams(window.location.search).get("view") });
installBootTiming();
bootMark("boot");
// Flush whatever the previous (possibly frozen) session left behind to
// the current vault's .vault-chat/app-log.txt, and re-flush whenever the
// active vault changes so the trail lands in the right vault folder.
flushDebugLogToDisk(useStore.getState().vaultPath).catch(() => {});
useStore.subscribe((s, prev) => {
  if (s.vaultPath && s.vaultPath !== prev.vaultPath) {
    flushDebugLogToDisk(s.vaultPath).catch(() => {});
  }
});
// Periodic flush so the trail lands on disk *during* a long session, not only
// on boot/vault-switch. Without this, a supervisor cycle that runs while the
// app stays open (the common case for an overnight watch) never reaches
// app-log.txt until a restart — making a live failure undebuggable. No-ops when
// nothing is buffered, and app-log.txt is gitignored so it never churns git.
setInterval(() => {
  flushDebugLogToDisk(useStore.getState().vaultPath).catch(() => {});
}, 45_000);

const savedTheme = localStorage.getItem("vault_chat_theme");
document.documentElement.dataset.theme = savedTheme === "light" ? "light" : "graphite";
applyHljsTheme(savedTheme === "light" ? "light" : "graphite");

const view = new URLSearchParams(window.location.search).get("view");
const isPopout = view === "chat";
// Every native webview has its own document, listeners and delivery queue.
installLaptopPerf({ popout: isPopout });

if (isPopout) {
  installPopoutSync();
  // Popouts need their own copy of API keys — the main-window snapshot
  // broadcast doesn't include them, and without hydrate the chat
  // textarea stays disabled because activeKey is undefined.
  hydrateKeychain().catch((e) => console.warn("[keys] hydrate failed:", e));
} else {
  installMainSync();
  // Pull any existing API keys out of the OS keychain into the store,
  // migrating them out of legacy localStorage on the first run.
  hydrateKeychain().catch((e) => console.warn("[keys] hydrate failed:", e));
  // Durability safety net: periodic backstop + commit-on-quit so no vault
  // change can reach disk without reaching git. Main window only.
  installAutosaveNet();
  // What the screen did (client-events.jsonl) and the "something just went wrong" bundle
  // (Ctrl+Shift+D → .vault-chat/diag/). Main window only.
  installClientEvents();
  installAppLiveBridge();
  // Its errors and box drops on the box too (<state>/logs/app.jsonl).
  installAppShip();
  installDiagShortcut();
  // When Carl last touched the app: the gate's Drive-copy runs wait for him to be idle and stop when he starts.
  // Which build this launch runs, told to the box once the first screen is interactive (src/hostBuild.ts): a chat
  // waiting for a new laptop build is woken by it.
  void import("./hostBuild").then((m) => m.reportBuildAtLaunch()).catch(() => {});
  // A self-test launch (VC_SELFTEST in the environment, src-tauri/src/self_test.rs): run its steps in this window
  // and exit. Every other launch: the native side says no and nothing happens.
  void import("./selfTest").then((m) => m.startSelfTestIfAsked()).catch((e) => console.warn("[selftest]", e));
  // A core swap just loaded this bundle (src/coreSwap.ts): put the chat, its scroll, the draft and the panes back, then
  // show the screen (index.html kept it hidden). Nothing is loaded for it on an ordinary launch.
  try {
    if (sessionStorage.getItem("vc.coreSwap")) void import("./coreSwap").then((m) => m.restoreAfterSwap());
  } catch {
    /* no storage */
  }
  // The core bundle the box built from accepted main (src/coreFollow.ts): fetched and taken with no installer, once the
  // first screen is interactive (never on the launch path).
  void import("./laptopPerf")
    .then((m) => m.launchTiming(90_000))
    .then(() => import("./coreFollow"))
    .then((m) => m.startCoreFollow())
    .then(() => import("./serverSlotFollow"))
    .then((m) => m.startServerSlotFollow())
    .catch(() => {});
  // For a new user's installing agent (src/appStatus.ts, src-tauri/src/first_run.rs): the vault it picked opens on
  // the first launch, and the status file (`vault-chat --status`) says how far setup has got.
  void import("./appStatus")
    .then(async (m) => {
      await m.openSetupVault();
      // An install that already has a vault open ends its first run here: the tutorial never comes to it.
      const [{ firstRunSeed }, { useStore }] = await Promise.all([import("./openVault"), import("./store")]);
      void firstRunSeed(useStore.getState().vaultPath);
      m.installAppStatus();
    })
    .catch((e) => console.warn("[status]", e));
  // Reconcile "run in background" (always-on tray daemon) with the Rust
  // close-to-tray gate and the OS login item. Main window only; popouts must
  // never register autostart or hold the app alive on close.
  void initBackgroundMode();
  // Warm the editor chunk (Monaco, lazy in MarkdownView) once the first screen
  // is up, so the first code edit doesn't wait on it.
  void afterVaultReady(8000).then(() => {
    const warm = () => void import("./MonacoEditor").catch(() => {});
    if ("requestIdleCallback" in window) window.requestIdleCallback(warm, { timeout: 5000 });
    else setTimeout(warm, 1000);
  });
}

const Root = isPopout ? ChatWindow : App;

vlog("pre-render", { isPopout });
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
    {!isPopout && <LaptopReleaseHealthMount />}
  </React.StrictMode>,
);
vlog("post-render");

// Cold-start sequence:
//   1. The window is now created visible (tauri.conf.json visible:true),
//      with the splash + critical CSS covering the load so there's no
//      white flash. We no longer depend on a paint frame to *show* the
//      window — that dependency permanently hid the window on some
//      Linux/WebKit compositors that never delivered the first frame.
//   2. We still call `app_ready` (show+focus, idempotent) and fade the
//      splash. Fire it from React's first commit (two rAFs) for the
//      nicest timing, but ALSO from a setTimeout fallback so a stalled
//      compositor can't leave us stuck on the splash forever.
let revealed = false;
function reveal(via: string) {
  if (revealed) return;
  revealed = true;
  vlog("reveal", { via });
  bootMark("first paint", { via });
  invoke("app_ready").catch((e) => console.warn("[boot] app_ready:", e));
  // The core loader's ready handshake (src-tauri/src/core_loader.rs, src/coreFollow.ts): this bundle came up. A box-built
  // bundle that never says it within 30 s is replaced by the previous one, then the installed app's own.
  (window as { __vcCoreReady?: boolean }).__vcCoreReady = true;
  invoke("core_ready").catch(() => {});
  setTimeout(() => {
    const splash = document.getElementById("vault-splash");
    if (splash) {
      splash.classList.add("hidden");
      setTimeout(() => splash.remove(), 250);
    }
  }, 400);
}
requestAnimationFrame(() => {
  requestAnimationFrame(() => reveal("raf"));
});
// Fallback: if no paint frame arrives within 1.5s, reveal anyway so the
// splash never gets stuck on a compositor that isn't issuing rAFs.
setTimeout(() => reveal("timeout"), 1500);
