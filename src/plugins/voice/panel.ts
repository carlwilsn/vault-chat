// The voice text panel's contents while it is drawn (./TextPanel.tsx): its text and the captured picture, and its own
// type / send / remove picture, so app/voice's offers read and run what Carl's keys and clicks do.
export type VoicePanel = { state(): Record<string, unknown>; type(t: string): void; send(): Promise<void> | void; removeImage(): void };
let panel: VoicePanel | null = null;
const fns = new Set<() => void>();
export function registerVoicePanel(p: VoicePanel): () => void {
  panel = p;
  voicePanelChanged();
  return () => {
    if (panel === p) panel = null;
    voicePanelChanged();
  };
}
export const voicePanel = () => panel;
export function voicePanelChanged(): void {
  for (const f of [...fns]) f();
}
export function onVoicePanelChanged(fn: () => void): () => void {
  fns.add(fn);
  return () => void fns.delete(fn);
}
