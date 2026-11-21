// What the box does by itself with a failed ship result, before any model is woken (reports/21-design, Carl's
// decision 5: "the box queues and resubmits by itself"). The ship script already runs one request at a time and
// retries its own real-data-capture flake; this handles the two failures that cost a model wake and a 19-minute
// run for nothing:
//   - a known network flake in the gates (npm ci ETIMEDOUT and the like): resubmit the same branch;
//   - main moved under the branch (the is-ancestor check): rebase it onto main in a scratch clone; when that is
//     clean, push it back to the agents remote and resubmit. A conflict is the ask's session's to resolve.
// At most MAX_AUTO times per ask; then the result goes to a session like any other.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resultBranch } from "./ledger";

export const MAX_AUTO = 3;
const FLAKE = /\b(ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND registry|socket hang up)\b/;
const MOVED = /merge-base --is-ancestor/;

export type ShipAutoDeps = {
  /** ship-requests/ (a new <name>.req is a submission). */
  requests: string;
  /** The project repo whose main the branch must contain. */
  repo: string;
  /** Where scratch clones go. */
  scratch: string;
  git?: (cwd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
};

export type ShipAuto = { done: false } | { done: true; name: string; what: string };

const realGit = (cwd: string, args: string[]) => {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** The kind of failure a ship result shows, when the box can deal with it alone. */
export function autoKind(body: string): "flake" | "moved" | null {
  if (/^exit=0\b/m.test(body)) return null;
  if (MOVED.test(body)) return "moved";
  if (FLAKE.test(body) && !/new named failure/.test(body)) return "flake";
  return null;
}

/** The next free request name for this ship: <base>-a1, -a2 … (never one in flight or done). */
export function nextName(base: string, results: string, requests: string): string {
  const root = base.replace(/-a\d+$/, "");
  for (let n = 1; ; n++) {
    const name = `${root}-a${n}`;
    if (![".req"].some((x) => existsSync(join(requests, name + x))) && ![".result", ".taken", ".running"].some((x) => existsSync(join(results, name + x)))) return name;
  }
}

/** Handle a failed ship result by itself, or say it cannot (the ask's session gets it). */
export function shipAuto(o: { name: string; body: string; title: string; tries: number; results: string }, d: ShipAutoDeps): ShipAuto {
  const kind = autoKind(o.body);
  const branch = resultBranch(o.body);
  if (!kind || !branch || !/^agent\/[A-Za-z0-9._/-]+$/.test(branch) || o.tries >= MAX_AUTO) return { done: false };
  const git = d.git ?? realGit;
  if (kind === "moved") {
    const remote = git(d.repo, ["remote", "get-url", "agents"]).stdout.trim();
    if (!remote) return { done: false };
    mkdirSync(d.scratch, { recursive: true });
    const dir = mkdtempSync(join(d.scratch, "rebase-"));
    try {
      const steps: string[][] = [
        ["clone", "--quiet", "--branch", branch, "--", remote, dir],
        ["-C", dir, "fetch", "--quiet", "--", d.repo, "main"],
        ["-C", dir, "-c", "user.name=agent", "-c", "user.email=agent@vault-chat.local", "rebase", "--quiet", "FETCH_HEAD"],
        ["-C", dir, "push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`],
      ];
      for (const s of steps) {
        const r = git(d.scratch, s);
        if (r.status !== 0) return { done: false };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const name = nextName(o.name, o.results, d.requests);
  mkdirSync(d.requests, { recursive: true });
  writeFileSync(join(d.requests, `${name}.req`), `${branch}\n${o.title.replace(/\s+/g, " ").trim().slice(0, 200) || branch}\n`);
  return { done: true, name, what: kind === "moved" ? `main had moved: the box rebased ${branch} onto main (clean) and resubmitted it as ${name}` : `a network flake in the gates: the box resubmitted ${branch} as ${name}` };
}
