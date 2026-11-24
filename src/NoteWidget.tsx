// A live widget inside a note (src/noteWidgets.ts): the viewer's rendered markdown draws a ```widget block as this,
// mounted in place through the in-process host (src/mountHost.ts) in its own shadow root. Nothing is read or run until
// the block comes near the view (a long note opens as fast as without widgets); a missing file, a file that is not a
// widget, or a widget that throws is a card in its place, and the note around it stands.
import { createContext, useContext, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { useStore } from "./store";
import { readTextAt } from "./boxFiles";
import { insideVault, parseLiveMount, vaultRelative } from "./liveBridge";
import { hostTheme, mountPlugin, type PluginHandle } from "./mountHost";
import { appHostBackend } from "./hostBackend";
import { usePluginDesired } from "./pluginSupervisorApp";
import { PluginBoundary } from "./PluginMount";
import { PluginOff } from "./PluginOff";
import { appPluginState, setAppPluginState, subscribeAppPluginState } from "./appPluginState";
import {
  NoteSource,
  WIDGET_MAX_BYTES,
  WIDGET_STATE_PREFIX,
  noteWidgetApi,
  widgetBlockOfPre,
  widgetCandidates,
  widgetInstanceId,
  widgetKind,
  widgetName,
  type StateStore,
} from "./noteWidgets";

/** The note being shown, for its widgets (MarkdownView provides it). Outside a note a widget block is plain code. */
export const NoteSourceContext = createContext<NoteSource | null>(null);

/** One NoteSource per note, its text kept current without re-rendering the widgets. */
export function useNoteSource(path: string | null, text: string): NoteSource | null {
  const ref = useRef<NoteSource | null>(null);
  if (path && (!ref.current || ref.current.path !== path)) ref.current = new NoteSource(path, text);
  useEffect(() => {
    ref.current?.set(text);
  }, [text]);
  return path ? ref.current : null;
}

const appState: StateStore = { read: appPluginState, write: setAppPluginState, subscribe: subscribeAppPluginState };
/** How near the view (px) a widget block is when it mounts. */
const NEAR = "600px 0px";
/** How often a mounted widget's file is looked at again (the agent edits it: it remounts with the new code). */
const RECHECK_MS = 3000;

type Found = { abs: string; rel: string; code: string; kind: "module" | "page" } | { error: string };

async function findWidget(note: string, src: string, vault: string | null): Promise<Found> {
  const kind = widgetKind(src);
  if (!src) return { error: "the block names no widget: put its path on the first line" };
  if (!kind) return { error: `${src} is not a widget: a .js or .mjs module exporting mount(el, api), or an in-process .html page` };
  const box = note.startsWith("box:");
  const tried = widgetCandidates(note, src, box ? null : vault);
  for (const abs of tried) {
    let code: string;
    try {
      code = await readTextAt(abs);
    } catch {
      continue;
    }
    if (code.length > WIDGET_MAX_BYTES) return { error: `${src} is over ${WIDGET_MAX_BYTES} bytes` };
    if (kind === "page" && parseLiveMount(code) !== "in-process") return { error: `${src} is a page without <meta name="vc-mount" content="in-process">` };
    const rel = !box && insideVault(abs, vault) ? vaultRelative(abs, vault) : abs;
    return { abs, rel, code, kind };
  }
  return { error: `widget not found: ${src}` };
}

function Card({ title, detail }: { title: string; detail: string }) {
  return (
    <div data-el="plugin-error" className="my-3 rounded-md border border-destructive/50 bg-card px-3 py-2 text-[12.5px] not-prose">
      <b className="block">{title}</b>
      <span className="block whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{detail}</span>
    </div>
  );
}

function Live({ found, src, text, source }: { found: Extract<Found, { code: string }>; src: string; text: string; source: NoteSource }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handle = useRef<PluginHandle | null>(null);
  const vault = useStore((s) => s.vaultPath);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Its place among the note's widgets (document order) and among the embeds of this same widget.
    const all = Array.from(host.closest("[data-note-widgets]")?.querySelectorAll<HTMLElement>('[data-el="note-widget"]') ?? []);
    const me = host.closest<HTMLElement>('[data-el="note-widget"]');
    const index = Math.max(0, me ? all.indexOf(me) : 0);
    const nth = all.slice(0, index + 1).filter((e) => e.dataset.src === src).length || 1;
    const noteRel = insideVault(source.path, vault) ? vaultRelative(source.path, vault) : source.path;
    const id = widgetInstanceId(noteRel, found.rel, nth);
    const name = found.kind === "module" ? widgetName(found.code, found.rel.split("/").pop() ?? src) : "";
    const h = (handle.current = mountPlugin(host, found.kind === "module" ? { name, code: found.code } : found.code, {
      path: id,
      shadow: true,
      theme: () => hostTheme(),
      host: appHostBackend,
      onError: (m) => console.warn(`[note widget] ${id} stopped:`, m),
      extend: (ctx) =>
        noteWidgetApi({ source, notePath: noteRel, index, widget: found.rel, blockText: text, stateId: WIDGET_STATE_PREFIX + id, store: appState }, ctx),
    }));
    return () => {
      h.unmount();
      if (handle.current === h) handle.current = null;
    };
  }, [found, src, text, source, vault]);
  useEffect(() => {
    const mo = new MutationObserver(() => handle.current?.setTheme(hostTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => mo.disconnect();
  }, []);
  return <div ref={hostRef} data-el="note-widget-host" data-vc-plugin={found.rel} />;
}

function NoteWidget({ src, text, source }: { src: string; text: string; source: NoteSource }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const vault = useStore((s) => s.vaultPath);
  const [near, setNear] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  // Nothing is read or run until the block comes near the view.
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") return setNear(true);
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { rootMargin: NEAR });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  // Find and read the widget, then look at its file again now and then: a changed file is a fresh mount.
  useEffect(() => {
    if (!near) return;
    let alive = true;
    let last: Found | null = null;
    const look = async () => {
      const f = await findWidget(source.path, src, vault);
      if (!alive) return;
      const same = last && ("error" in f ? "error" in last && last.error === f.error : "code" in last && last.abs === f.abs && last.code === f.code);
      if (same) return;
      last = f;
      setFound(f);
    };
    void look();
    const t = setInterval(() => void look(), RECHECK_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [near, src, source, vault]);
  const ok = found && "code" in found ? found : null;
  const desired = usePluginDesired(ok ? ok.rel : null);
  let body: ReactNode = null;
  if (found && "error" in found) body = <Card title={`${src || "widget"} could not be shown`} detail={found.error} />;
  else if (ok && desired?.state === "stopped") body = <PluginOff path={ok.rel} desired={desired} className="my-3 rounded-md border border-border/60" />;
  else if (ok && desired?.state === "running")
    body = (
      <PluginBoundary path={ok.rel}>
        <Live found={ok} src={src} text={text} source={source} />
      </PluginBoundary>
    );
  return (
    <div ref={ref} data-el="note-widget" data-src={src} data-state={found ? ("error" in found ? "error" : desired?.state ?? "pending") : near ? "loading" : "idle"} className="my-3" style={body ? undefined : { minHeight: "2.5em" }}>
      {body}
    </div>
  );
}

/** The viewer's `pre`: a ```widget block in a note is a live widget; every other block is as before. */
export function NotePre(props: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
  const { node, children, ...rest } = props;
  const source = useContext(NoteSourceContext);
  const block = source ? widgetBlockOfPre(node) : null;
  if (!block || !source) return <pre {...rest}>{children}</pre>;
  return <NoteWidget src={block.src} text={block.text} source={source} />;
}
