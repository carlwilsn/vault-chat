// The agent that builds vault-chat keeps going without anyone writing to it.
//
// Its turns end; nothing used to start the next one. Two things now do, once a minute:
// - a new ship result (the ship watcher's ship-results/<name>.result) is posted into its
//   conversation, so it reads the result and moves on;
// - when it has been idle a while, the asks list is unfinished and nothing is shipping,
//   it is told to continue (at most once an hour).
// Off when the ship-results folder does not exist (any box but Carl's).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type KeepGoingOptions = {
  /** The box server, e.g. http://127.0.0.1:8848 (the same /message route the clients use). */
  selfUrl: string;
  stateDir: string;
  /** ~/agent-work/vault-chat: ship-requests/ and ship-results/ live here. */
  workDir: string;
  /** The asks list; "(100%)" in it means done. */
  asksFile: string;
  convId: string;
  /** Idle this long before a nudge. */
  idleMs?: number;
  /** At most one nudge per this long. */
  nudgeEveryMs?: number;
};

type State = { seen: string[]; lastNudgeAt: number };

export function startKeepGoing(o: KeepGoingOptions): { tick: () => Promise<void> } | null {
  const results = join(o.workDir, "ship-results");
  const requests = join(o.workDir, "ship-requests");
  if (!existsSync(results)) return null;
  const stateFile = join(o.stateDir, "keep-going.json");
  const idleMs = o.idleMs ?? 30 * 60_000;
  const nudgeEveryMs = o.nudgeEveryMs ?? 60 * 60_000;
  const resultNames = () => readdirSync(results).filter((n) => n.endsWith(".result"));
  let state: State;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    // First start: what is there now was already read.
    state = { seen: resultNames(), lastNudgeAt: 0 };
  }
  const save = () => writeFileSync(stateFile, JSON.stringify(state));
  save();

  const post = (clientMsgId: string, text: string) =>
    fetch(`${o.selfUrl}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ convId: o.convId, clientMsgId, source: "phone", text }),
    });

  const tick = async () => {
    const fresh = resultNames().filter((n) => !state.seen.includes(n));
    for (const n of fresh) {
      const body = readFileSync(join(results, n), "utf8").trim();
      await post(`ship-result-${n}`, `Ship result ${n}:\n${body}\nIf it failed, fix it and ship again; if it passed, carry on with ASKS.md.`);
      state.seen.push(n);
      save();
    }
    if (fresh.length) return;
    const now = Date.now();
    if (now - state.lastNudgeAt < nudgeEveryMs) return;
    if (/\(100%\)/.test(readFileSync(o.asksFile, "utf8"))) return;
    const busy = (dir: string, ext: string) => existsSync(dir) && readdirSync(dir).some((n) => n.endsWith(ext));
    if (busy(requests, ".req") || busy(results, ".running")) return;
    const rows: Array<{ id: string; running?: boolean; asking?: boolean; lastActivityAt: number }> = (await (await fetch(`${o.selfUrl}/api/v2/conversations`)).json()).rows;
    const c = rows.find((r) => r.id === o.convId);
    if (!c || c.running || c.asking || now - c.lastActivityAt < idleMs) return;
    state.lastNudgeAt = now;
    save();
    await post(`keep-going-${now}`, "Continue with ASKS.md: the next unshipped ask in each lane, one change at a time, shipped through the ship request.");
  };
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    tick().catch((e) => console.error(`[keep-going] ${(e as Error)?.message ?? e}`)).finally(() => (running = false));
  }, 60_000).unref();
  console.log(`[keep-going] watching ${results} for ${o.convId}`);
  return { tick };
}
