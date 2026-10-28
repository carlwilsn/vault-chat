// "You keep it" (Carl, 2026-10-27): in a project that is a git repo, the agent's change happens on a branch
// agent/<short-name> in its own clone, never on the project's main branch; it hands the change over with a proof
// card (what changed, why, the tests, screenshots); Carl keeps it (the server merges it into main and pushes) or
// sends it back (his note goes to the agent, which goes on with the branch). Nothing reaches main without Keep.
// The real bundle and engine on the fake pi (fakePiCli.mjs), a fake OpenRouter, real git: the project is a repo
// with a bare remote; the agent's commits are made in its clone as its shell would.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, fakeOpenRouter, startServer, waitFor, type Running, type FakeOpenRouter } from "./helpers";
import { fold, shown } from "../../src/convlog/reduce";
import { makeChatView } from "../../src/convlog/view";

const fwd = (p: string) => p.split("\\").join("/");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Carl", "-c", "user.email=carl@example.com", ...args], { cwd, encoding: "utf8" }).trim();

let home: string, vault: string, secrets: string, repo: string, bare: string;
let or: FakeOpenRouter;
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
  or = await fakeOpenRouter("Done.");
  srv = await startServer({ home, vault, secrets, openrouter: or.url });
}, 120_000);
afterAll(async () => {
  if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
  await srv?.stop();
  await or?.close();
  cleanup(home);
});

describe("a git project: the agent works on a branch in its clone; only Keep reaches main", () => {
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
    expect(sent).toContain("only his Keep merges your branch into it");
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

  it("ReadyForReview: the branch beside main in the repo, the proof card with Keep and Send back; main unchanged", async () => {
    or.script.push({ toolCall: { name: "ReadyForReview", args: { title: "Bigger heading", what: "The h1 is 2em.", why: "Carl asked for a bigger heading.", tests: "npm test: 12 passed, 0 failed", images: ["proof/after.png"] } } });
    await post("/api/v2/intent", { type: "send", clientId: "c-2", convId: CONV, text: "Hand it over, GATE-2." });
    await waitFor(asking, 30_000);
    expect(git(repo, "rev-parse", "agent/bigger-heading")).toBe(git(work, "rev-parse", "HEAD"));
    expect(mainSha()).toBe(start);
    // The card, as the laptop and the phone show it (the same view).
    const msgs = makeChatView()(await picture(CONV)).messages;
    const card = msgs.find((m: any) => m.askOptions?.length);
    expect(card.content).toContain("**Ready to keep: Bigger heading**");
    expect(card.content).toContain("**Tests.**");
    expect(card.content).toContain("npm test: 12 passed, 0 failed");
    const img = /!\[proof 1\]\(([^)]+)\)/.exec(card.content)![1]!;
    expect(existsSync(join(vault, img))).toBe(true);
    expect(card.askOptions.map((o: any) => o.answer)).toEqual(["Keep", "Send back"]);
  });

  it("Send back: his note reaches the agent; main unchanged; the branch stays", async () => {
    const r = await post("/api/v2/intent", { type: "answer", clientId: "c-3", convId: CONV, text: "Make it 3em, not 2." });
    expect(r.body.ok).toBe(true);
    await waitFor(() => or.calls.some((c) => JSON.stringify(c).includes("Sent back: Make it 3em, not 2. main is unchanged")), 30_000);
    expect(mainSha()).toBe(start);
    expect(git(repo, "branch", "--list", "agent/bigger-heading")).toContain("agent/bigger-heading");
    await waitFor(async () => !(await picture(CONV)).meta.running, 20_000);
    // His line in the thread is his answer alone.
    const p = await picture(CONV);
    expect(shown(p).some((x: any) => x.kind === "user" && x.text === "Make it 3em, not 2.")).toBe(true);
  });

  it("Keep: the branch merged into main by the server and pushed to the remote", async () => {
    writeFileSync(join(work, "index.html"), "<h1 style=\"font-size:3em\">Hello</h1>\n");
    git(work, "commit", "-q", "-am", "3em");
    or.script.push({ toolCall: { name: "ReadyForReview", args: { title: "Bigger heading", what: "The h1 is 3em.", why: "His note.", tests: "npm test: 12 passed, 0 failed" } } });
    await post("/api/v2/intent", { type: "send", clientId: "c-4", convId: CONV, text: "Again, GATE-4." });
    await waitFor(asking, 30_000);
    expect(mainSha()).toBe(start);
    await post("/api/v2/intent", { type: "answer", clientId: "c-5", convId: CONV, text: "Keep" });
    await waitFor(() => or.calls.some((c) => JSON.stringify(c).includes("Kept: agent/bigger-heading is in main")), 30_000);
    expect(mainSha()).toBe(git(work, "rev-parse", "agent/bigger-heading"));
    expect(readFileSync(join(repo, "index.html"), "utf8")).toContain("3em");
    expect(git(bare, "rev-parse", "main")).toBe(mainSha());
    expect(JSON.stringify(or.calls.at(-1))).toContain("pushed to origin");
    // The clone is back on main for the next change.
    expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  it("a hand-over still open across a restart: Carl's Keep afterwards is still the server's merge", async () => {
    git(work, "switch", "-q", "-c", "agent/footer");
    writeFileSync(join(work, "footer.html"), "<footer>bye</footer>\n");
    git(work, "add", "footer.html");
    git(work, "commit", "-q", "-m", "Footer");
    or.script.push({ toolCall: { name: "ReadyForReview", args: { title: "A footer", what: "footer.html", why: "asked", tests: "ok" } } });
    await post("/api/v2/intent", { type: "send", clientId: "c-r1", convId: CONV, text: "Footer, GATE-R." });
    await waitFor(asking, 30_000);
    const before = mainSha();
    await srv.stop();
    srv = await startServer({ home, vault, secrets, openrouter: or.url });
    expect(mainSha()).toBe(before);
    await post("/api/v2/intent", { type: "answer", clientId: "c-r2", convId: CONV, text: "Keep" });
    await waitFor(() => mainSha() === git(work, "rev-parse", "agent/footer"), 30_000);
    expect(git(bare, "rev-parse", "main")).toBe(mainSha());
    await waitFor(() => or.calls.some((c) => JSON.stringify(c).includes("Kept: agent/footer is in main")), 30_000);
    await waitFor(async () => !(await picture(CONV)).meta.running, 20_000);
  }, 120_000);

  it("a hand-over with nothing committed is refused, and so is ReadyForReview outside a git project", async () => {
    or.script.push({ toolCall: { name: "ReadyForReview", args: { title: "Nothing", what: "x", why: "x", tests: "x" } } });
    await post("/api/v2/intent", { type: "send", clientId: "c-6", convId: CONV, text: "Hand over nothing, GATE-6." });
    await waitFor(() => or.calls.some((c) => JSON.stringify(c).includes("Nothing to keep")), 30_000);
    expect(await asking()).toBe(false);
    await waitFor(async () => !(await picture(CONV)).meta.running, 20_000);
    or.script.push({ toolCall: { name: "ReadyForReview", args: { title: "Main", what: "x", why: "x", tests: "x" } } });
    await post("/api/v2/intent", { type: "send", clientId: "c-7", text: "In Main, GATE-7." });
    await waitFor(() => or.calls.some((c) => JSON.stringify(c).includes("is only for the thread of a project that works in a git repo")), 30_000);
  });
});

describe("the sandbox for a git project: its folder read-only, the clone writable", () => {
  it("binds the repo --ro-bind, never --bind", async () => {
    const h = tmp("vcpc-sb-");
    try {
      const r = join(h, "github", "site");
      mkdirSync(join(r, ".git"), { recursive: true });
      await import("../shims/globals");
      const { outerWith } = await import("../engine/pi/backend");
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
