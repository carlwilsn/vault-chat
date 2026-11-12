// A live page at its own link (/p/<id>/, server/pageLink.ts): this script is the host there, as the app and the phone are
// elsewhere. The same bridge (src/liveBridge.ts: grant, token, gateway), with a plain same-origin POST to the box: the
// request arrives through `tailscale serve`, which names Carl, so it needs no token of its own.
// Bundled into the box as "vc:page-link-host" (server/pageLinkHostGen.mjs) and inlined into the link's shell.
import { installLiveBridge } from "./liveBridge";

const root = document.documentElement;
const vault = root.dataset.vcVault ?? "";

// The app's light or dark theme, from the device's (the bridge passes the change on to the page).
const light = window.matchMedia?.("(prefers-color-scheme: light)");
const follow = () => root.setAttribute("data-theme", light?.matches ? "light" : "dark");
follow();
light?.addEventListener?.("change", follow);

installLiveBridge({
  async post(path, body) {
    const url = vault ? `${path}${path.includes("?") ? "&" : "?"}vault=${encodeURIComponent(vault)}` : path;
    const r = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  },
});
