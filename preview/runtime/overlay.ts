// The preview's own toasts, drawn in a shadow root so they never touch the
// app's styles: "not faked: <cmd>" for a backend gap, "refused" for an outbound
// request. Each report also goes to the harness shell (postMessage) and to
// window.__preview.reports for tests. `?overlay=0` hides them (recordings).

export type ReportKind = "unfaked" | "refused" | "error" | "info";
export const reports: Array<{ at: number; kind: ReportKind; text: string }> = [];

let root: ShadowRoot | null = null;
let hidden = false;
const seen = new Set<string>();

export function setOverlayHidden(h: boolean): void {
  hidden = h;
}

function ensureRoot(): ShadowRoot | null {
  if (root) return root;
  if (!document.body) return null;
  const host = document.createElement("div");
  host.id = "vc-preview-overlay";
  host.style.cssText = "position:fixed;left:10px;bottom:10px;z-index:2147483647;pointer-events:none";
  document.body.appendChild(host);
  root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    .t{font:12px/1.35 ui-monospace,Consolas,monospace;color:#fff;border-radius:6px;padding:6px 10px;margin-top:6px;
       max-width:520px;box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:auto;cursor:pointer;word-break:break-all}
    .unfaked{background:#8a5a00}.refused{background:#a01818}.error{background:#5a1a6a}.info{background:#234}
    b{font-weight:600;margin-right:6px}
  </style><div id="s"></div>`;
  return root;
}

export function report(kind: ReportKind, text: string): void {
  reports.push({ at: Date.now(), kind, text });
  try {
    window.parent?.postMessage({ source: "vc-preview", type: "report", kind, text, href: location.href }, "*");
  } catch {
    /* no parent */
  }
  if (hidden) return;
  const key = `${kind}:${text}`;
  if (seen.has(key)) return;
  seen.add(key);
  const show = () => {
    const r = ensureRoot();
    if (!r) return void setTimeout(show, 50);
    const el = document.createElement("div");
    el.className = `t ${kind}`;
    const label = kind === "unfaked" ? "not faked:" : kind === "refused" ? "refused:" : kind === "error" ? "error:" : "preview:";
    el.innerHTML = `<b></b><span></span>`;
    el.querySelector("b")!.textContent = label;
    el.querySelector("span")!.textContent = text;
    el.title = "click to dismiss";
    el.onclick = () => el.remove();
    r.getElementById("s")!.appendChild(el);
    setTimeout(() => el.remove(), kind === "info" ? 4000 : 12000);
  };
  show();
}
