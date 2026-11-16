// A page that declares `<meta name="vc-mount" content="in-process">`, mounted in the app (src/mountHost.ts) where an
// iframe would otherwise be (the viewer, inline in a chat). Whatever the plugin throws becomes an error card in its
// own box (mountHost's boundary); this component's own render is behind a React boundary as well, so the pane or the
// chat around it always stands.
//
// AppPluginMount: a part of the app that is a plugin (src/appPlugins.ts; Stage 2), mounted from its module through the
// same host, and taken down or brought back by the supervisor's records like any page (usePluginDesired). A core part
// that must always stand (the chat list) passes a `fallback`: turned off, or failing (its mount or render throwing), the
// fallback renders in its place instead of nothing or the error card, with what happened and a way back.
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Desired } from "./pluginSupervisor";
import { hostTheme, mountPlugin, type AppPluginSource, type PluginHandle } from "./mountHost";
import type { AppPluginInfo } from "./appPlugins";
import { appHostBackend } from "./hostBackend";
import { usePluginDesired } from "./pluginSupervisorApp";

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

function Mount({ html, path, className, onFailed }: { html: string | AppPluginSource; path: string; className?: string; onFailed?: (why: string) => void }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const handle = useRef<PluginHandle | null>(null);
  const failed = useRef(onFailed);
  failed.current = onFailed;
  // A changed page (an edit, the agent's write) is a fresh mount: the old one's cleanup runs first.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = (handle.current = mountPlugin(el, html, { path, theme: () => hostTheme(), host: appHostBackend, onError: (m) => {
      console.warn(`[plugin] ${path} stopped:`, m);
      failed.current?.(m);
    } }));
    return () => {
      h.unmount();
      if (handle.current === h) handle.current = null;
    };
  }, [html, path]);
  // The app's theme, live.
  useEffect(() => {
    const mo = new MutationObserver(() => handle.current?.setTheme(hostTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => mo.disconnect();
  }, []);
  // An app plugin adds no box of its own (a panel places itself).
  if (typeof html !== "string") return <span ref={ref} data-el="plugin-mount" data-vc-plugin={path} style={{ display: "contents" }} />;
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
 *  or, with a `fallback`, the fallback stands in (also when it fails). */
export function AppPluginMount({ plugin, module, code, fallback }: { plugin: Pick<AppPluginInfo, "id" | "name">; module?: unknown; code?: string; fallback?: (info: PluginFallbackInfo) => ReactNode }) {
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
      <Mount html={source} path={plugin.id} onFailed={onFailed} />
    </PluginBoundary>
  );
}
