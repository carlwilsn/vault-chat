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
import "./monaco-setup";
// highlight.js theme stylesheets — loaded as URLs and swapped at runtime
// based on the active theme. Importing one as a side effect (the way it
// used to be) painted code blocks dark even in light mode.
import hljsDarkUrl from "highlight.js/styles/github-dark.css?url";
import hljsLightUrl from "highlight.js/styles/github.css?url";
import App from "./App";
import { ChatWindow } from "./ChatWindow";
import { installMainSync, installPopoutSync } from "./sync";
import {
  hydrateKeychain,
  hydratePersistedChat,
  maybeClearMessagesForVoiceV2,
  useStore,
} from "./store";
import { installDebugLog, flushDebugLogToDisk, vlog } from "./debugLog";
import { installAutosaveNet } from "./autosave";
import { startPhoneVoiceHost } from "./phoneVoice";

// Install the freeze diagnostic logger before anything else runs, so a
// crash during boot still leaves a trail.
installDebugLog();
vlog("boot", { view: new URLSearchParams(window.location.search).get("view") });
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

export function applyHljsTheme(theme: string) {
  let link = document.getElementById("vault-chat-hljs") as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = "vault-chat-hljs";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  link.href = theme === "light" ? hljsLightUrl : hljsDarkUrl;
}

const savedTheme = localStorage.getItem("vault_chat_theme");
document.documentElement.dataset.theme = savedTheme === "light" ? "light" : "graphite";
applyHljsTheme(savedTheme === "light" ? "light" : "graphite");

const view = new URLSearchParams(window.location.search).get("view");
const isPopout = view === "chat";

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
  // Restore chat from the previous session (HMR reload, crash, restart).
  hydratePersistedChat();
  // One-shot wipe of pre-ElevenLabs voice-mode chat history. Runs
  // once per install thanks to a localStorage flag, then no-ops.
  maybeClearMessagesForVoiceV2();
  // Durability safety net: periodic backstop + commit-on-quit so no vault
  // change can reach disk without reaching git. Main window only.
  installAutosaveNet();
  // Always-ready phone-voice host: the box keeps a token-guarded server up so a
  // phone can connect over Tailscale and talk live. Inert until a vault + EL key
  // exist. Main window only.
  void startPhoneVoiceHost();
}

const Root = isPopout ? ChatWindow : App;

vlog("pre-render", { isPopout });
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
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
  invoke("app_ready").catch((e) => console.warn("[boot] app_ready:", e));
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
