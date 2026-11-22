// A viewer pane (the one viewer, or each pane of a split: src/MarkdownArea.tsx). The pane is a part of the viewer plugin
// (src/plugins/viewer/Pane.tsx, app/viewer, part `pane`): mounted through the plugin host and the supervisor's records
// (src/PluginMount.tsx AppPluginMount) with the pane's id as its props. The file Carl has open never just disappears:
//  - while the records are not known yet, or app/viewer is turned off, the same pane is drawn here in the app's own tree
//    (nothing flashes, nothing looks different; off, the agent cannot reach the viewer);
//  - failing to mount or render (the built-in copy too), a plain pane stands in: the file's text, read only, with one
//    line that says what happened and Reload.
import { memo } from "react";
import { VIEWER_PLUGIN } from "./appPlugins";
import { PlaceMount, type PluginFallbackInfo } from "./PluginMount";
import { placeModule } from "./places";
import * as viewerPlugin from "./plugins/viewer";
import { Pane } from "./plugins/viewer/Pane";
import { useStore } from "./store";

// The built-in module(s) of the places below (src/places.ts).
placeModule(VIEWER_PLUGIN, () => viewerPlugin.pane, "pane");

type Props = { paneId?: string };

export const MarkdownView = memo(function MarkdownView({ paneId }: Props) {
  return (
    <PlaceMount
      place="viewer.pane"
      props={paneId === undefined ? {} : { paneId }}
      fallback={(f) => (f.error === null ? <Pane paneId={paneId} /> : <PaneFallback info={f} paneId={paneId} />)}
    />
  );
});

/** The plain pane: the file's text, and why the viewer's pane is not there. */
export function PaneFallback({ info, paneId }: { info: PluginFallbackInfo; paneId?: string }) {
  const file = useStore((s) => (paneId ? s.panes.find((p) => p.id === paneId)?.file : s.currentFile) ?? null);
  const content = useStore((s) => (paneId ? s.panes.find((p) => p.id === paneId)?.content : s.currentContent) ?? "");
  return (
    <div className="h-full flex flex-col bg-background" data-el="viewer-pane-fallback" data-file={file ?? ""}>
      <div className="shrink-0 flex items-center gap-2 px-6 py-2.5 border-b border-border/60 text-[11px] text-muted-foreground">
        <span className="font-mono truncate flex-1 min-w-0">{file ? file.split("/").slice(-3).join(" › ") : "No file open"}</span>
        <span className="truncate" title={info.error ?? ""}>The viewer stopped; a plain view until it is back.</span>
        <button type="button" data-el="plugin-reload" onClick={info.retry} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground">
          Reload
        </button>
      </div>
      <pre className="flex-1 min-h-0 overflow-auto px-6 py-4 text-[12.5px] whitespace-pre-wrap break-words font-mono">{content}</pre>
    </div>
  );
}
