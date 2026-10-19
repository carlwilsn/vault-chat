// The box engine's turns in flight, by conversation id (server/engine/engine.ts
// registers each): /health's busy count reads them, so the updater never
// restarts the server under a running turn.

const controllers = new Map<string, AbortController>();
// Turns accepted but not started yet (waiting on the conversation's earlier input, the
// runtime, or opening the thread): busy too, or the updater could restart between
// "accepted" and "running".
const holds = new Map<string, number>();

export function registerRun(convId: string, c: AbortController): void {
  controllers.set(convId, c);
}

// Only clear if it's still our controller — a newer run for the same
// conversation must not be unregistered by an older one finishing.
export function unregisterRun(convId: string, c: AbortController): void {
  if (controllers.get(convId) === c) controllers.delete(convId);
}

/** Count a conversation busy from the moment a turn is accepted; call the result once it has started (or failed). */
export function holdRun(convId: string): () => void {
  holds.set(convId, (holds.get(convId) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (holds.get(convId) ?? 1) - 1;
    if (n > 0) holds.set(convId, n);
    else holds.delete(convId);
  };
}

// Conversation ids with a registered in-flight run, or one accepted and about to start.
export function activeRuns(): string[] {
  return [...new Set([...controllers.keys(), ...holds.keys()])];
}
