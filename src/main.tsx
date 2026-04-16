import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import App from "./App";
import { ChatWindow } from "./ChatWindow";
import { installMainSync, installPopoutSync } from "./sync";

const savedTheme = localStorage.getItem("vault_chat_theme");
document.documentElement.dataset.theme = savedTheme === "light" ? "light" : "graphite";

const view = new URLSearchParams(window.location.search).get("view");
const isPopout = view === "chat";

if (isPopout) {
  installPopoutSync();
} else {
  installMainSync();
}

const Root = isPopout ? ChatWindow : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
