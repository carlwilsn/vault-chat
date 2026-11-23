// What the chat shows inline besides its rows' text: the live web pages (src/InlineWebPage.tsx) and the inline vault
// pages (src/InlineHtmlFrame.tsx). Each registers what it shows and its own controls while drawn, so app/chat-rows'
// inline state reads them and its inline action runs what its buttons do (report 28: they were the frames' own
// state). A change (it navigated, loaded, was resized, made larger, closed) tells the offers' watch.
export type InlineFrame = {
  id: string;
  kind: "web" | "html";
  state(): Record<string, unknown>;
  act: Record<string, (a: Record<string, unknown>) => unknown>;
};
const frames = new Map<string, InlineFrame>();
const fns = new Set<() => void>();

export function registerInlineFrame(f: InlineFrame): () => void {
  frames.set(f.id, f);
  inlineChanged();
  return () => {
    if (frames.get(f.id) === f) frames.delete(f.id);
    inlineChanged();
  };
}
export function inlineChanged(): void {
  for (const f of [...fns]) f();
}
export function onInlineChanged(fn: () => void): () => void {
  fns.add(fn);
  return () => void fns.delete(fn);
}
export const inlineFramesNow = () => [...frames.values()].map((f) => ({ id: f.id, kind: f.kind, ...f.state() }));
export function inlineAct(id: string, action: string, a: Record<string, unknown> = {}): unknown {
  const all = [...frames.values()];
  const f = frames.get(id) ?? (id ? undefined : all[all.length - 1]);
  if (!f) throw new Error(`no inline page "${id}" in the chat (inline: ${all.map((x) => x.id).join(", ") || "none"})`);
  const run = f.act[action];
  if (!run) throw new Error(`an inline ${f.kind === "web" ? "web page" : "vault page"} has no ${action} (it has: ${Object.keys(f.act).join(", ")})`);
  return run(a);
}
