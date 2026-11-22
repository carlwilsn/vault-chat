// A page that declares `<meta name="vc-mount" content="in-process">`, mounted in the app (src/mountHost.ts) where an
// iframe would otherwise be (the viewer, inline in a chat). Whatever the plugin throws becomes an error card in its
// own box (mountHost's boundary); this component's own render is behind a React boundary as well, so the pane or the
// chat around it always stands.
//
// AppPluginMount: a part of the app that is a plugin (src/appPlugins.ts; Stage 2), mounted from its module through the
// same host, and taken down or brought back by the supervisor's records like any page (usePluginDesired). A core part
// that must always stand (the chat list) passes a `fallback`: turned off, or failing (its mount or render throwing), the
// fallback renders in its place instead of nothing or the error card, with what happened and a way back.
//
// Props (src/pluginProps.ts): a part mounted with `props` (the Ctrl+K box's request, a viewer pane's pane) reads them as
// api.props.get() / api.props.on(fn), live: new props reach the mounted part without a remount.
//
// PlaceMount: a place of the app (src/places.ts PLACES) mounts the parts the table puts there, in order. The built-in
// modules are registered by the files that hold the places (src/places.ts placeModule).
import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Desired } from "./pluginSupervisor";
import { hostTheme, mountPlugin, type AppPluginSource, type PluginHandle } from "./mountHost";
import { APP_PLUGINS, type AppPluginInfo } from "./appPlugins";
import { appHostBackend } from "./hostBackend";
import { usePluginDesired } from "./pluginSupervisorApp";
import { PLACES, moduleKey, placeModuleOf } from "./places";
import { propsChannel, type PluginProps, type PropsChannel } from "./pluginProps";

export class PluginBoundary extends Component<{ path: string; children: ReactNode; onFailed?: (why: string) => void }, { failed: string | null }> {
  state = { failed: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { failed: String((err as Error)?.message ?? err) };
  }
  componentDidCatch(err: unknown) {
    console.warn("[plugin] host render failed:", this.props.path, err);
    this.props.onFailed?.(String((err as Error)?.message ?? err));
  }
  render() {
    if (this.state.failed !== null) {
      if (this.props.onFailed) return null;
      return (
        <span data-el="plugin-error" className="block m-2 rounded-md border border-destructive/50 bg-card px-3 py-2 text-[12.5px]">
          <b className="block">{this.props.path.split(/[\\/]/).pop()} stopped</b>
          <span className="block whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{this.state.failed}</span>
        </span>
      );
    }
    return this.props.children;
  }
}

/** Which copy of a vault plugin's slot a mount is (src/pluginDrafts.ts): its mount says so (data-vc-copy). */
export type CopyKind = "draft" | "live" | "prev";

function Mount({ html, path, className, onFailed, copy, props }: { html: string | AppPluginSource; path: string; className?: string; onFailed?: (why: string) => void; copy?: CopyKind; props?: PluginProps<unknown> }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const handle = useRef<PluginHandle | null>(null);
  const failed = useRef(onFailed);
  failed.current = onFailed;
  // A changed page (an edit, the agent's write) is a fresh mount: the old one's cleanup runs first.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const extend = props ? () => ({ props: { get: props.get, on: props.on } }) : undefined;
    const h = (handle.current = mountPlugin(el, html, { path, theme: () => hostTheme(), host: appHostBackend, extend, onError: (m) => {
      console.warn(`[plugin] ${path} stopped:`, m);
      failed.current?.(m);
    } }));
    return () => {
      h.unmount();
      if (handle.current === h) handle.current = null;
    };
  }, [html, path, props]);
  // The app's theme, live.
  useEffect(() => {
    const mo = new MutationObserver(() => handle.current?.setTheme(hostTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => mo.disconnect();
  }, []);
  // An app plugin adds no box of its own (a panel places itself).
  // A vault plugin's copy says which it is (data-vc-copy="live" / "draft"); a built-in part says nothing.
  if (typeof html !== "string") return <span ref={ref} data-el="plugin-mount" data-vc-plugin={path} data-vc-copy={copy} style={{ display: "contents" }} />;
  // A span (shown as a block): inline in a chat it sits inside the message's paragraph, as the iframe did.
  return <span ref={ref} data-el="plugin-mount" data-vc-plugin={path} className={["block", className].filter(Boolean).join(" ")} />;
}

export function PluginMount(props: { html: string; path: string; className?: string }) {
  return (
    <PluginBoundary path={props.path} key={props.path}>
      <Mount {...props} />
    </PluginBoundary>
  );
}

/** What a fallback is told: the plugin is turned off (`off`), or it failed (`error`, and `retry` mounts it afresh), or
 *  whether it runs is not known yet (`pending`: the records are still coming; show the plain list, no banner). */
export type PluginFallbackInfo = { off: Desired | null; error: string | null; pending: boolean; retry: () => void };

/** A part of the app that is a plugin: mounted while the supervisor says it runs; stopped, it is gone (nothing left),
 *  or, with a `fallback`, the fallback stands in (also when it fails). `code`: a vault plugin's code instead of a module. */
export function AppPluginMount({ plugin, module, code, props, fallback, copyKind }: { plugin: Pick<AppPluginInfo, "id" | "name">; module?: unknown; code?: string; props?: object; fallback?: (info: PluginFallbackInfo) => ReactNode; /** A vault plugin's code: which copy of its slot it is (its mount says so: data-vc-copy). */ copyKind?: CopyKind }) {
  // The props the place hands the part (api.props): one channel per mount, set after each of the place's renders.
  const channel = useRef<PropsChannel<unknown> | null>(null);
  if (props !== undefined && !channel.current) channel.current = propsChannel<unknown>(props);
  useLayoutEffect(() => {
    if (props !== undefined) channel.current?.set(props);
  });
  const propsApi = channel.current ?? undefined;
  // One source object per module / code: a new one is a fresh mount (a changed vault plugin file), a re-render is not.
  const source = useMemo<AppPluginSource>(() => (typeof code === "string" ? { name: plugin.name, code } : { name: plugin.name, module }), [plugin.name, module, code]);
  const desired = usePluginDesired(plugin.id);
  const [failed, setFailed] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const retry = () => {
    setFailed(null);
    setRun((n) => n + 1);
  };
  // Not known yet (the vault's on/off records not in): nothing is mounted, so a plugin turned off never flashes on;
  // a core part with a fallback shows its plain fallback meanwhile (`pending`), so its place is never empty.
  if (desired === null) return fallback ? <>{fallback({ off: null, error: null, pending: true, retry })}</> : null;
  if (desired.state === "stopped") return fallback ? <>{fallback({ off: desired, error: null, pending: false, retry })}</> : null;
  if (desired.state !== "running") return null;
  if (fallback && failed !== null) return <>{fallback({ off: null, error: failed, pending: false, retry })}</>;
  const onFailed = fallback ? setFailed : undefined;
  return (
    <PluginBoundary path={plugin.id} key={`${plugin.id}#${run}`} onFailed={onFailed}>
      <Mount html={source} path={plugin.id} onFailed={onFailed} props={propsApi} copy={copyKind} />
    </PluginBoundary>
  );
}

// ---------------------------------------------------------------- places (src/places.ts)

const infoCache = new Map<string, Pick<AppPluginInfo, "id" | "name">>();
function infoOf(id: string): Pick<AppPluginInfo, "id" | "name"> {
  let i = infoCache.get(id);
  if (!i) infoCache.set(id, (i = APP_PLUGINS.find((p) => p.id === id) ?? { id, name: id.slice(id.indexOf("/") + 1) }));
  return i;
}

/** A place of the app: the parts src/places.ts puts there, in order (`props` handed to each, the place's `fallback` to
 *  the first). A part this build has no module for is left out, with a warning. */
export function PlaceMount({ place, props, fallback }: { place: string; props?: object; fallback?: (info: PluginFallbackInfo) => ReactNode }) {
  let first = true;
  const out: ReactNode[] = [];
  for (const m of PLACES[place] ?? []) {
    const module = placeModuleOf(m);
    if (module === undefined) {
      console.warn(`[places] ${m.plugin}${m.part ? `#${m.part}` : ""} has no module in ${place}`);
      continue;
    }
    const fb = first ? fallback : undefined;
    first = false;
    out.push(<AppPluginMount key={moduleKey(m.plugin, m.part)} plugin={infoOf(m.plugin)} module={module} props={props} fallback={fb} />);
  }
  return <>{out}</>;
}
