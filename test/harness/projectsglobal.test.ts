// Projects are the machine's (server/projectsHome.ts): the laptop's left panel and the phone's list show the same
// projects and the same project threads whatever vault is open. The box here is a small HTTP stand-in that answers
// with the REAL server pieces — the projects home (server/context/projects.ts) and each vault's feed, its own log
// plus the projects' (server/convlog/log.ts RoutedLog) — for two vaults, school2 and physics. The laptop's own code
// asks it (src/projects.ts listProjects in box mode, src/threads.ts panelModel); the phone's list is the same
// panelModel over the same routes with ?vault= (phone/src/boot.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vc-projglobal-"));
const school2 = path.join(root, "vaults", "school2");
const physics = path.join(root, "vaults", "physics");
const home = path.join(root, ".projects");
for (const d of [school2, physics, home]) fs.mkdirSync(d, { recursive: true });

const { setProjectsHomeLog, convLog } = await import("../../server/convlog/log.ts");
const { configureContext, listProjects } = await import("../../server/context/index.ts");
setProjectsHomeLog(home);
configureContext({ vault: school2, projectsHome: home });
for (const [slug, name] of [["vault-chat", "vault-chat"], ["psych-221", "Psych 221"]]) {
  fs.mkdirSync(path.join(home, slug), { recursive: true });
  fs.writeFileSync(path.join(home, slug, "project.md"), `# ${name}\n`);
}
const meta = (v: string, id: string, patch: Record<string, unknown>) => convLog(v).emit(id, { type: "meta", patch: { createdAt: 1, lastActivityAt: Date.now(), ...patch } });
meta(school2, "main", { title: "Main", kind: "main", source: "main" });
meta(physics, "main", { title: "Main", kind: "main", source: "main" });
// Project threads, written through either vault: they land in the projects home's log.
meta(school2, "project-vault-chat", { title: "vault-chat", kind: "project", source: "project", project: "vault-chat" });
meta(physics, "project-psych-221", { title: "Psych 221", kind: "project", source: "project", project: "psych-221" });
// A separate chat of physics only.
meta(physics, "cphys", { title: "Optics lab", kind: "separate", source: "phone" });

const byName: Record<string, string> = { school2, physics };
let url = "";
const asked: string[] = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url!, "http://x");
  const v = byName[u.searchParams.get("vault") ?? "school2"]!;
  asked.push(`${u.pathname}?vault=${u.searchParams.get("vault") ?? ""}`);
  const send = (s: number, b: unknown) => {
    res.writeHead(s, { "content-type": "application/json" });
    res.end(JSON.stringify(b));
  };
  // The routes' bodies as server/http.ts answers them (GET /projects: server/projectRoutes.ts projectsList).
  if (u.pathname === "/projects") return send(200, { projects: listProjects().map((p) => ({ slug: p.slug, name: p.name, notes: path.join(p.dir, "project.md").split(path.sep).join("/") })) });
  if (u.pathname === "/api/v1/vault/file") {
    const p = u.searchParams.get("path") ?? "";
    if (!path.resolve(p).startsWith(path.resolve(home))) return send(403, { error: "not in a project's folder" });
    return send(200, { path: p, base64: fs.readFileSync(p).toString("base64") });
  }
  if (u.pathname === "/conversations") return send(200, { conversations: convLog(v).rows().map((r) => ({ id: r.id, title: r.title, kind: r.kind, source: r.source, lastActivityAt: r.lastActivityAt })) });
  if (u.pathname === "/api/v2/conversations") return send(200, { rows: convLog(v).rows(), seq: convLog(v).latest(), epoch: convLog(v).epoch });
  return send(404, { error: "not found" });
});

const laptopVault = makeTempVault("vc-projglobal-laptop-").replace(/\\/g, "/");
const laptopVault2 = makeTempVault("vc-projglobal-laptop2-").replace(/\\/g, "/");
const fake = installFakeTauri(laptopVault);
async function fetchVia(u: string, init: RequestInit) {
  const r = await fetch(u, init);
  return { status: r.status, body: await r.text() };
}

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
  // The laptop's two vaults, each linked to its vault on the box.
  fake.setHandler("vault_box_config", ({ vault: v }: any) => (v === laptopVault ? { box: url, vault: "school2" } : v === laptopVault2 ? { box: url, vault: "physics" } : null));
  fake.setHandler("box_get_json", ({ url: u }: any) => fetchVia(u, { method: "GET" }));
  fake.setHandler("prepare_agent_projects", () => ({ moved: [], kept: [], hidden: false }));
});
after(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the laptop: switching the vault leaves the project list and the panel's projects the same; only Main and the vault's own chats change", async () => {
  const { useStore } = await import("../../src/store.ts");
  const projects = await import("../../src/projects.ts");
  const { panelModel } = await import("../../src/threads.ts");
  const panelFor = async (vault: string) => {
    useStore.setState({ vaultPath: vault } as any);
    const list = await projects.listProjects(vault);
    const name = vault === laptopVault ? "school2" : "physics";
    const rows = (await (await fetch(`${url}/api/v2/conversations?vault=${name}`)).json()).rows;
    return { list, ...panelModel(rows, list, "main") };
  };
  const a = await panelFor(laptopVault);
  const b = await panelFor(laptopVault2);
  assert.deepEqual(a.list.map((p) => [p.slug, p.name]), [["psych-221", "Psych 221"], ["vault-chat", "vault-chat"]]);
  assert.deepEqual(b.list, a.list, "the same projects in both vaults");
  const projEntries = (x: typeof a) => x.entries.filter((e) => e.type === "project").map((e: any) => [e.id, e.title]);
  assert.deepEqual(projEntries(b), projEntries(a));
  assert.deepEqual(projEntries(a), [["project-psych-221", "Psych 221"], ["project-vault-chat", "vault-chat"]]);
  // Main, then the projects, then "+ New project" — in both.
  for (const x of [a, b]) assert.deepEqual(x.entries.map((e) => e.type), ["main", "project", "project", "new-project"]);
  // The vault's own chats differ: physics' separate chat is only in physics.
  assert.deepEqual(a.others.map((c) => c.id), []);
  assert.deepEqual(b.others.map((c) => c.id), ["cphys"]);
  // The laptop asked each vault's box link, never a local folder (box mode).
  assert.ok(asked.includes("/projects?vault=school2") && asked.includes("/projects?vault=physics"));
  assert.equal(fs.existsSync(path.join(laptopVault, "agent-projects")), false);
});

test("the laptop's Project notes opens the project's project.md on the box (the projects home), from either vault", async () => {
  const { useStore } = await import("../../src/store.ts");
  const projects = await import("../../src/projects.ts");
  for (const v of [laptopVault, laptopVault2]) {
    useStore.setState({ vaultPath: v, currentFile: null } as any);
    const opened = await projects.openProjectNotes("psych-221", "Psych 221");
    assert.equal(opened, `box:${path.join(home, "psych-221", "project.md").split(path.sep).join("/")}`);
    assert.equal(useStore.getState().currentFile, opened);
    assert.equal(useStore.getState().currentContent, "# Psych 221\n");
    assert.equal(fs.existsSync(path.join(v, "agent-projects")), false, "nothing written in the vault");
  }
});

test("the phone: the same list from /conversations and /projects with ?vault= (its boot.ts), whatever vault the page shows", async () => {
  const { panelModel } = await import("../../src/threads.ts");
  const phoneList = async (vault: string) => {
    const q = `?vault=${vault}`;
    const projects = (await (await fetch(`${url}/projects${q}`)).json()).projects;
    const convs = (await (await fetch(`${url}/conversations${q}`)).json()).conversations;
    return panelModel(convs, projects, "main").entries.map((e: any) => [e.type, e.id ?? "", e.title ?? ""]);
  };
  const s = await phoneList("school2");
  const p = await phoneList("physics");
  assert.deepEqual(p, s);
  assert.deepEqual(s, [
    ["main", "main", "Main"],
    ["project", "project-psych-221", "Psych 221"],
    ["project", "project-vault-chat", "vault-chat"],
    ["new-project", "", ""],
  ]);
});
