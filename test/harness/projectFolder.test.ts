// A project's folder on the box, from the laptop (src/boxFiles.ts, src/projects.ts createProjectThread,
// src/NewProjectForm.tsx): a `box:` path is read and written through the box's routes (never this disk), any
// other path through Tauri as before; "+ New project" sends where it works; the chooser browses the box.
// The box here is a small HTTP stand-in for server/http.ts's routes (the real routes: server/test/projectFolders.test.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-projfolder-");
const fake = installFakeTauri(vault);
const g = globalThis as any;
if (typeof g.dispatchEvent !== "function") g.dispatchEvent = () => true;

const disk = new Map<string, string>([["/home/carl/github/vault-chat/README.md", "# vault-chat\n"]]);
const posts: { path: string; body: any }[] = [];
let url = "";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const u = new URL(req.url!, "http://x");
    const send = (s: number, v: unknown) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (req.method === "POST") {
      const b = JSON.parse(body || "{}");
      posts.push({ path: u.pathname, body: b });
      if (u.pathname === "/api/v1/vault/file") {
        if (!String(b.path).startsWith("/home/carl/github/vault-chat/")) return send(403, { error: "not in a project's folder" });
        disk.set(b.path, b.text);
        return send(200, { ok: true });
      }
      if (u.pathname === "/projects") return send(200, { ok: true, slug: "lecture-tools", name: b.name, convId: "project-lecture-tools", created: true, ...(b.folder ? { folder: b.folder } : {}) });
      return send(404, { error: "not found" });
    }
    if (u.pathname === "/api/v1/vault/file") {
      const t = disk.get(u.searchParams.get("path") ?? "");
      return t === undefined ? send(403, { error: "no" }) : send(200, { path: u.searchParams.get("path"), base64: Buffer.from(t).toString("base64") });
    }
    if (u.pathname === "/api/v1/box/dir") return send(200, { entries: [{ name: "src", path: "/home/carl/github/vault-chat/src", is_dir: true }, { name: "README.md", path: "/home/carl/github/vault-chat/README.md", is_dir: false }] });
    if (u.pathname === "/api/v1/box/folders") return send(200, { path: u.searchParams.get("path") ?? "/home/carl", parent: "/home", home: "/home/carl", ok: false, dirs: [{ name: "github", path: "/home/carl/github", is_dir: true, ok: true }] });
    if (u.pathname.endsWith("/projects")) return send(200, { projects: [] });
    return send(404, { error: "not found" });
  });
});

async function fetchVia(u: string, init: RequestInit) {
  const r = await fetch(u, init);
  return { status: r.status, body: await r.text() };
}

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
  fake.setHandler("vault_box_config", () => ({ box: url }));
  fake.setHandler("box_get_json", ({ url: u }) => fetchVia(u, { method: "GET" }));
  fake.setHandler("box_post_json", ({ url: u, body }) => fetchVia(u, { method: "POST", body, headers: { "content-type": "application/json" } }));
  const { useStore } = await import("../../src/store.ts");
  useStore.setState({ vaultPath: vault });
});
after(() => server.close());

test("a box: path is read and written through the box's file route; never this disk", async () => {
  const bf = await import("../../src/boxFiles.ts");
  const p = bf.boxPathOf("/home/carl/github/vault-chat/README.md");
  assert.equal(p, "box:/home/carl/github/vault-chat/README.md");
  assert.equal(bf.isBoxPath(p), true);
  assert.equal(await bf.readTextAt(p), "# vault-chat\n");
  await bf.writeTextAt(p, "# vault-chat\n\nEdited.\n");
  assert.equal(disk.get("/home/carl/github/vault-chat/README.md"), "# vault-chat\n\nEdited.\n");
  assert.equal(fake.calls.filter((c) => c.cmd === "write_text_file" || c.cmd === "read_text_file").length, 0);
  // Outside a project's folder the box refuses, and the app says so.
  await assert.rejects(bf.writeTextAt("box:/home/carl/.ssh/x", "no"), /not in a project's folder/);
});

test("any other path is this disk's, as before", async () => {
  const bf = await import("../../src/boxFiles.ts");
  const local = path.join(vault, "note.md").replace(/\\/g, "/");
  await bf.writeTextAt(local, "local\n");
  assert.equal(fs.readFileSync(local, "utf8"), "local\n");
  assert.equal(await bf.readTextAt(local), "local\n");
});

test("the tree's listing and the chooser come from the box", async () => {
  const bf = await import("../../src/boxFiles.ts");
  assert.deepEqual((await bf.listBoxDir("/home/carl/github/vault-chat")).map((e) => [e.name, e.is_dir]), [["src", true], ["README.md", false]]);
  const f = await bf.browseBoxFolders();
  assert.equal(f.home, "/home/carl");
  assert.equal(bf.tildePath("/home/carl/github/vault-chat", f.home), "~/github/vault-chat");
  assert.equal(bf.tildePath("/home/carl", f.home), "~");
  assert.equal(bf.tildePath("/srv/data", f.home), "/srv/data");
});

test("+ New project sends where it works: a chosen folder, a new ~/projects/<name>, or nothing (the vault)", async () => {
  const projects = await import("../../src/projects.ts");
  posts.length = 0;
  assert.equal((await projects.createProjectThread("Lecture Tools", { folder: "/home/carl/github/AgentOS" })).ok, true);
  assert.equal((await projects.createProjectThread("Lecture Tools", { newFolder: true })).ok, true);
  assert.equal((await projects.createProjectThread("Lecture Tools")).ok, true);
  assert.deepEqual(
    posts.filter((p) => p.path.endsWith("/projects")).map((p) => p.body),
    [{ name: "Lecture Tools", folder: "/home/carl/github/AgentOS" }, { name: "Lecture Tools", newFolder: true }, { name: "Lecture Tools" }],
  );
});

test("the form: the name first; where it works only once the box answers (laptop only)", async () => {
  const { NewProjectForm } = await import("../../src/NewProjectForm.tsx");
  const html = renderToStaticMarkup(createElement(NewProjectForm, { onCreate: () => {}, onCancel: () => {} }));
  assert.match(html, /data-el="new-project-name"/);
  assert.match(html, /Project name, then Enter/);
  assert.doesNotMatch(html, /folder-pick/);
});
