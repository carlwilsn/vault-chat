// A page that declares `<meta name="vc-mount" content="in-process">`, mounted in the app (src/mountHost.ts) where an
// iframe would otherwise be (the viewer, inline in a chat). Whatever the plugin throws becomes an error card in its
// own box (mountHost's boundary); this component's own render is behind a React boundary as well, so the pane or the
// chat around it always stands.
//
// AppPluginMount: a part of the app that is a plugin (src/appPlugins.ts; Stage 2), mounted from its module through the
// same host, and taken down or brought back by the supervisor's records like any page (usePluginDesired).
import { Component, useEffect, useMemo, useRef, type ReactNode } from "react";
import { hostTheme, mountPlugin, type AppPluginSource, type PluginHandle } from "./mountHost";
import type { AppPluginInfo } from "./appPlugins";
import { appHostBackend } from "./hostBackend";
import { usePluginDesired } from "./pluginSupervisorApp";

class PluginBoundary extends Component<{ path: string; children: ReactNode }, { failed: string | null }> {
  state = { failed: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { failed: String((err as Error)?.message ?? err) };
  }
  componentDidCatch(err: unknown) {
    console.warn("[plugin] host render failed:", this.props.path, err);
  }
  render() {
    if (this.state.failed !== null) {
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

function Mount({ html, path, className }: { html: string | AppPluginSource; path: string; className?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const handle = useRef<PluginHandle | null>(null);
  // A changed page (an edit, the agent's write) is a fresh mount: the old one's cleanup runs first.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = (handle.current = mountPlugin(el, html, { path, theme: () => hostTheme(), host: appHostBackend, onError: (m) => console.warn(`[plugin] ${path} stopped:`, m) }));
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

/** A part of the app that is a plugin: mounted while the supervisor says it runs; stopped, it is gone (nothing left). */
export function AppPluginMount({ plugin, module, code }: { plugin: Pick<AppPluginInfo, "id" | "name">; module?: unknown; code?: string }) {
  // One source object per module / code: a new one is a fresh mount (a changed vault plugin file), a re-render is not.
  const source = useMemo<AppPluginSource>(() => (typeof code === "string" ? { name: plugin.name, code } : { name: plugin.name, module }), [plugin.name, module, code]);
  const desired = usePluginDesired(plugin.id);
  if (desired.state === "stopped") return null;
  return (
    <PluginBoundary path={plugin.id} key={plugin.id}>
      <Mount html={source} path={plugin.id} />
    </PluginBoundary>
  );
}
