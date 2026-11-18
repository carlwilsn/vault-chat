// Where a viewer opens the Ctrl+K / Ctrl+L box. The box is a plugin (src/plugins/ask, app/ask; part `prompt`), mounted
// through the plugin host and the supervisor's records (src/PluginMount.tsx AppPluginMount) with the viewer's request,
// editable, onAccept and onCancel as its props (src/pluginProps.ts), so a live copy of app/ask runs instead of the
// built-in one. Carl's question never just disappears:
//  - while the records are not known yet, or app/ask is turned off, the same box is drawn here in the app's own tree
//    (nothing looks different; off, the agent cannot reach it);
//  - failing to mount or render (the built-in copy too), a plain box says so, with Reload and Close.
import { createPortal } from "react-dom";
import { ASK_PLUGIN } from "./appPlugins";
import { PlaceMount, type PluginFallbackInfo } from "./PluginMount";
import { placeModule } from "./presetApp";
import * as askPlugin from "./plugins/ask";
import { AskPrompt, type AskPromptProps } from "./plugins/ask/Prompt";
import { shortcutHint } from "./shortcuts";

// The built-in module(s) the preset can mount (src/appPreset.ts; the daily preset puts them in the places below).
placeModule(ASK_PLUGIN, () => askPlugin.prompt, "prompt");

export type { InlineEditAnchor, InlineEditRequest, PdfContext } from "./plugins/ask/view";

export function InlineEditPrompt(props: AskPromptProps) {
  return (
    <PlaceMount
      place="ask.prompt"
      props={props}
      fallback={(f) => (f.error === null ? <AskPrompt {...props} /> : <AskFallback info={f} props={props} />)}
    />
  );
}

/** The plain box: why the Ctrl+K box is not there, Reload and Close. */
export function AskFallback({ info, props }: { info: PluginFallbackInfo; props: AskPromptProps }) {
  const a = props.request.anchor;
  return createPortal(
    <div
      data-el="ask-fallback"
      className="fixed z-50 w-[360px] rounded-lg border border-border bg-popover px-3 py-2 shadow-xl text-[12.5px] flex items-center gap-2"
      style={{ left: Math.max(8, Math.min(a.left, window.innerWidth - 368)), top: Math.max(8, Math.min(a.bottom + 6, window.innerHeight - 60)) }}
    >
      <span className="flex-1 min-w-0 truncate text-muted-foreground" title={info.error ?? ""}>The {shortcutHint("edit.inline")} box stopped.</span>
      <button type="button" data-el="plugin-reload" onClick={info.retry} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground">
        Reload
      </button>
      <button type="button" data-el="ask-fallback-close" onClick={props.onCancel} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground">
        Close
      </button>
    </div>,
    document.body,
  );
}
