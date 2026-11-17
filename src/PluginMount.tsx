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
// Live copies (src/appPluginLive.ts): an app plugin whose code is also in <vault>/.vault-chat/app-plugins runs that copy
// instead of the built-in module. Which copy is the records' fold (src/pluginDrafts.ts chooseCopy): a draft runs only
// while Carl tries it (Change ready, src/changeReady.ts) or once kept; else the version the last keep / switch landed;
// else the live copy. A copy turned off (a plugin.desired record for its vault path) is passed over; a copy that fails
// (load, mount or later) is passed over too, until its file changes, and why is written next to it; a draft that fails
// while tried discards itself, and a kept copy that fails while its keep is watched switches back by itself. The built-in module is the last copy; only its failure shows the fallback.
//
// Props (src/pluginProps.ts): a part mounted with `props` (the Ctrl+K box's request, a viewer pane's pane) reads them as
// api.props.get() / api.props.on(fn), live: new props reach the mounted part without a remount.
//
// PlaceMount: a place of the app (src/appPreset.ts PRESET_PLACES) mounts what the preset in effect puts there, in order;
// the core does not name the plugin. The built-in modules are registered by the files that hold the places
// (src/presetApp.ts placeModule); a mount naming a part this app has none of is skipped with a visible line. A
// plugin's settings in the preset reach it as api.settings.get() / api.settings.on(fn).
import { Component, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Desired } from "./pluginSupervisor";
import { hostTheme, mountPlugin, type AppPluginSource, type LoadModule, type PluginHandle } from "./mountHost";
import { APP_PLUGINS, type AppPluginInfo } from "./appPlugins";
import { presetPlace, type PresetMount } from "./appPreset";
import { appPluginFolder, liveCopyId, type LiveCopyKind } from "./appPluginLive";
import { liveLoader, reportLiveFailure, useLiveCopies } from "./appPluginLiveHost";
import { appHostBackend } from "./hostBackend";
import { supervisorChangesNow, usePluginDesired, useSupervisorVersion } from "./pluginSupervisorApp";
import { moduleKey, placeModuleOf, skippedWhy, usePreset } from "./presetApp";
import { chooseCopy, versionOf } from "./pluginDrafts";
import { autoDiscard, autoRevert, useTried } from "./changeReady";
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

function Mount({ html, path, className, onFailed, load, copy, props, settings }: { html: string | AppPluginSource; path: string; className?: string; onFailed?: (why: string) => void; load?: LoadModule; copy?: LiveCopyKind; props?: PluginProps<unknown>; settings?: PluginProps<unknown> }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const handle = useRef<PluginHandle | null>(null);
  const failed = useRef(onFailed);
  failed.current = onFailed;
  // A changed page (an edit, the agent's write) is a fresh mount: the old one's cleanup runs first.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const extend = props || settings ? () => ({ ...(props ? { props: { get: props.get, on: props.on } } : {}), ...(settings ? { settings: { get: settings.get, on: settings.on } } : {}) }) : undefined;
    const h = (handle.current = mountPlugin(el, html, { path, theme: () => hostTheme(), host: appHostBackend, load, extend, onError: (m) => {
      console.warn(`[plugin] ${path} stopped:`, m);
      failed.current?.(m);
    } }));
    return () => {
      h.unmount();
      if (handle.current === h) handle.current = null;
    };
  }, [html, path, load, props, settings]);
  // The app's theme, live.
  useEffect(() => {
    const mo = new MutationObserver(() => handle.current?.setTheme(hostTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => mo.disconnect();
  }, []);
  // An app plugin adds no box of its own (a panel places itself).
  // A live copy says which it is (data-vc-copy="live" / "draft"); the built-in one says nothing.
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
 *  or, with a `fallback`, the fallback stands in (also when it fails). Its live copy, when the vault has one, runs
 *  instead of `module` (`part`: the export of the copy that is this mount, as `module` is the built-in one's). */
export function AppPluginMount({ plugin, module, code, part, props, settings, fallback }: { plugin: Pick<AppPluginInfo, "id" | "name">; module?: unknown; code?: string; part?: string; props?: object; settings?: Record<string, unknown>; fallback?: (info: PluginFallbackInfo) => ReactNode }) {
  // The props the place hands the part (api.props): one channel per mount, set after each of the place's renders.
  const channel = useRef<PropsChannel<unknown> | null>(null);
  if (props !== undefined && !channel.current) channel.current = propsChannel<unknown>(props);
  useLayoutEffect(() => {
    if (props !== undefined) channel.current?.set(props);
  });
  const propsApi = channel.current ?? undefined;
  // Its settings in the preset (api.settings), live like props; none (the daily preset): no channel.
  const settingsChannel = useRef<PropsChannel<unknown> | null>(null);
  if (settings !== undefined && !settingsChannel.current) settingsChannel.current = propsChannel<unknown>(settings);
  useLayoutEffect(() => {
    if (settings !== undefined) settingsChannel.current?.set(settings);
  });
  const settingsApi = settings !== undefined ? (settingsChannel.current ?? undefined) : undefined;
  // One source object per module / code: a new one is a fresh mount (a changed vault plugin file), a re-render is not.
  const source = useMemo<AppPluginSource>(() => (typeof code === "string" ? { name: plugin.name, code } : { name: plugin.name, module }), [plugin.name, module, code]);
  const desired = usePluginDesired(plugin.id);
  const [failed, setFailed] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  // The live copies: only for an app plugin's built-in module (a vault plugin's code is already live).
  const folder = code === undefined ? appPluginFolder(plugin.id) : null;
  const copies = useLiveCopies(folder ? plugin.id : "");
  const draftOn = usePluginDesired(folder ? liveCopyId(folder, "draft") : null);
  const liveOn = usePluginDesired(folder ? liveCopyId(folder, "live") : null);
  const prevOn = usePluginDesired(folder ? liveCopyId(folder, "prev") : null);
  const tried = useTried(folder ? plugin.id : null);
  useSupervisorVersion();
  // A copy that failed, by the code that failed: passed over until its file changes (or Reload).
  const [broken, setBroken] = useState<Partial<Record<LiveCopyKind, string>>>({});
  const choice = folder ? chooseCopy(copies, supervisorChangesNow(plugin.id), tried) : null;
  const on: Record<LiveCopyKind, Desired | null> = { draft: draftOn, live: liveOn, prev: prevOn };
  const usable = (kind: LiveCopyKind | null | undefined): kind is LiveCopyKind => !!kind && copies[kind] !== undefined && on[kind]?.state !== "stopped" && broken[kind] !== copies[kind];
  let kind: LiveCopyKind | null = choice?.kind ?? null;
  if (kind && !usable(kind)) kind = kind !== "live" && choice?.why !== "landed" && usable("live") ? "live" : null;
  const copy = kind ? { kind, code: copies[kind]! } : null;
  const isTried = kind === "draft" && choice?.why === "tried";
  const copySource = useMemo<AppPluginSource | null>(() => (copy ? { name: plugin.name, code: copy.code, ...(part ? { part } : {}) } : null), [plugin.name, copy?.code, part]);
  const copyLoad = useMemo(() => liveLoader(plugin.id), [plugin.id]);
  const retry = () => {
    setFailed(null);
    setBroken({});
    setRun((n) => n + 1);
  };
  // Not known yet (the vault's on/off records not in): nothing is mounted, so a plugin turned off never flashes on;
  // a core part with a fallback shows its plain fallback meanwhile (`pending`), so its place is never empty.
  if (desired === null) return fallback ? <>{fallback({ off: null, error: null, pending: true, retry })}</> : null;
  if (desired.state === "stopped") return fallback ? <>{fallback({ off: desired, error: null, pending: false, retry })}</> : null;
  if (desired.state !== "running") return null;
  if (copy && copySource) {
    const { kind, code: bad } = copy;
    const onCopyFailed = (why: string) => {
      console.warn(`[plugin] ${plugin.id}: its ${kind} copy failed, the next copy runs:`, why);
      setBroken((b) => ({ ...b, [kind]: bad }));
      void reportLiveFailure(plugin.id, kind, bad, why);
      // Tried and failed: the draft discards itself (Carl's windows fall back, the notice says why).
      if (tried && isTried) autoDiscard(plugin.id, tried, `it stopped: ${why}`);
      // Kept not long ago and failed: it switches back by itself (src/changeReady.ts autoRevert).
      else autoRevert(plugin.id, versionOf(bad), `it stopped: ${why}`);
    };
    return (
      <PluginBoundary path={plugin.id} key={`${plugin.id}#${run}#${kind}`} onFailed={onCopyFailed}>
        <Mount html={copySource} path={plugin.id} onFailed={onCopyFailed} load={copyLoad} copy={kind} props={propsApi} settings={settingsApi} />
      </PluginBoundary>
    );
  }
  if (fallback && failed !== null) return <>{fallback({ off: null, error: failed, pending: false, retry })}</>;
  const onFailed = fallback ? setFailed : undefined;
  return (
    <PluginBoundary path={plugin.id} key={`${plugin.id}#${run}`} onFailed={onFailed}>
      <Mount html={source} path={plugin.id} onFailed={onFailed} props={propsApi} settings={settingsApi} />
    </PluginBoundary>
  );
}

// ---------------------------------------------------------------- places (src/appPreset.ts)

const infoCache = new Map<string, Pick<AppPluginInfo, "id" | "name">>();
function infoOf(id: string): Pick<AppPluginInfo, "id" | "name"> {
  let i = infoCache.get(id);
  if (!i) infoCache.set(id, (i = APP_PLUGINS.find((p) => p.id === id) ?? { id, name: id.slice(id.indexOf("/") + 1) }));
  return i;
}

const noRetry = () => {};

/** A place of the app: what the preset in effect mounts there, in order (`props` handed to each, the place's
 *  `fallback` to the first it mounts). Left empty by the preset, the fallback stands in, as for a plugin turned off.
 *  A mount naming a part this app has none of is skipped with a line saying so. */
export function PlaceMount({ place, props, fallback }: { place: string; props?: object; fallback?: (info: PluginFallbackInfo) => ReactNode }) {
  const { preset } = usePreset();
  const mounts = presetPlace(preset, place);
  let first = true;
  const out = mounts.map((m: PresetMount) => {
    const why = skippedWhy(m, preset);
    if (why) return <PresetSkipped key={moduleKey(m.plugin, m.part)} why={why} />;
    const fb = first ? fallback : undefined;
    first = false;
    return <AppPluginMount key={moduleKey(m.plugin, m.part)} plugin={infoOf(m.plugin)} module={placeModuleOf(m)} part={m.part} props={props} settings={preset.settings?.[m.plugin]} fallback={fb} />;
  });
  if (first && fallback) {
    const off: Desired = { state: "stopped", by: "preset", reason: `not in the preset "${preset.name}"`, seq: 0, next: null };
    out.push(<Fragment key="#fallback">{fallback({ off, error: null, pending: false, retry: noRetry })}</Fragment>);
  }
  return <>{out}</>;
}

function PresetSkipped({ why }: { why: string }) {
  useEffect(() => console.warn(`[preset] ${why}`), [why]);
  return (
    <div data-preset-skipped="" className="px-2 py-1 text-xs text-muted-foreground" title={why}>
      {why}
    </div>
  );
}
