// What the live pages (src/liveBridge.ts) are doing that is not their own vc.state: a capability prompt waiting for
// Carl (what the page asks for, and its Allow / Not now), a page recording from the mic (and its Stop), requests a
// page has in flight to the box (vc.ask, vc.fetch), the last sound it played. app/viewer's pages state reads them and
// its grant / stopMic actions do what those buttons do. A change tells the offers' watch.
type Prompt = { caps: string[]; answer: (ok: boolean) => void };
type Activity = { mic: (() => void) | null; requests: number; played: string | null };
const prompts = new Map<string, Prompt>();
const acts = new Map<string, Activity>();
const fns = new Set<() => void>();
const changed = () => {
  for (const f of [...fns]) f();
};
const actOf = (page: string) => {
  let a = acts.get(page);
  if (!a) acts.set(page, (a = { mic: null, requests: 0, played: null }));
  return a;
};

export function notePrompt(page: string, caps: string[], answer: (ok: boolean) => void): () => void {
  const p = { caps, answer };
  prompts.set(page, p);
  changed();
  return () => {
    if (prompts.get(page) === p) prompts.delete(page);
    changed();
  };
}
export function noteMic(page: string, stop: (() => void) | null): void {
  actOf(page).mic = stop;
  changed();
}
export function noteRequests(page: string, delta: number): void {
  const a = actOf(page);
  a.requests = Math.max(0, a.requests + delta);
  changed();
}
export function notePlayed(page: string, what: string): void {
  actOf(page).played = `${what.slice(0, 200)} at ${new Date().toISOString()}`;
  changed();
}
export function onLivePagesChanged(fn: () => void): () => void {
  fns.add(fn);
  return () => void fns.delete(fn);
}
export function livePagesNow() {
  const pages = new Set([...prompts.keys(), ...acts.keys()]);
  return [...pages].map((page) => {
    const p = prompts.get(page);
    const a = acts.get(page);
    return { page, ...(p ? { asking: p.caps } : {}), recording: !!a?.mic, requests: a?.requests ?? 0, ...(a?.played ? { played: a.played } : {}) };
  });
}
/** The prompt's Allow (true) or Not now (false), as its buttons. */
export function answerPrompt(page: string, ok: boolean): boolean {
  const p = prompts.get(page);
  if (!p) return false;
  p.answer(ok);
  return true;
}
/** The recording badge's Stop. */
export function stopPageMic(page: string): boolean {
  const s = acts.get(page)?.mic;
  if (!s) return false;
  s();
  return true;
}
