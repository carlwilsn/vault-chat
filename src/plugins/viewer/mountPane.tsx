// The viewer's pane as a part of app/viewer (`pane`): src/MarkdownView.tsx mounts it for each pane through the plugin
// host, with the pane's id as its props (api.props, src/pluginProps.ts). Its own React root: the pane's redraws (typing
// in the editor, a file switch) stay in it.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PluginApi } from "../../mountHost";
import { useProps, type PluginProps } from "../../pluginProps";
import { Pane } from "./Pane";

export type PaneProps = { paneId?: string };

function Bound({ props }: { props: PluginProps<PaneProps> }) {
  return <Pane {...useProps(props)} />;
}

export const pane = {
  mount(el: HTMLElement, api: PluginApi): () => void {
    const props = (api.props as PluginProps<PaneProps> | undefined) ?? { get: () => ({}), on: () => () => {} };
    let alive = true;
    // A render error the pane does not catch is the plugin's failure (src/MarkdownView.tsx then shows its fallback).
    const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
    // Drawn right after the app's commit, before the browser paints: the pane is never empty.
    queueMicrotask(() => alive && flushSync(() => root.render(<Bound props={props} />)));
    return () => {
      alive = false;
      queueMicrotask(() => root.unmount());
    };
  },
};
