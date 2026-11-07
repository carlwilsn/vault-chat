// Existing ship-result event delivery only. General continuation belongs to Pi.
// No idle/ASKS reader, nudge, synthetic phone input, or second work loop.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type KeepGoingOptions = {
  /** Existing native engine wake/follow-up path; never a fake human message. */
  deliver: (name: string, body: string) => Promise<void>;
  stateDir: string;
  /** ~/agent-work/vault-chat: ship-requests/ and ship-results/ live here. */
  workDir: string;
};

type State = { seen: string[] };

export function startKeepGoing(o: KeepGoingOptions): { tick: () => Promise<void> } | null {
  const results = join(o.workDir, "ship-results");
  if (!existsSync(results)) return null;
  const stateFile = join(o.stateDir, "keep-going.json");
  const resultNames = () => readdirSync(results).filter((n) => n.endsWith(".result"));
  let state: State;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    // First start: what is there now was already read.
    state = { seen: resultNames() };
  }
  const save = () => writeFileSync(stateFile, JSON.stringify(state));
  save();

  const tick = async () => {
    const fresh = resultNames().filter((n) => !state.seen.includes(n));
    for (const n of fresh) {
      const body = readFileSync(join(results, n), "utf8").trim();
      await o.deliver(n, body);
      state.seen.push(n);
      save();
    }
  };
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    tick().catch((e) => console.error(`[keep-going] ${(e as Error)?.message ?? e}`)).finally(() => (running = false));
  }, 60_000).unref();
  console.log(`[keep-going] watching ${results} for native event delivery`);
  return { tick };
}
