// Per-conversation run handles. Every in-flight agent run registers its
// AbortController here keyed by conversation id, so a *different* agent (a
// supervisor, or the phone's front agent) can target a specific worker's run —
// e.g. to interject/nudge it. The foreground singleton abortRef in
// chat-controller still drives the Stop button; this is the by-id index that
// lets one thread reach another. Purely additive: if a run forgets to
// register, the worst case is "can't interject it," never a broken run.

const controllers = new Map<string, AbortController>();

export function registerRun(convId: string, c: AbortController): void {
  controllers.set(convId, c);
}

// Only clear if it's still our controller — a newer run for the same
// conversation must not be unregistered by an older one finishing.
export function unregisterRun(convId: string, c: AbortController): void {
  if (controllers.get(convId) === c) controllers.delete(convId);
}

export function isRunActive(convId: string): boolean {
  return controllers.has(convId);
}

// Abort the in-flight run on a conversation, if any. Returns whether one was
// found to abort.
export function abortRun(convId: string): boolean {
  const c = controllers.get(convId);
  if (!c) return false;
  c.abort();
  return true;
}
