// A project's folder anywhere on the box (Carl, 2026-10-27: "a vault is my UI thing, projects are general
// machine-path stuff", modelled on Claude Code). Two halves:
//   - the walls, pure: which folders may be a project's, and the sandbox argv the engine builds (the folder bound
//     read-write, nothing else new, what is hidden stays hidden inside it). The argv itself runs under real
//     bubblewrap on Linux (the last test; the box runs it);
//   - end to end, the real bundle and engine on the fake pi (fakePiCli.mjs: pi's RPC, its context-file loading
//     and its write tool) with a fake OpenRouter: "Make this a project" on a folder outside the vault, its thread's
//     pi in that folder with its AGENTS.md, its writes there, a system path refused, the file tree's listing,
//     reading and writing its files, and Delete/Restore leaving the folder untouched.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, fakeOpenRouter, startServer, waitFor, type Running, type FakeOpenRouter } from "./helpers";

const fwd = (p: string) => p.split("\\").join("/");

describe("which folders may be a project's", () => {
  const home = tmp("vcpf-home-");
  const vault = join(home, "vaults", "school2");
  const state = join(home, ".local", "state", "vault-chat-server");
  const keys = join(home, ".config", "vault-chat");
  let pf: typeof import("../projectFolders");
  let walls: import("../projectFolders").FolderWalls;
  beforeAll(async () => {
    for (const d of [join(vault, "courses", "psych"), join(vault, ".vault-chat", "local"), join(home, "vaults", "physics"), join(home, "github", "vault-chat"), join(home, "machine"), join(home, ".ssh"), state, keys, join(home, "projects")])
      mkdirSync(d, { recursive: true });
    pf = await import("../projectFolders");
    walls = { home, protect: () => [state, keys, join(home, "vaults"), join(home, "vaults", "physics")] };
  });
  afterAll(() => cleanup(home));
  const ok = (p: string) => pf.checkFolder(vault, p, walls);

  it("any folder of his on the box: a checkout, ~/machine, ~/projects/x, ~/-paths, a folder in the vault", () => {
    expect(ok(join(home, "github", "vault-chat"))).toEqual({ abs: join(home, "github", "vault-chat") });
    expect(ok(join(home, "machine"))).toEqual({ abs: join(home, "machine") });
    expect(ok("~/github/vault-chat/")).toEqual({ abs: join(home, "github", "vault-chat") });
    expect(ok(join(vault, "courses", "psych"))).toEqual({ abs: join(vault, "courses", "psych") });
  });

  it("refused, each with a line saying why: the root, the home, credentials, the server's state, the key store, other vaults, around the vault", () => {
    const why = (p: string) => {
      const r = ok(p);
      return "error" in r ? r.error : "";
    };
    expect(why(process.platform === "win32" ? "C:\\" : "/")).toMatch(/whole machine/);
    expect(why(home)).toMatch(/your whole home folder/);
    expect(why("~/.ssh")).toBe("~/.ssh is off limits: the agent never touches it");
    expect(why(join(home, ".ssh", "keys"))).toMatch(/inside ~\/\.ssh, which the agent never touches|does not exist/);
    expect(why(state)).toMatch(/inside ~\/\.local\/state|off limits/);
    expect(why(join(home, ".local"))).toMatch(/^~\/\.local holds ~\/\.local\/(state|share)/);
    expect(why(keys)).toMatch(/^~\/\.config\/vault-chat is off limits/);
    expect(why(join(home, "vaults", "physics"))).toMatch(/inside ~\/vaults/);
    expect(why(join(home, "vaults"))).toMatch(/inside ~\/vaults|holds/);
    expect(why(join(vault, ".vault-chat"))).toMatch(/^~\/vaults\/school2\/\.vault-chat is off limits/);
    expect(why(join(home, "nope"))).toMatch(/does not exist/);
    expect(why("github/vault-chat")).toMatch(/not a full path/);
    if (process.platform !== "win32") {
      expect(why("/etc")).toMatch(/system folder \(\/etc\)/);
      expect(why("/nix/store")).toMatch(/system folder \(\/nix\)/);
    }
  });

  it("the registry is the server's: register, retire with a delete, revive with a restore", () => {
    const w = pf.registerFolder(vault, "vc", join(home, "github", "vault-chat"));
    expect("abs" in w).toBe(true);
    expect(fwd(pf.FOLDERS_FILE)).toBe(".vault-chat/local/project-folders.json");
    expect(pf.activeFolders(vault).map((f) => f.slug)).toEqual(["vc"]);
    pf.retireFolder(vault, "vc", "vc-20261027-120000");
    expect(pf.activeFolders(vault)).toEqual([]);
    pf.reviveFolder(vault, "vc-20261027-120000", "vc");
    expect(pf.registeredFolder(vault, "vc")).toBe(join(home, "github", "vault-chat"));
    // The agent can't name one: a folder becomes a project only through the registry (the server's own state).
    expect(readdirSync(join(vault, ".vault-chat", "local"))).toContain("project-folders.json");
  });
});

describe("the sandbox: exactly the registered folders, read-write; nothing else new", () => {
  const home = tmp("vcpf-sb-");
  const vault = join(home, "vaults", "school2");
  const state = join(home, ".local", "state", "vault-chat-server");
  const secrets = join(home, ".config", "vault-chat");
  const proj = join(home, "github", "vault-chat");
  const planted = join(proj, ".ssh-copy");
  let sb: import("../engine/pi/backend").PiSandbox;
  let backend: typeof import("../engine/pi/backend");
  const at = (argv: string[], ...m: string[]) => {
    for (let i = 0; i + m.length <= argv.length; i++) if (m.every((x, j) => argv[i + j] === x)) return i;
    return -1;
  };
  beforeAll(async () => {
    for (const d of [join(vault, ".vault-chat", "conversations"), join(vault, ".vault-chat", "local"), join(state, "pi", "sessions"), join(state, "pi", "agent"), secrets, proj, join(home, "machine"), join(home, ".ssh"), planted])
      mkdirSync(d, { recursive: true });
    await import("../shims/globals");
    const { buildSandbox } = await import("../engine/index");
    backend = await import("../engine/pi/backend");
    const base = buildSandbox({ bwrap: "/usr/bin/bwrap", home, stateDir: state, secretsDir: secrets, hideFiles: [], sessionsDir: join(state, "pi", "sessions"), agentDir: join(state, "pi", "agent"), vault, uid: -1, envFile: join(home, "none.env") });
    // A path the sandbox hides that lies inside a project folder (as if a credential dir were there).
    sb = { ...base, hidden: [...(base.hidden ?? []), planted], projects: () => [proj] };
  });
  afterAll(() => cleanup(home));

  it("the folder is bound read-write after the read-only home, in pi's layer and every command's", () => {
    for (const argv of [backend.outerWith(sb)!, backend.shellWith(sb)!]) {
      const ro = at(argv, "--ro-bind", home, home);
      expect(at(argv, "--bind", proj, proj)).toBeGreaterThan(ro);
      expect(argv.at(-1)).toBe("--");
      // ~/machine (not a project folder) stays read-only with the home.
      expect(at(argv, "--bind", join(home, "machine"), join(home, "machine"))).toBe(-1);
      // What is hidden stays hidden inside it: re-hidden after the bind (a later mount wins).
      expect(at(argv, "--tmpfs", planted)).toBeGreaterThan(at(argv, "--bind", proj, proj));
    }
  });

  it("no project folder: the argv is exactly as before", () => {
    const plain = { ...sb, projects: () => [] };
    expect(backend.outerWith(plain)).toEqual(sb.outer);
    expect(backend.shellWith(plain)).toEqual(sb.shell);
    // A folder that went away is not bound.
    expect(backend.outerWith({ ...sb, projects: () => [join(home, "gone")] })).toEqual(sb.outer);
  });

  const bwrap = (() => {
    if (process.platform !== "linux") return null;
    const r = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  })();
  it.skipIf(!bwrap)("under real bubblewrap: writes in the project folder land; elsewhere in the home they are refused; hidden stays hidden", () => {
    writeFileSync(join(planted, "id_ed25519"), "SECRET");
    const real = { ...sb, outer: sb.outer!.map((x) => (x === "/usr/bin/bwrap" ? bwrap! : x)) };
    const argv = backend.outerWith(real)!;
    const run = (cmd: string) => spawnSync(argv[0]!, [...argv.slice(1), "sh", "-c", cmd], { encoding: "utf8" });
    expect(run(`echo hi > '${proj}/ok.txt'`).status).toBe(0);
    expect(readFileSync(join(proj, "ok.txt"), "utf8")).toBe("hi\n");
    const elsewhere = run(`echo no > '${home}/machine/x.txt'`);
    expect(elsewhere.status).not.toBe(0);
    expect(elsewhere.stderr).toMatch(/Read-only file system/);
    expect(existsSync(join(home, "machine", "x.txt"))).toBe(false);
    expect(run(`cat '${planted}/id_ed25519'`).status).not.toBe(0);
  });
});

describe("end to end: a project working in a folder outside the vault (real engine, fake pi)", () => {
  let home: string, vault: string, secrets: string, folder: string;
  let or: FakeOpenRouter;
  let srv: Running;
  const get = async (p: string) => {
    const r = await fetch(srv.base + p);
    return { status: r.status, body: await r.json() };
  };
  const post = async (p: string, b: Record<string, unknown>) => {
    const r = await fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json() };
  };
  const sessionsDir = () => join(home, "state", "pi", "sessions");
  const sessionCwd = (marker: string) => {
    for (const n of readdirSync(sessionsDir()).filter((f) => f.endsWith(".jsonl"))) {
      const text = readFileSync(join(sessionsDir(), n), "utf8");
      if (text.includes(marker)) return JSON.parse(text.split("\n")[0]!).cwd as string;
    }
    return null;
  };

  beforeAll(async () => {
    home = tmp("vcpf-e2e-");
    vault = makeVault(join(home, "vaults", "school2"));
    folder = join(home, "github", "vault-chat");
    mkdirSync(join(folder, "src"), { recursive: true });
    writeFileSync(join(folder, "AGENTS.md"), "# vault-chat\n\nPROJECT-AGENTS-MARKER: run the gates before you push.\n");
    writeFileSync(join(folder, "README.md"), "# vault-chat\n");
    writeFileSync(join(folder, "src", "main.ts"), "export {};\n");
    mkdirSync(join(folder, ".git"), { recursive: true });
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

  it("a system path, the home, or a folder that is not there is refused with a clear line, and nothing is made", async () => {
    for (const [f, why] of [
      [process.platform === "win32" ? "C:\\" : "/", /whole machine/],
      [home, /your whole home folder/],
      [join(home, "secrets"), /never touches/],
      [join(home, "nope"), /does not exist/],
      ...(process.platform === "win32" ? [] : [["/etc", /system folder/] as const]),
    ] as const) {
      const r = await post("/projects", { name: "Bad", folder: f });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(why);
    }
    expect(existsSync(join(vault, "agent-projects", "bad"))).toBe(false);
  });

  it("Make this a project on a folder on the box: its thread runs pi in that folder, which loads its AGENTS.md", async () => {
    const r = await post("/projects", { folder: fwd(folder) });
    // The project is named after its folder.
    expect(r.body).toMatchObject({ ok: true, slug: "vault-chat", name: "vault-chat", convId: "project-vault-chat", created: true, folder: fwd(folder), vault: "school2" });
    // Its memory is in the folder; the choice is the server's (the registry), never the agent's.
    expect(readFileSync(join(folder, ".vault-chat", "memory.md"), "utf8")).toBe("# vault-chat: memory\n");
    expect(JSON.parse(readFileSync(join(vault, ".vault-chat", "local", "project-folders.json"), "utf8")).folders["vault-chat"].path).toBe(folder);
    expect((await get("/projects")).body.projects).toContainEqual({ slug: "vault-chat", name: "vault-chat", folder: fwd(folder), vault: "school2", rel: null });

    const s = await post("/api/v2/intent", { type: "send", clientId: "c-pf-1", convId: "project-vault-chat", text: "Hello in the checkout, CWD-MARKER." });
    expect(s.body).toMatchObject({ ok: true, convId: "project-vault-chat" });
    await waitFor(() => or.calls.some((c) => JSON.stringify(c).includes("CWD-MARKER")), 30_000);
    expect(sessionCwd("CWD-MARKER")).toBe(folder);
    const sent = JSON.stringify(or.calls.find((c) => JSON.stringify(c).includes("CWD-MARKER")));
    expect(sent).toContain("PROJECT-AGENTS-MARKER: run the gates before you push.");
    expect(sent).toContain(`${fwd(folder)}/ is this project's folder on the box`);
    expect(sent).toContain(`${fwd(folder)}/.vault-chat/memory.md`);
  });

  it("its writes land in the folder (relative to it); none of it reaches the vault", async () => {
    or.script.push({ toolCall: { name: "write", args: { path: "NOTES.md", content: "written by the agent\n" } } });
    const s = await post("/api/v2/intent", { type: "send", clientId: "c-pf-2", convId: "project-vault-chat", text: "Write NOTES.md, WRITE-MARKER." });
    expect(s.body.ok).toBe(true);
    await waitFor(() => existsSync(join(folder, "NOTES.md")), 30_000);
    expect(readFileSync(join(folder, "NOTES.md"), "utf8")).toBe("written by the agent\n");
    expect(existsSync(join(vault, "NOTES.md"))).toBe(false);
  });

  it("Main is still the vault's: its pi runs in the vault, the folder named in its list of projects", async () => {
    const s = await post("/api/v2/intent", { type: "send", clientId: "c-pf-3", text: "Main here, MAIN-MARKER." });
    expect(s.body).toMatchObject({ ok: true, convId: "main" });
    await waitFor(() => or.calls.some((c) => JSON.stringify(c).includes("MAIN-MARKER")), 30_000);
    expect(sessionCwd("MAIN-MARKER")).toBe(vault);
    const sent = JSON.stringify(or.calls.find((c) => JSON.stringify(c).includes("MAIN-MARKER")));
    expect(sent).toContain(`- vault-chat: ${fwd(folder)}`);
    expect(sent).not.toContain("PROJECT-AGENTS-MARKER");
  });

  it("opening and editing a file: read through the box file route, Carl's edit written back to the box", async () => {
    const p = fwd(join(folder, "README.md"));
    const r = await get(`/api/v1/vault/file?path=${encodeURIComponent(p)}`);
    expect(r.status).toBe(200);
    expect(Buffer.from(r.body.base64, "base64").toString("utf8")).toBe("# vault-chat\n");
    const w = await post("/api/v1/vault/file", { path: p, text: "# vault-chat\n\nEdited on the laptop.\n" });
    expect(w.body).toMatchObject({ ok: true });
    expect(readFileSync(join(folder, "README.md"), "utf8")).toBe("# vault-chat\n\nEdited on the laptop.\n");
    // Never outside a project's folder (a vault file, the home, a key) and never its .git.
    for (const bad of [fwd(join(vault, "x.md")), fwd(join(home, "x.md")), fwd(join(home, "secrets", "x")), fwd(join(folder, ".git", "config"))]) {
      expect((await post("/api/v1/vault/file", { path: bad, text: "no" })).status).toBe(403);
      expect(existsSync(bad)).toBe(false);
    }
  });

  it("+ New project by name: a new folder of that name in the open vault, made a project", async () => {
    const r = await post("/projects", { name: "Whiteboard Lab" });
    expect(r.body).toMatchObject({ ok: true, slug: "whiteboard-lab", name: "Whiteboard Lab", folder: fwd(join(vault, "Whiteboard Lab")) });
    expect(existsSync(join(vault, "Whiteboard Lab", ".vault-chat", "memory.md"))).toBe(true);
  });

  it("Delete leaves the folder and every file in it untouched (its listing gone with the project); Restore brings the choice back", async () => {
    const before = readdirSync(folder).sort();
    const d = await post("/api/v2/intent", { type: "deleteProject", slug: "vault-chat", client: "laptop" });
    expect(d.body).toMatchObject({ ok: true, slug: "vault-chat" });
    expect(readdirSync(folder).sort()).toEqual(before);
    expect(readFileSync(join(folder, "README.md"), "utf8")).toBe("# vault-chat\n\nEdited on the laptop.\n");
    expect(readFileSync(join(folder, "AGENTS.md"), "utf8")).toContain("PROJECT-AGENTS-MARKER");
    expect((await get("/projects")).body.projects.map((p: any) => p.slug)).not.toContain("vault-chat");
    // A deleted project's folder is no longer the app's (nor the sandbox's) to write.
    expect((await post("/api/v1/vault/file", { path: fwd(join(folder, "README.md")), text: "no" })).status).toBe(403);
    const back = await post("/api/v2/intent", { type: "restoreProject", slug: "vault-chat", client: "laptop" });
    expect(back.body).toMatchObject({ ok: true, slug: "vault-chat" });
    expect((await get("/projects")).body.projects).toContainEqual(expect.objectContaining({ slug: "vault-chat", name: "vault-chat", folder: fwd(folder) }));
    expect(readdirSync(folder).sort()).toEqual(before);
  });
});
