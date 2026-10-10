// The real deployment condition: ONLY the bundle, in a directory with no
// node_modules anywhere up the tree (the box unpacks just the .mjs). Boots,
// serves health and /phone, hosts git, and runs a turn that extracts text
// from a PDF through the agent's PdfExtract tool (pdf.js + its worker are
// inside the bundle).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { BUNDLE, cleanup, makeVault, makeKeyStore, fakeOpenRouter, startServer, sh, git, tinyPdf, waitFor, type Running, type FakeOpenRouter } from "./helpers";

function ancestorsWithNodeModules(dir: string): string[] {
  const hits: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, "node_modules"))) hits.push(join(d, "node_modules"));
    if (dirname(d) === d) return hits;
  }
}

/** A temp dir with no node_modules above it: the OS temp dir when clean,
 * else a fresh dir at the drive root (this laptop has ~/node_modules). */
function isolatedDir(): string {
  for (const base of [tmpdir(), parse(tmpdir()).root]) {
    if (ancestorsWithNodeModules(base).length) continue;
    try {
      return mkdtempSync(join(base, "vcs-iso-"));
    } catch {
      /* not writable */
    }
  }
  throw new Error("no writable directory without node_modules above it");
}

describe("bundle alone (no node_modules)", () => {
  let home: string;
  let bundle: string;
  let or: FakeOpenRouter;
  let srv: Running;
  let vault: string;

  beforeAll(async () => {
    home = isolatedDir();
    const dist = join(home, "current");
    mkdirSync(dist);
    bundle = join(dist, "vault-chat-server.mjs");
    copyFileSync(BUNDLE, bundle);
    vault = makeVault(join(home, "school2"));
    const bare = join(home, "school2.git");
    sh(home, "git", ["init", "--bare", "-q", "-b", "master", bare]);
    const secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary" });
    writeFileSync(
      join(home, "mission-engine.localstorage"),
      JSON.stringify({
        vault_chat_model: "openai/gpt-5.6-sol",
        vault_chat_assistant_model: "openai/gpt-5.6-sol",
        vault_chat_supervisor_model: "openai/gpt-5.6-sol",
        vault_chat_worker_model: "openai/gpt-5.6-sol",
      }),
    );
    or = await fakeOpenRouter("ok");
    srv = await startServer({ home, vault, bare, secrets, openrouter: or.url, bundle, extra: { NODE_PATH: "" } });
  });

  afterAll(async () => {
    if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
    await srv?.stop();
    await or?.close();
    cleanup(home);
  });

  it("runs from a directory with nothing but the bundle", () => {
    expect(readdirSync(dirname(bundle))).toEqual(["vault-chat-server.mjs"]);
    expect(ancestorsWithNodeModules(dirname(bundle))).toEqual([]);
  });

  it("boots and stays up: health and /phone", async () => {
    expect(srv.logs()).toContain("listening on");
    // The crash on the box came after "listening", when the scheduler loaded.
    await new Promise((r) => setTimeout(r, 3000));
    expect(srv.proc.exitCode).toBeNull();
    // pdf.js still prints one harmless warning that its optional native
    // canvas is absent (page rendering is unavailable; text extraction works).
    const logs = srv.logs().replace(/Warning: Cannot load "@napi-rs\/canvas"[\s\S]*?vault-chat-server\.mjs"\.\n?/, "");
    expect(logs).not.toMatch(/FATAL|DOMMatrix is not defined|Cannot find (module|package)|is not defined/);
    const h = await (await fetch(srv.base + "/api/v1/health")).json();
    expect(h.ok).toBe(true);
    expect(h.git).toBe("ok");
    const p = await fetch(srv.base + "/phone");
    expect(p.status).toBe(200);
    expect(await p.text()).toContain("<html");
  });

  it("serves git: clone over HTTP", async () => {
    await waitFor(() => {
      try {
        return sh(home, "git", ["--git-dir", join(home, "school2.git"), "rev-parse", "refs/heads/box"]).trim();
      } catch {
        return null;
      }
    }, 30_000);
    const dst = join(home, "laptop");
    sh(home, "git", ["clone", "-q", `${srv.base}/git/school2.git`, dst]);
    expect(git(dst, "show", "origin/box:README.md")).toBe("# Test vault\n");
  });

  it("PdfExtract reads a PDF's text inside a real agent turn", async () => {
    const pdf = join(vault, "notes", "slides.pdf");
    writeFileSync(pdf, tinyPdf("Hello from the PDF"));
    or.script.push({ toolCall: { name: "PdfExtract", args: { path: pdf.replace(/\\/g, "/") } } }, { text: "The PDF says hello." });
    const before = or.calls.length;
    const r = await fetch(srv.base + "/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "What does notes/slides.pdf say?" }),
    });
    expect((await r.json()).ok).toBe(true);
    // The second completion carries the tool result back to the model.
    if (process.env.VC_TEST_LOGS) setTimeout(() => console.log("CALLS", JSON.stringify(or.calls.slice(before).map((c) => ({ model: c.model, tools: (c.tools ?? []).map((t: any) => t.function?.name), last: c.messages?.slice(-2) })), null, 1).slice(0, 4000)), 15_000);
    const followUp = await waitFor(() => or.calls.slice(before).find((c) => JSON.stringify(c.messages ?? []).includes('"role":"tool"')), 60_000);
    const toolMsg = JSON.stringify(followUp.messages.filter((m: any) => m.role === "tool"));
    expect(toolMsg).toContain("Hello from the PDF");
    expect(toolMsg).not.toContain("PDF extraction failed");
  });
});
