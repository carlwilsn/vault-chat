// Where the voice controls are drawn. Voice is a plugin (src/plugins/voice, app/voice): while it runs, its controls
// (the title bar's mic and waves, the composer's Mute, fullscreen chat's waves) are registered here by its mount and
// drawn by the title bar and the composer in their places through these components. The call itself is core (src/voiceCall.ts), so voice never just
// stops working:
//  - while the records are not known yet, or the plugin has not drawn yet, the built-in controls are drawn
//    (./plugins/voice/Controls.tsx, the same code the built-in plugin registers: nothing flashes);
//  - turned off, or failing (its mount, or one of its controls throwing), plain controls stand in: a mic that starts and
//    ends the call (Ctrl+D), Mute while a call is live (Ctrl+Shift+M), "Voice on" where the waves were.
import { Component, createElement, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { Mic, MicOff } from "lucide-react";
import { useStore } from "./store";
import { VOICE_PLUGIN_ID } from "./appPlugins";
import { usePluginDesired } from "./pluginSupervisorApp";
import { toggleVoice, toggleVoiceMute } from "./voiceCall";
import { isPopout } from "./windowKind";
import * as builtin from "./plugins/voice/Controls";
import { shortcutHint } from "./shortcuts";

export type VoicePartName = "cockpit" | "mic" | "mute" | "inlineWaves";
export type VoicePartSet = Partial<Record<VoicePartName, ComponentType>>;

type Reg = { parts: VoicePartSet | null; onError: ((e: unknown) => void) | null; failed: string | null; fns: Set<() => void>; v: number };
const KEY = "__vcVoiceParts";
function reg(): Reg {
  const g = globalThis as Record<string, unknown>;
  return ((g[KEY] as Reg | undefined) ??= { parts: null, onError: null, failed: null, fns: new Set(), v: 0 });
}
function changed(r: Reg): void {
  r.v++;
  for (const f of [...r.fns]) f();
}
const subscribe = (fn: () => void) => {
  const r = reg();
  r.fns.add(fn);
  return () => void r.fns.delete(fn);
};
const version = () => reg().v;

/** The voice plugin's mount registers its controls (and how one's throw is reported); the undo. */
export function registerVoiceParts(parts: VoicePartSet, onError: (e: unknown) => void): () => void {
  const r = reg();
  r.parts = parts;
  r.onError = onError;
  r.failed = null;
  changed(r);
  return () => {
    if (r.parts !== parts) return;
    r.parts = null;
    r.onError = null;
    changed(r);
  };
}

/** The plugin failed (its mount or a control): plain controls until it runs again. Null: it runs again. */
export function setVoicePartsFailed(why: string | null): void {
  const r = reg();
  if (r.failed === why) return;
  r.failed = why;
  changed(r);
}

/** Which controls draw now: "plugin" (the plugin's), "builtin" (not known yet / not drawn yet) or "plain" (off or failed). */
export function voicePartsSource(desired: { state: string } | null): "plugin" | "builtin" | "plain" {
  const r = reg();
  if (desired?.state === "stopped" || r.failed !== null) return "plain";
  return r.parts ? "plugin" : "builtin";
}

class PartBoundary extends Component<{ children: ReactNode; plain: ReactNode; onError: (e: unknown) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    console.warn("[voice] a control failed; the plain one stands in:", e);
    this.props.onError(e);
  }
  render() {
    return this.state.failed ? this.props.plain : this.props.children;
  }
}

function Part({ name, plain }: { name: VoicePartName; plain: () => ReactNode }) {
  useSyncExternalStore(subscribe, version, version);
  const desired = usePluginDesired(VOICE_PLUGIN_ID);
  const src = voicePartsSource(desired);
  if (src === "plain") return <>{plain()}</>;
  const r = reg();
  const C = (src === "plugin" ? r.parts?.[name] : undefined) ?? builtinParts[name];
  const onError = (e: unknown) => {
    if (src === "plugin" && r.onError) r.onError(e);
    else setVoicePartsFailed(String((e as Error)?.message ?? e));
  };
  return (
    <PartBoundary key={`${src}:${r.v}`} plain={plain()} onError={onError}>
      {createElement(C)}
    </PartBoundary>
  );
}

/** The built-in controls (what the built-in plugin registers). */
export const builtinParts: Required<VoicePartSet> = {
  cockpit: builtin.VoiceCockpit,
  mic: builtin.VoiceMicGroup,
  mute: builtin.VoiceMuteButton,
  inlineWaves: builtin.InlineVoiceWaves,
};

function PlainMic() {
  const voiceMode = useStore((s) => s.voiceMode);
  const vaultPath = useStore((s) => s.vaultPath);
  return (
    <button data-offer="app/voice.start"
      onClick={() => toggleVoice("titlebar mic")}
      disabled={!vaultPath}
      data-el="voice-mic"
      data-plain="1"
      className={`h-7 w-7 flex items-center justify-center rounded hover:bg-titlebar-hover disabled:opacity-40 ${voiceMode ? "text-titlebar-foreground" : "text-titlebar-muted"}`}
      title={voiceMode ? `Voice mode (on) — ${shortcutHint("voice.toggle")} to turn off` : `Voice mode (off) — ${shortcutHint("voice.toggle")} to turn on`}
    >
      <Mic className="h-3.5 w-3.5" strokeWidth={voiceMode ? 2.5 : 2} />
    </button>
  );
}

function PlainMute() {
  const live = useStore((s) => s.voiceMode && !s.voiceConnecting);
  const muted = useStore((s) => s.voiceMicMuted);
  if (isPopout || !live) return null;
  return (
    <button data-offer="app/voice.mute"
      onClick={() => toggleVoiceMute()}
      data-el="voice-mute"
      data-plain="1"
      aria-pressed={muted}
      title={muted ? `Muted: click or ${shortcutHint("voice.mute")} to talk` : `Mute the mic (${shortcutHint("voice.mute")})`}
      className={`h-7 px-2.5 gap-1.5 flex items-center rounded-full text-[11px] font-semibold ${muted ? "bg-red-600 text-white" : "bg-accent/70 text-foreground"}`}
    >
      {muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
      <span>{muted ? "Muted" : "Mute"}</span>
    </button>
  );
}

function PlainCockpit() {
  const voiceMode = useStore((s) => s.voiceMode);
  const connecting = useStore((s) => s.voiceConnecting);
  if (!voiceMode) return null;
  return (
    <div data-el="voice-plain" className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 text-[10.5px] font-medium text-titlebar-muted whitespace-nowrap">
      {connecting ? "Connecting…" : "Voice on"}
    </div>
  );
}

/** The title bar's voice status, centred (the waves while a call is on). */
export function VoiceCockpit() {
  return <Part name="cockpit" plain={() => <PlainCockpit />} />;
}
/** The title bar's mic (and the keyboard that slides out of it while voice is on). */
export function VoiceMicGroup() {
  return <Part name="mic" plain={() => <PlainMic />} />;
}
/** The composer's Mute while a call is live (or where voice went). */
export function VoiceMuteButton() {
  return <Part name="mute" plain={() => <PlainMute />} />;
}
/** Fullscreen chat's waves beside the composer's mic. */
export function InlineVoiceWaves() {
  return <Part name="inlineWaves" plain={() => null} />;
}
