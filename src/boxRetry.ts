// Connection-level failures talking to the box ("error sending request for url …": the request never got a
// response) are usually a blip while the box is busy; the work often completes anyway. Retry them with backoff
// before the app calls the box unreachable.

/** Backoff between attempts; the sum is the ~10 s window an intent is retried over before "Box unreachable". */
export const INTENT_BACKOFF_MS = [300, 700, 1500, 2500, 4000];
/** Other POSTs (live pages' fetch relay): one safe retry. */
export const ONE_RETRY_MS = [500];

/** Run `attempt`; when it throws (a network-level failure, not an HTTP status) wait out each delay and try again. */
export async function withRetry<T>(attempt: () => Promise<T>, delays: readonly number[], sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (i >= delays.length) throw e;
      await sleep(delays[i]);
    }
  }
}
