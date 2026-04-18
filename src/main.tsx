import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./monaco-setup";
import App from "./App";
import { ChatWindow } from "./ChatWindow";
import { installMainSync, installPopoutSync } from "./sync";
import { initMetaVault } from "./meta";
import { hydrateKeychain } from "./store";

const savedTheme = localStorage.getItem("vault_chat_theme");
document.documentElement.dataset.theme = savedTheme === "light" ? "light" : "graphite";

const view = new URLSearchParams(window.location.search).get("view");
const isPopout = view === "chat";

if (isPopout) {
  installPopoutSync();
} else {
  installMainSync();
  // Pull any existing API keys out of the OS keychain into the store,
  // migrating them out of legacy localStorage on the first run.
  hydrateKeychain().catch((e) => console.warn("[keys] hydrate failed:", e));
  // Seed the meta vault with bundled defaults on first launch, and
  // surface its path for the settings UI + agent.ts. Silent no-op on
  // subsequent launches.
  initMetaVault().catch((e) => console.warn("[meta] init failed:", e));
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
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById("vault-splash");
    if (splash) {
      splash.classList.add("hidden");
      setTimeout(() => splash.remove(), 250);
    }
  });
});
