// The box's waiter: what an ask in the work list can wait on, checked in code (never by a model in a loop), and
// the event that wakes a fresh session when it holds (reports/19-stateless). Kinds are a registry so a durable
// "watch" of anything else (reports/20-design-review: B's watch) is one more kind, not one more loop.
//
// Each check answers null (not yet) or {id, text}: `id` names the event so an ask takes each one up once.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readShipResult, resultBranch, type LedgerWait } from "./ledger";

export type WaitContext = {
  now: number;
  /** ship-results/ (the box's ship script writes <name>.result there). */
  shipResults: string;
  /** GitHub's API (JSON), injectable. */
  fetchJson: (url: string) => Promise<any>;
  /** Is commit `a` contained in `b` (a == b or an ancestor), in the project's repo. */
  contains: (a: string, b: string) => boolean;
  /** The main commit the box's newest stored core bundle was built from. */
  coreCommit: () => string | null;
  /** The main commit of the core Carl's laptop last reported running, and when. */
  laptopCommit: () => { commit: string | null; at: number } | null;
  /** The revision the box server runs. */
  boxRevision: () => string | null;
};

export type WaitEvent = { id: string; text: string };
export type WaitKind = {
  /** The args it takes, for WaitFor's validation: [name, required]. */
  args: [string, boolean][];
  /** How often it may be checked (ms). */
  every?: number;
  check: (w: LedgerWait, c: WaitContext) => Promise<WaitEvent | null> | WaitEvent | null;
};

const kinds = new Map<string, WaitKind>();
export function registerWaitKind(name: string, k: WaitKind): void {
  kinds.set(name, k);
}
export function waitKind(name: string): WaitKind | undefined {
  return kinds.get(name);
}
export function waitKinds(): string[] {
  return [...kinds.keys()];
}

const short = (s: string) => s.slice(0, 12);

registerWaitKind("ship", {
  args: [["name", true]],
  check: (w, c) => {
    const name = w.args.name!.replace(/\.(req|result)$/, "");
    const r = readShipResult(c.shipResults, name);
    if (!r || r.at < w.since - 1000) return null;
    return { id: `ship:${name}:${Math.round(r.at)}`, text: `Ship result ${name}:\n${r.body.trim()}` };
  },
});

registerWaitKind("branch", {
  args: [["branch", true]],
  check: (w, c) => {
    const want = w.args.branch!.replace(/^agent\//, "");
    let names: string[] = [];
    try {
      names = readdirSync(c.shipResults).filter((n) => n.endsWith(".result"));
    } catch {
      return null;
    }
    for (const n of names) {
      const r = readShipResult(c.shipResults, n);
      const b = r ? resultBranch(r.body)?.replace(/^agent\//, "") : null;
      if (r && b === want && r.at >= w.since - 1000) return { id: `ship:${n}:${Math.round(r.at)}`, text: `Ship result ${n.replace(/\.result$/, "")} (branch agent/${want}):\n${r.body.trim()}` };
    }
    return null;
  },
});

registerWaitKind("githubRun", {
  args: [["run", true], ["repo", true]],
  every: 2 * 60_000,
  check: async (w, c) => {
    try {
      const r = await c.fetchJson(`https://api.github.com/repos/${w.args.repo}/actions/runs/${encodeURIComponent(w.args.run!)}`);
      if (!r || r.status !== "completed") return null;
      return { id: `gh:${w.args.run}`, text: `GitHub run ${w.args.run} (${w.args.repo}) ${r.name ? `"${r.name}" ` : ""}completed: ${r.conclusion ?? "?"}${r.html_url ? `\n${r.html_url}` : ""}${r.head_sha ? `\nhead ${short(String(r.head_sha))}` : ""}` };
    } catch {
      return null;
    }
  },
});

registerWaitKind("core", {
  args: [["commit", true]],
  every: 30_000,
  check: (w, c) => {
    const have = c.coreCommit();
    return have && c.contains(w.args.commit!, have) ? { id: `core:${have}`, text: `The box built and stored a core bundle that contains ${short(w.args.commit!)} (built from main ${short(have)}).` } : null;
  },
});

registerWaitKind("laptop", {
  args: [["commit", true]],
  every: 30_000,
  check: (w, c) => {
    const l = c.laptopCommit();
    return l?.commit && l.at >= w.since - 60_000 && c.contains(w.args.commit!, l.commit) ? { id: `laptop:${l.commit}`, text: `Carl's laptop reported running a core that contains ${short(w.args.commit!)} (main ${short(l.commit)}, at ${new Date(l.at).toISOString()}).` } : null;
  },
});

registerWaitKind("box", {
  args: [["commit", true]],
  every: 30_000,
  check: (w, c) => {
    const rev = c.boxRevision();
    return rev && c.contains(w.args.commit!, rev) ? { id: `box:${rev}`, text: `The box server now runs ${short(rev)}, which contains ${short(w.args.commit!)}.` } : null;
  },
});

/** Is `a` in `b` (git merge-base --is-ancestor), in this repo. A commit not known there is not contained. */
export function gitContains(repo: string): (a: string, b: string) => boolean {
  return (a, b) => {
    if (!/^[0-9a-f]{4,40}$/i.test(a) || !/^[0-9a-f]{4,40}$/i.test(b)) return false;
    if (b.startsWith(a) || a.startsWith(b)) return true;
    const r = spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", a, b], { timeout: 10_000 });
    return r.status === 0;
  };
}
