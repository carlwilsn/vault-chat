// What the client pushes into a live voice conversation on its own — viewport
// and typing contextual updates, follow-along PDF/image uploads (a
// multimodal_message is a USER turn to ElevenLabs) — waits while the agent is
// speaking. Pushed mid-reply, an upload made the agent drop the sentence it was
// saying and start a new reply ("it would start speaking and then just say a
// different sentence"). Held pushes go once the agent has been quiet for
// `settleMs` (it often pauses between sentences); a newer push of the same key
// replaces the held one (only the latest viewport matters).

export class QuietGate {
  private held = new Map<string, () => void>();
  private waiters = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly speaking: () => boolean,
    private readonly settleMs = 700,
  ) {}

  /** Run `fn` now if the agent is quiet, else when it has finished speaking. */
  run(key: string, fn: () => void): void {
    if (!this.speaking() && !this.timer) {
      fn();
      return;
    }
    this.held.set(key, fn);
  }

  /** Resolves when the agent is quiet (at once if it is), or after `maxMs` regardless. */
  quiet(maxMs: number): Promise<void> {
    if (!this.speaking() && !this.timer) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, maxMs);
      this.waiters.add(done);
    });
  }

  /** The agent's mode changed (onModeChange): speaking holds, anything else flushes after the settle. */
  modeChanged(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.speaking()) return;
    if (!this.held.size && !this.waiters.size) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.speaking()) return;
      const fns = [...this.held.values()];
      this.held.clear();
      for (const w of [...this.waiters]) w();
      for (const fn of fns) {
        try {
          fn();
        } catch (e) {
          console.warn("[voice-quiet] held push failed:", e);
        }
      }
    }, this.settleMs);
  }

  /** How many pushes are held (tests, diagnostics). */
  get pending(): number {
    return this.held.size + this.waiters.size;
  }

  /** Session over: drop what was held (waiters resolve so nothing hangs). */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.held.clear();
    for (const w of [...this.waiters]) w();
  }
}
