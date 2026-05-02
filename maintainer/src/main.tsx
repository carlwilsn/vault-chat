import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./style.css";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Mirror the main app's boot pattern: window starts hidden, we show
// it once React has committed its first frame, splash dot pulses for
// ~400ms then fades. See main app's main.tsx for the original
// rationale.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    invoke("app_ready").catch((e) => console.warn("[boot] app_ready:", e));
    setTimeout(() => {
      const splash = document.getElementById("vault-splash");
      if (splash) {
        splash.classList.add("hidden");
        setTimeout(() => splash.remove(), 250);
      }
    }, 400);
  });
});
