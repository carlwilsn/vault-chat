// A page that declares `<meta name="vc-mount" content="in-process">`, mounted in the app (src/mountHost.ts) where an
// iframe would otherwise be (the viewer, inline in a chat). Whatever the plugin throws becomes an error card in its
// own box (mountHost's boundary); this component's own render is behind a React boundary as well, so the pane or the
// chat around it always stands.
import { Component, useEffect, useRef, type ReactNode } from "react";
import { hostTheme, mountPlugin, type PluginHandle } from "./mountHost";

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

function Mount({ html, path, className }: { html: string; path: string; className?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const handle = useRef<PluginHandle | null>(null);
  // A changed page (an edit, the agent's write) is a fresh mount: the old one's cleanup runs first.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = (handle.current = mountPlugin(el, html, { path, theme: () => hostTheme(), onError: (m) => console.warn(`[plugin] ${path} stopped:`, m) }));
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
