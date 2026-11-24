// [mock] The desktop shell's native web views (src-tauri/src/web_embed.rs) in the preview: the real chat code
// (src/InlineWebPage.tsx) asks for a view and moves it as it scrolls; here the "native view" is a fixed box drawn
// over the page at exactly the bounds the chat sends (outlined, labelled), showing a local stand-in page (the
// preview's network wall loads no real site). It reports load/title events the way web_embed.rs does, so the title
// bar, Back/Forward/Reload, Full window, Close and the hide-when-covered rule run for real.
import { emitFromBackend } from "../ipc";
import { report } from "../overlay";

type View = { box: HTMLDivElement; frame: HTMLIFrameElement; history: string[]; at: number };
const views = new Map<string, View>();
// A native view is not part of the page's DOM, so the chat's "is something lying over it" probe
// (document.elementFromPoint) sees through it to the placeholder; the stand-in box must be see-through to that probe too.
const nativeFromPoint = document.elementFromPoint.bind(document);
document.elementFromPoint = (x: number, y: number) => {
  const boxes = [...views.values()].map((v) => v.box);
  for (const b of boxes) b.style.pointerEvents = "none";
  try { return nativeFromPoint(x, y); } finally { for (const b of boxes) b.style.pointerEvents = ""; }
};
export const webEmbedCalls: { cmd: string; args: Record<string, unknown> }[] = [];

function pageFor(url: string): string {
  const u = new URL(url);
  const n = Number(u.searchParams.get("p") ?? "1");
  const links = [1, 2, 3].filter((k) => k !== n).map((k) => `<p><a href="${u.origin}${u.pathname}?p=${k}">Read part ${k}</a></p>`).join("");
  const paras = Array.from({ length: 14 }, (_, i) => `<p>Paragraph ${i + 1} of part ${n}. A stand-in for ${u.host}: the real app shows the live site in a native browser view at these bounds.</p>`).join("");
  return `<!doctype html><html><head><title>Part ${n} · ${u.host}</title><style>body{font:15px/1.6 Georgia,serif;max-width:640px;margin:24px auto;padding:0 16px;color:#222;background:#fffdf8}h1{font-size:24px}a{color:#0b5fff}</style></head><body><h1>${u.host} — part ${n}</h1>${links}${paras}${links}</body></html>`;
}

function load(id: string, v: View, url: string, push: boolean) {
  if (push) { v.history = v.history.slice(0, v.at + 1); v.history.push(url); v.at = v.history.length - 1; }
  emitFromBackend("web-embed", { id, kind: "load", url, loading: true });
  v.frame.srcdoc = pageFor(url);
  v.frame.onload = () => {
    const doc = v.frame.contentDocument;
    emitFromBackend("web-embed", { id, kind: "load", url, loading: false });
    emitFromBackend("web-embed", { id, kind: "title", title: doc?.title ?? "" });
    // Links navigate inside the view, as a real browser view does.
    doc?.addEventListener("click", (e) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a) return;
      e.preventDefault();
      load(id, v, (a as HTMLAnchorElement).href, true);
    });
  };
}

function place(v: View, a: Record<string, any>) {
  Object.assign(v.box.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${a.width}px`, height: `${a.height}px`, display: a.visible ? "block" : "none" });
}

export const webEmbedCommands: Record<string, (a: Record<string, any>) => unknown> = {
  web_embed_open: (a) => {
    webEmbedCalls.push({ cmd: "web_embed_open", args: a });
    const old = views.get(a.id);
    if (old) { place(old, a); return null; }
    const box = document.createElement("div");
    box.dataset.el = "mock-native-view";
    // Above everything, like a native child window; pointer events reach it, as clicks reach the real view.
    Object.assign(box.style, { position: "fixed", zIndex: "2147483647", outline: "2px dashed #e5484d", background: "#fff", overflow: "hidden" });
    const tag = document.createElement("div");
    tag.textContent = "native view (preview stand-in)";
    Object.assign(tag.style, { position: "absolute", right: "4px", bottom: "4px", font: "10px system-ui", background: "#e5484d", color: "#fff", padding: "1px 4px", borderRadius: "3px", pointerEvents: "none" });
    const frame = document.createElement("iframe");
    Object.assign(frame.style, { width: "100%", height: "100%", border: "0", display: "block" });
    box.append(frame, tag);
    document.body.append(box);
    const v: View = { box, frame, history: [], at: -1 };
    views.set(a.id, v);
    place(v, a);
    load(a.id, v, String(a.url), true);
    return null;
  },
  web_embed_place: (a) => {
    webEmbedCalls.push({ cmd: "web_embed_place", args: a });
    const v = views.get(a.id);
    if (v) place(v, a);
    return null;
  },
  web_embed_go: ({ id, action, url }) => {
    webEmbedCalls.push({ cmd: "web_embed_go", args: { id, action } });
    const v = views.get(id);
    if (!v) throw "no such inline page";
    if (action === "back" && v.at > 0) { v.at--; load(id, v, v.history[v.at]!, false); }
    else if (action === "forward" && v.at < v.history.length - 1) { v.at++; load(id, v, v.history[v.at]!, false); }
    else if (action === "reload") load(id, v, v.history[v.at]!, false);
    else if (action === "load" && url) load(id, v, url, true);
    return null;
  },
  web_embed_url: ({ id }) => {
    const v = views.get(id);
    if (!v) throw "no such inline page";
    return v.history[v.at];
  },
  web_embed_close: ({ id }) => {
    webEmbedCalls.push({ cmd: "web_embed_close", args: { id } });
    for (const [k, v] of views) {
      if (id && k !== id) continue;
      v.box.remove();
      views.delete(k);
      emitFromBackend("web-embed", { id: k, kind: "gone" });
    }
    if (!id) report("info", "web_embed_close: every native view in this window closed (the chat started over)");
    return null;
  },
};
