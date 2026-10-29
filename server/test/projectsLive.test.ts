// The live sequence, end to end on the real bundle: a box updated before the move keeps showing each vault's projects;
// then, server stopped, `vault-chat-server.mjs projects migrate --env <file>`; then the server again: the same project
// and its whole thread, now the machine's (the projects home), the same from every vault.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE, tmp, cleanup, makeVault, makeKeyStore, fakeOpenRouter, startServer, waitFor, type Running, type FakeOpenRouter } from "./helpers";

describe("the live sequence: update, then `projects migrate` with the server stopped, then the server again", () => {
  let home: string, vault: string, secrets: string;
  let or: FakeOpenRouter;
  let srv: Running | null = null;
  const env = () => ({ home, vault, secrets, openrouter: or.url });
  const get = async (p: string) => (await fetch(srv!.base + p)).json();
  const post = async (p: string, b: unknown) => (await fetch(srv!.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
  const projectsHome = () => join(home, ".local", "share", "vault-chat", "projects");
  const thread = async () => ((await get("/api/v2/conversations/project-coconut/events?after=0")).events ?? []).filter((e: any) => e.type === "entry").map((e: any) => JSON.stringify(e.entry?.message?.content ?? e.entry?.data ?? ""));

  beforeAll(async () => {
    home = tmp("vcplive-");
    vault = makeVault(join(home, "vaults", "school2"));
    // A project from before: in the vault (as the live box has them).
    mkdirSync(join(vault, "agent-projects", "coconut"), { recursive: true });
    writeFileSync(join(vault, "agent-projects", "coconut", "project.md"), "# Coconut\n\nTile the images.\n\n## Memory\n\n- 2026-10-20: overlap 128\n");
    secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary-not-real" });
    or = await fakeOpenRouter("Overlap is 128.");
  }, 60_000);
  afterAll(async () => {
    if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
    await srv?.stop();
    await or?.close();
    cleanup(home);
  });

  it("updated, not migrated yet: the vault's project and its thread are there as before", async () => {
    srv = await startServer(env());
    expect(srv.logs()).toMatch(/projects: still in their vaults/);
    expect((await get("/projects")).projects.map((p: any) => p.slug)).toEqual(["coconut"]);
    const s = await post("/api/v2/intent", { type: "send", clientId: "pl-1", convId: "project-coconut", text: "What overlap? BEFORE-MOVE" });
    expect(s).toMatchObject({ ok: true, convId: "project-coconut" });
    await waitFor(async () => (await thread()).some((t) => t.includes("Overlap is 128")), 30_000);
    expect(readdirSync(join(vault, ".vault-chat", "events"))).toContain("project-coconut.jsonl");
  }, 90_000);

  it("the CLI refuses while the server runs; stopped, it moves the project and its thread", async () => {
    const envFile = join(home, "server.env");
    writeFileSync(envFile, [`VC_VAULT=${vault}`, `VC_STATE_DIR=${join(home, "state")}`, `VC_PORT=${new URL(srv!.base).port}`, `VC_SECRETS_DIR=${secrets}`].join("\n") + "\n");
    const cli = (...a: string[]) => spawnSync(process.execPath, [BUNDLE, "projects", ...a, "--env", envFile], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: home, USERPROFILE: home } });
    const busy = cli("migrate");
    expect(busy.status).toBe(4);
    expect(busy.stderr).toMatch(/stop it first/);
    await srv!.stop();
    srv = null;
    const r = cli("migrate");
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    expect(out.problems).toEqual([]);
    expect(out.moved.map((m: any) => m.slug)).toEqual(["coconut"]);
    expect(existsSync(join(projectsHome(), "coconut", "project.md"))).toBe(true);
    expect(existsSync(join(vault, "agent-projects"))).toBe(false);
  }, 60_000);

  it("the server again: the same project and its whole thread, from the projects home; the conversation goes on", async () => {
    srv = await startServer(env());
    expect(srv.logs()).toMatch(/projects home/);
    expect((await get("/projects")).projects.map((p: any) => p.slug)).toEqual(["coconut"]);
    expect((await thread()).some((t) => t.includes("BEFORE-MOVE"))).toBe(true);
    or.reply = "Still 128.";
    const s = await post("/api/v2/intent", { type: "send", clientId: "pl-2", convId: "project-coconut", text: "And now? AFTER-MOVE" });
    expect(s).toMatchObject({ ok: true, convId: "project-coconut" });
    await waitFor(async () => (await thread()).some((t) => t.includes("Still 128")), 30_000);
    // The model got the project's memory from its new place.
    const sent = JSON.stringify(or.calls.at(-1));
    expect(sent).toContain("overlap 128");
    expect(sent).toContain("/.local/share/vault-chat/projects/coconut/project.md");
    expect(readFileSync(join(projectsHome(), ".vault-chat", "events", "project-coconut.jsonl"), "utf8")).toContain("pl-2");
  }, 90_000);
});
