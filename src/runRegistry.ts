// The box engine's turns in flight, by conversation id (server/engine/engine.ts
// registers each): /health's busy count reads them, so the updater never
// restarts the server under a running turn.

const controllers = new Map<string, AbortController>();

export function registerRun(convId: string, c: AbortController): void {
  controllers.set(convId, c);
}

// Only clear if it's still our controller — a newer run for the same
// conversation must not be unregistered by an older one finishing.
export function unregisterRun(convId: string, c: AbortController): void {
  if (controllers.get(convId) === c) controllers.delete(convId);
}

// Conversation ids with a registered in-flight run.
export function activeRuns(): string[] {
  return [...controllers.keys()];
}
