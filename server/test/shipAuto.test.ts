// The box deals with two kinds of failed ship result by itself (reports/21-design, decision 5), with real git:
//   - a network flake: the same branch is resubmitted under a new request name;
//   - main moved (is-ancestor): the branch is rebased onto main in a scratch clone, pushed back, resubmitted;
//     a conflict, a real test failure, or a third try is left to the ask's session.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoKind, nextName, shipAuto } from "../engine/shipAuto";

const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

function world(conflict: boolean) {
  const root = mkdtempSync(join(tmpdir(), "ship-auto-"));
  const repo = join(root, "repo");
  const pub = join(root, "published.git");
  mkdirSync(repo);
  g(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\n");
  g(repo, "add", ".");
  g(repo, "commit", "-qm", "base");
  g(root, "init", "-q", "--bare", pub);
  g(repo, "remote", "add", "agents", pub);
  g(repo, "switch", "-qc", "agent/x");
  writeFileSync(join(repo, conflict ? "a.txt" : "b.txt"), "branch\n");
  g(repo, "add", ".");
  g(repo, "commit", "-qm", "branch work");
  g(repo, "push", "-q", "agents", "agent/x");
  g(repo, "switch", "-q", "main");
  writeFileSync(join(repo, "a.txt"), "main moved\n");
  g(repo, "commit", "-qam", "main moves");
  const results = join(root, "ship-results");
  const requests = join(root, "ship-requests");
  mkdirSync(results);
  mkdirSync(requests);
  return { root, repo, pub, results, requests, deps: { requests, repo, scratch: join(root, "scratch") } };
}

describe("ship results the box handles by itself", () => {
  it("knows a flake and a moved main from a real failure", () => {
    expect(autoKind("exit=1\nbranch=agent/x\nError: npm ci failed: ETIMEDOUT")).toBe("flake");
    expect(autoKind("exit=1\nError: git merge-base --is-ancestor e41 dcc (exit 1):")).toBe("moved");
    expect(autoKind('exit=1\nError: test:harness: new named failure ["a"] ETIMEDOUT')).toBeNull();
    expect(autoKind("exit=0\npushed=yes")).toBeNull();
  });

  it("a moved main: rebased onto main, pushed back, resubmitted under a new name", () => {
    const w = world(false);
    writeFileSync(join(w.results, "x-1.result"), "x");
    const r = shipAuto({ name: "x-1", body: "exit=1\nbranch=agent/x\nError: git merge-base --is-ancestor aaa bbb (exit 1):", title: "Do x", tries: 0, results: w.results }, w.deps);
    expect(r).toMatchObject({ done: true, name: "x-1-a1" });
    expect(readFileSync(join(w.requests, "x-1-a1.req"), "utf8")).toBe("agent/x\nDo x\n");
    // main is now an ancestor of the pushed branch, and the branch's work is still there.
    const tip = g(w.pub, "rev-parse", "agent/x");
    g(w.repo, "fetch", "-q", "agents");
    expect(spawnSync("git", ["merge-base", "--is-ancestor", "main", tip], { cwd: w.repo }).status).toBe(0);
    expect(g(w.repo, "show", `${tip}:b.txt`)).toBe("branch");
    expect(nextName("x-1-a1", w.results, w.requests)).toBe("x-1-a2");
  });

  it("a conflict is the session's: nothing pushed, nothing submitted", () => {
    const w = world(true);
    const before = g(w.pub, "rev-parse", "agent/x");
    const r = shipAuto({ name: "x-1", body: "exit=1\nbranch=agent/x\nError: git merge-base --is-ancestor aaa bbb (exit 1):", title: "Do x", tries: 0, results: w.results }, w.deps);
    expect(r.done).toBe(false);
    expect(g(w.pub, "rev-parse", "agent/x")).toBe(before);
    expect(existsSync(join(w.requests, "x-1-a1.req"))).toBe(false);
  });

  it("a flake is resubmitted as is, three times at most", () => {
    const w = world(false);
    const body = "exit=1\nbranch=agent/x\nnpm ci: ETIMEDOUT";
    expect(shipAuto({ name: "x-2", body, title: "Do x", tries: 0, results: w.results }, w.deps)).toMatchObject({ done: true, name: "x-2-a1" });
    expect(shipAuto({ name: "x-2", body, title: "Do x", tries: 3, results: w.results }, w.deps).done).toBe(false);
  });
});
