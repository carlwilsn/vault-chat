// Native SubmitChange cutover on the real engine/fake pi provider, real temporary git.
// Historical cards remain settleable; no new native ReadyForReview or mandatory Keep wait.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, type Running } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { fold } from "../../src/convlog/reduce";
import { answerReview } from "../projectChanges";
import { setFolderWalls } from "../projectFolders";
import { agentToolSpecs } from "../engine/engine";

const fwd = (p: string) => p.split("\\").join("/");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Carl", "-c", "user.email=carl@example.com", ...args], { cwd, encoding: "utf8" }).trim();

let home: string, vault: string, secrets: string, repo: string, bare: string;
let or: FakeApi;
let srv: Running;
const post = async (p: string, b: Record<string, unknown>) => {
  const r = await fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json() };
};
const get = async (p: string) => (await fetch(srv.base + p)).json();
async function picture(id: string) {
  const out: any[] = [];
  let cur = 0;
  for (;;) {
    const r = await get(`/poll?after=${cur}`);
    out.push(...r.events);
    if (!r.events.length || !r.more) break;
    cur = r.next;
  }
  return fold(out.filter((r) => r.conv === id), id);
}
const CONV = "project-site";
const asking = async () => !!(await picture(CONV)).meta.asking;
const mainSha = () => git(repo, "rev-parse", "main");

beforeAll(async () => {
  home = tmp("vcpc-");
  vault = makeVault(join(home, "vaults", "school2"));
  bare = join(home, "remote", "site.git");
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "--bare", "-q", "-b", "main");
  repo = join(home, "github", "site");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "AGENTS.md"), "SITE-AGENTS: keep the font at 16px.\n");
  writeFileSync(join(repo, "index.html"), "<h1>Hello</h1>\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "branch", "--set-upstream-to=origin/main", "main");
  secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary-not-real" });
  or = await fakeAnthropic("Done.");
  srv = await startServer({ home, vault, secrets, anthropic: or.url });
}, 120_000);
afterAll(async () => {
  if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
  await srv?.stop();
  await or?.close();
  cleanup(home);
});

describe("a git project: service proof owns main; legacy cards remain readable", () => {
  let work = "";
  const first = () => mainSha();
  let start = "";

  it("its thread runs in the agent's own clone of the repo (its AGENTS.md loaded), told the rule", async () => {
    start = first();
    const r = await post("/projects", { name: "Site", folder: fwd(repo) });
    expect(r.body).toMatchObject({ ok: true, slug: "site", folder: fwd(repo) });
    const s = await post("/api/v2/intent", { type: "send", clientId: "c-1", convId: CONV, text: "Make the heading bigger, GATE-1." });
    expect(s.body.ok).toBe(true);
    await waitFor(() => or.calls.some((c) => JSON.stringify(c).includes("GATE-1")), 30_000);
    const sent = JSON.stringify(or.calls.find((c) => JSON.stringify(c).includes("GATE-1")));
    expect(sent).toContain("SITE-AGENTS: keep the font at 16px.");
    expect(sent).toContain("then call SubmitChange");
    expect(sent).not.toContain("only his Keep merges your branch into it");
    const m = /You work in your own clone of it, ([^ ]+?)\/: relative/.exec(JSON.parse(sent).messages.map((x: any) => x.content).join("\n"));
    expect(m).toBeTruthy();
    work = m![1]!;
    expect(existsSync(join(work, ".git"))).toBe(true);
    expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe("main");
    await waitFor(async () => !(await picture(CONV)).meta.running, 20_000);
  });

  it("the agent's change: committed on agent/bigger-heading in its clone; main untouched", async () => {
    git(work, "switch", "-q", "-c", "agent/bigger-heading");
    writeFileSync(join(work, "index.html"), "<h1 style=\"font-size:2em\">Hello</h1>\n");
    mkdirSync(join(work, "proof"), { recursive: true });
    writeFileSync(join(work, "proof", "after.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    git(work, "add", "index.html");
    git(work, "commit", "-q", "-m", "Bigger heading");
    expect(mainSha()).toBe(start);
  });

  it("publishes SubmitChange rather than ReadyForReview in the actual provider catalog", async () => {
    const native = agentToolSpecs();
    expect(native.some(t => t.name === "ReadyForReview")).toBe(false);
    expect(native.find(t => t.name === "SubmitChange")?.inputSchema.required).toContain("branch");
    const names = or.calls.flatMap((c: any) => (c.tools ?? []).map((t: any) => t.function?.name ?? t.name));
    expect(names).toContain("mcp__vault_chat__SubmitChange");
    expect(names).not.toContain("mcp__vault_chat__ReadyForReview");
    expect(await asking()).toBe(false);
  });

  it("historical review settlement cannot move main or revive Keep", async () => {
    const answer = await answerReview(vault, { convId: CONV, slug: "site", folder: repo, clone: work, base: "main", branch: "agent/bigger-heading", sha: git(work, "rev-parse", "HEAD"), title: "Historical change", at: "" }, "Keep");
    expect(answer.kept).toBe(false);
    expect(answer.text).toContain("main is unchanged");
    expect(mainSha()).toBe(start);
    expect(git(work, "branch", "--show-current")).toBe("agent/bigger-heading");
  });

});

describe("the sandbox for a git project: its folder read-only, the clone writable", () => {
  it("binds the repo --ro-bind, never --bind", async () => {
    const h = tmp("vcpc-sb-");
    try {
      const r = join(h, "github", "site");
      mkdirSync(join(r, ".git"), { recursive: true });
      await import("../shims/globals");
      const { outerWith } = await import("../engine/sandbox");
      const sb = { outer: ["bwrap", "--ro-bind", h, h, "--"], shell: ["bwrap", "--"], denyRead: [], denyWrite: [], readOnly: () => [r], projects: () => [] };
      const o = outerWith(sb)!;
      expect(o).toContain("--ro-bind");
      expect(o.join(" ")).toContain(`--ro-bind ${r} ${r}`);
      expect(o.join(" ")).not.toContain(`--bind ${r} ${r}`);
    } finally {
      cleanup(h);
    }
  });
});
