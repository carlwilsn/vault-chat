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
import { initMetaVault } from "./meta";
import { hydrateKeychain, hydratePersistedChat } from "./store";
import { installPhoneBridge } from "./phone-bridge";

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
  // Seed the meta vault with bundled defaults on first launch, and
  // surface its path for the settings UI + agent.ts. Silent no-op on
  // subsequent launches.
  initMetaVault().catch((e) => console.warn("[meta] init failed:", e));
  // Phone bridge: listen for incoming voice requests from the Rust
  // server and run them through the agent. Main window only — popouts
  // would otherwise duplicate every request.
  installPhoneBridge();
}

const Root = isPopout ? ChatWindow : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

// Hide the boot splash on the next paint after React mounts. One rAF
// ensures the first real frame has been committed, and a short delay
// gives CSS/layout one more tick so the fade-out looks smooth rather
// than snapping.
//
// At the same time, ask the OS to show the window (it was created
// hidden — main window in lib.rs setup(), popout in sync.ts — so the
// user only ever sees a fully painted frame).
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById("vault-splash");
    if (splash) {
      splash.classList.add("hidden");
      setTimeout(() => splash.remove(), 250);
    }
    invoke("app_ready").catch((e) => console.warn("[boot] app_ready:", e));
  });
});
