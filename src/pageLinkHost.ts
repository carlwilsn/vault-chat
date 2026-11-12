// A live page at its own link (/p/<id>/, server/pageLink.ts): this script is the host there, as the app and the phone are
// elsewhere. The same bridge (src/liveBridge.ts: grant, token, gateway), with a plain same-origin POST to the box: the
// request arrives through `tailscale serve`, which names Carl, so it needs no token of its own.
// Bundled into the box as "vc:page-link-host" (server/pageLinkHostGen.mjs) and inlined into the link's shell.
import { installLiveBridge, LIVE_ATTR, PLUGIN_STOPPED_EVENT } from "./liveBridge";
import { offLine, Reconciler, Supervisor, type Desired, type SupervisorRecord } from "./pluginSupervisor";

const root = document.documentElement;
const vault = root.dataset.vcVault ?? "";
const withVault = (path: string) => (vault ? `${path}${path.includes("?") ? "&" : "?"}vault=${encodeURIComponent(vault)}` : path);

// The app's light or dark theme, from the device's (the bridge passes the change on to the page).
const light = window.matchMedia?.("(prefers-color-scheme: light)");
const follow = () => root.setAttribute("data-theme", light?.matches ? "light" : "dark");
follow();
light?.addEventListener?.("change", follow);

installLiveBridge({
  async post(path, body) {
    const r = await fetch(withVault(path), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  },
});

// The supervisor's reconciler (change 1.6, src/pluginSupervisor.ts): the page's frame comes down when the plugin is
// stopped and goes back (a fresh start) when it runs again.
const tpl = document.querySelector<HTMLTemplateElement>("template[data-vc-page]");
let frame = document.querySelector<HTMLIFrameElement>(`body > iframe[${LIVE_ATTR}]`);
const proto = (frame ?? tpl?.content.querySelector<HTMLIFrameElement>(`iframe[${LIVE_ATTR}]`))?.cloneNode(false) as HTMLIFrameElement | undefined;
const plugin = proto?.getAttribute(LIVE_ATTR) ?? "";
let off: HTMLElement | null = null;

function reconcile(d: Desired): void {
  if (!proto) return;
  if (d.state === "stopped") {
    if (frame) {
      window.dispatchEvent(new CustomEvent(PLUGIN_STOPPED_EVENT, { detail: { plugin } }));
      frame.remove();
      frame = null;
    }
    if (!off) {
      off = document.createElement("div");
      off.setAttribute("data-el", "plugin-off");
      off.style.cssText = "display:flex;gap:10px;align-items:center;padding:12px 14px;font:13px/1.45 system-ui,sans-serif;color:hsl(var(--muted-foreground))";
      const line = document.createElement("span");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Turn on";
      btn.setAttribute("data-el", "plugin-turn-on");
      btn.style.cssText = "font:inherit;padding:2px 10px;border-radius:6px;border:1px solid hsl(var(--border));background:transparent;color:inherit;cursor:pointer";
      btn.onclick = () => void fetch(withVault("/api/v2/supervisor"), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plugin, state: "running" }) });
      off.append(line, btn);
      document.body.prepend(off);
    }
    off.firstElementChild!.textContent = offLine(plugin, d);
    return;
  }
  off?.remove();
  off = null;
  if (!frame) {
    frame = proto.cloneNode(false) as HTMLIFrameElement;
    document.body.prepend(frame);
  }
}

if (proto) {
  const sup = new Supervisor();
  const rec = new Reconciler(sup);
  rec.watch(plugin, reconcile);
  if (!frame) reconcile({ state: "stopped", by: null, reason: null, seq: 0, next: null });
  void (async () => {
    let after: number | null = null;
    for (;;) {
      try {
        const r: Response = await fetch(withVault(`/api/v2/supervisor${after === null ? "" : `?after=${after}&wait=20000`}`), { credentials: "same-origin" });
        if (r.status === 404) return; // a box from before the supervisor
        const j: { seq?: unknown; records?: unknown[] } = await r.json();
        for (const x of j.records ?? []) sup.fold(x as SupervisorRecord);
        after = Number(j.seq) || 0;
        rec.changed();
        // The first answer decides, whatever the shell was served as.
        reconcile(rec.desired(plugin));
      } catch {
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
  })();
}
