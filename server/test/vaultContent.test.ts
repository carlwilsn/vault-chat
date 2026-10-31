// Temporary content only. No live vault, conversation, model, keys or listener.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registeredVaultContent } from "../engine/vaultContent";
import { outerWith, shellWith, PiBackend } from "../engine/pi/backend";
import { piPaths } from "../engine/pi/config";
import { filesystemBinding } from "../mcp/filesystem";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { findBwrap } from "../engine/pi/install";

const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-content-")); roots.push(root);
  const own = { name: "vc", path: join(root, "vaults/vc"), bare: join(root, "hub/vc.git"), main: true };
  const school = { name: "school2", path: join(root, "vaults/school2"), bare: join(root, "hub/school2.git"), main: false };
  for (const v of [own, school]) {
    for (const p of [v.path, v.bare, join(v.path, ".vault-chat/events"), join(v.path, ".git"), join(root, "state", v.name)]) mkdirSync(p, { recursive: true });
    writeFileSync(join(v.path, "Poll.md"), v.name === "school2" ? "8474915651" : "wrong basename");
    writeFileSync(join(v.path, ".vault-chat/events/private"), "private fixture");
  }
  let registered = [own, school];
  const content = registeredVaultContent(own, () => registered, v => [join(root, "state", v.name)]);
  const sb = { outer: ["bwrap", "--tmpfs", join(root, "vaults"), "--"], shell: ["bwrap", "--tmpfs", join(root, "vaults"), "--"],
    roots: [join(root, "vaults"), join(root, "hub")], denyRead: [join(root, "credentials")], denyWrite: [],
    vaultContent: () => content().folders, others: () => content().hidden };
  return { root, own, school, content, sb, set: (r: typeof registered) => { registered = r; } };
}
function mount(argv: string[], ...parts: string[]) { return argv.findIndex((_, i) => parts.every((p, j) => argv[i + j] === p)); }

describe("registered synced content is independent of project and conversation scope", () => {
  it.skipIf(!findBwrap())("real sandbox: cross-vault original edits land, shell agrees, private metadata/main/unregistered/symlink escapes stay inaccessible", async () => {
    const f = fixture();
    await import("../shims/globals");
    const { buildSandbox } = await import("../engine/index");
    const cwd = join(f.root, "agent-work/vc/changes/project");
    const sessions = join(f.root, "state/pi/sessions");
    const agent = join(f.root, "state/pi/agent");
    const main = join(f.school.path, "service-owned-main");
    const unregistered = join(f.root, "vaults/unregistered");
    const otherWorktree = join(f.root, "agent-work/other-vault/changes/branch");
    const projectPrivate = ["events", "conversations", "local"].map(d => join(main, ".vault-chat", d));
    for (const p of [cwd, sessions, agent, main, unregistered, otherWorktree, ...projectPrivate, ...f.sb.denyRead]) mkdirSync(p, { recursive: true });
    writeFileSync(join(main, "source"), "main-original");
    writeFileSync(join(otherWorktree, "source"), "other-worktree-original");
    for (const p of projectPrivate) writeFileSync(join(p, "private"), "PROJECT-PRIVATE-CANARY");
    writeFileSync(join(unregistered, "private"), "UNREGISTERED-CANARY");
    writeFileSync(join(f.sb.denyRead[0]!, "private"), "CREDENTIAL-CANARY");
    symlinkSync(unregistered, join(f.school.path, "escape"));
    const sb = { ...buildSandbox({ bwrap: findBwrap(), home: f.root, stateDir: join(f.root, "state"), secretsDir: f.sb.denyRead[0]!, hideFiles: [],
      sessionsDir: sessions, agentDir: agent, vault: f.own.path, uid: -1, workDir: join(f.root, "agent-work/vc"), vaultRoots: f.sb.roots }),
      others: f.sb.others, vaultContent: f.sb.vaultContent, readOnly: () => [main] };
    const outer = outerWith(sb)!;
    const run = (command: string) => spawnSync(outer[0]!, [...outer.slice(1), "sh", "-c", command], { encoding: "utf8", cwd });
    const prefix = process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0");
    const fs = await filesystemBinding({ cli: join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), node: process.execPath,
      script: resolve("server/engine/pi/ext/filesystem.mjs"), cwd, home: f.root, outer, shell: shellWith(sb),
      denyRead: [...sb.denyRead, ...f.content().hidden], denyWrite: sb.denyWrite, allowed: ["read", "edit", "write", "bash"], env: () => ({}), fileWrite: async () => true });
    const call = (name: string, args: any) => fs.call(name, args, { signal: new AbortController().signal });
    expect(await call("edit", { path: join(f.school.path, "Poll.md"), edits: [{ oldText: "8474915651", newText: "cross-vault-edited" }] })).toMatchObject({ ok: true });
    expect(readFileSync(join(f.school.path, "Poll.md"), "utf8")).toBe("cross-vault-edited");
    expect(run(`cat '${f.school.path}/Poll.md'`).stdout).toBe("cross-vault-edited");
    expect(await call("bash", { command: `printf shell-edited > '${f.school.path}/Poll.md'` })).toMatchObject({ ok: true });
    expect(readFileSync(join(f.school.path, "Poll.md"), "utf8")).toBe("shell-edited");
    const originalInode = statSync(join(f.school.path, "Poll.md")).ino;
    expect(await call("write", { path: join(f.school.path, "Poll.md"), content: "" })).toMatchObject({ ok: true });
    expect(readFileSync(join(f.school.path, "Poll.md"), "utf8")).toBe("");
    expect(await call("bash", { command: `mv '${f.school.path}/Poll.md' '${f.school.path}/vc planning.md'` })).toMatchObject({ ok: true });
    expect(existsSync(join(f.school.path, "Poll.md"))).toBe(false);
    expect(statSync(join(f.school.path, "vc planning.md")).ino).toBe(originalInode);
    expect(await call("write", { path: join(f.school.path, "vc planning.md"), content: "# VC planning\n\n- Pure client/surface for any AI.\n" })).toMatchObject({ ok: true });
    expect(readFileSync(join(f.school.path, "vc planning.md"), "utf8")).toContain("Pure client/surface for any AI.");
    for (const path of [join(main, "source"), join(otherWorktree, "source"), ...projectPrivate.map(p => join(p, "private")), join(f.school.path, ".vault-chat/events/private"), join(unregistered, "private"), join(f.school.path, "escape/private"), join(f.sb.denyRead[0]!, "private")]) {
      expect(await call("write", { path, content: "forbidden" }), path).toMatchObject({ ok: false });
      expect(run(`printf forbidden > '${path}'`).status, path).not.toBe(0);
    }
    for (const path of [...projectPrivate.map(p => join(p, "private")), join(f.school.path, ".vault-chat/events/private"), join(unregistered, "private"), join(f.school.path, "escape/private"), join(f.sb.denyRead[0]!, "private")]) {
      expect(run(`cat '${path}'`).status).not.toBe(0);
      expect(await call("read", { path })).toMatchObject({ ok: false });
    }
    expect(readFileSync(join(main, "source"), "utf8")).toBe("main-original");
    expect(readFileSync(join(otherWorktree, "source"), "utf8")).toBe("other-worktree-original");
    for (const p of projectPrivate) expect(readFileSync(join(p, "private"), "utf8")).toBe("PROJECT-PRIVATE-CANARY");
    expect(readFileSync(join(unregistered, "private"), "utf8")).toBe("UNREGISTERED-CANARY");
    expect(readFileSync(join(f.sb.denyRead[0]!, "private"), "utf8")).toBe("CREDENTIAL-CANARY");
    expect(readFileSync(join(f.school.path, ".vault-chat/events/private"), "utf8")).toBe("private fixture");
    // A long-lived native MCP scope must not keep argv that rebind a replaced
    // registered path to a different directory on its next file command.
    const paths = { ...piPaths(join(f.root, "state")), extDir: resolve("server/engine/pi/ext") };
    const b = new PiBackend({ paths, install: { cli: join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), node: process.execPath } as any,
      catalog: new Map(), sandbox: sb, apiKey: () => null, thinking: "off", idleMs: 1, maxProcs: 1, subagents: {} as any });
    expect(await b.nativePath(f.own.path, join(f.school.path, "vc planning.md"))).toBeNull();
    for (const path of [...projectPrivate.map(p => join(p, "private")), join(f.school.path, ".vault-chat/events/private"), join(unregistered, "private"), join(f.school.path, "escape/private"), join(f.sb.denyRead[0]!, "private")]) {
      expect(await b.nativePath(f.own.path, path), path).not.toBeNull();
    }
    // Registration is content visibility, never project ownership or a grant
    // to mutate a canonical source. Even registering the protected source itself
    // must leave the later service-owned read-only bind in force.
    mkdirSync(join(main, ".git")); // a canonical source already has repository metadata
    const sourceVault = { name: "canonical-source", path: main, bare: "", main: false };
    f.set([f.own, f.school, sourceVault]);
    const scope = await b.filesystem(cwd, ["read", "write"], { fileWrite: async () => true });
    expect(await scope.call("read", { path: join(main, "source") }, { signal: new AbortController().signal })).toMatchObject({ ok: true });
    expect(await scope.call("write", { path: join(main, "source"), content: "forbidden" }, { signal: new AbortController().signal })).toMatchObject({ ok: false });
    const registeredOuter = outerWith(sb)!;
    expect(spawnSync(registeredOuter[0]!, [...registeredOuter.slice(1), "sh", "-c", `printf forbidden > '${main}/source'`], { cwd }).status).not.toBe(0);
    expect(readFileSync(join(main, "source"), "utf8")).toBe("main-original");
    // Native visibility cannot widen an independently root-bound API/PDF reader
    // or its filesystem loadout, even though the same sandbox mounts School2.
    expect(await b.externalPath(f.own.path, join(f.school.path, "vc planning.md"), false)).not.toBeNull();
    const external = await b.filesystem(f.own.path, ["read", "write"], { fileWrite: async () => true }, f.own.path);
    expect(await external.call("read", { path: join(f.school.path, "vc planning.md") }, { signal: new AbortController().signal })).toMatchObject({ ok: false });
    expect(await external.call("write", { path: join(f.school.path, "vc planning.md"), content: "forbidden" }, { signal: new AbortController().signal })).toMatchObject({ ok: false });
    expect(readFileSync(join(f.school.path, "vc planning.md"), "utf8")).toContain("Pure client/surface for any AI.");
    f.set([f.own, f.school]);
    renameSync(f.school.path, f.school.path + "-original"); mkdirSync(f.school.path);
    writeFileSync(join(f.school.path, "Poll.md"), "replacement-must-not-be-touched");
    expect(await scope.call("read", { path: join(f.school.path, "Poll.md") }, { signal: new AbortController().signal })).toMatchObject({ ok: false });
    expect(await scope.call("write", { path: join(f.school.path, "Poll.md"), content: "forbidden" }, { signal: new AbortController().signal })).toMatchObject({ ok: false });
    expect(readFileSync(join(f.school.path, "Poll.md"), "utf8")).toBe("replacement-must-not-be-touched");
    expect(await b.nativePath(f.own.path, join(f.school.path, "Poll.md"))).not.toBeNull();
  });

  it("binds only registered content in shell, native, jobs/delegates; metadata is hidden AFTER every folder bind", () => {
    const f = fixture();
    const main = join(f.school.path, "protected-project"); mkdirSync(join(main, ".vault-chat/local"), { recursive: true });
    const sb = { ...f.sb, projects: () => [f.school.path], readOnly: () => [main] };
    for (const scope of [{ ...sb, projects: () => [] }, sb]) for (const argv of [outerWith(scope)!, shellWith(scope)!]) {
      expect(mount(argv, "--bind", f.school.path, f.school.path)).toBeGreaterThan(0);
      expect(mount(argv, "--ro-bind", main, main)).toBeGreaterThan(mount(argv, "--bind", f.school.path, f.school.path));
      expect(mount(argv, "--tmpfs", join(f.school.path, ".vault-chat"))).toBeGreaterThan(mount(argv, "--bind", f.school.path, f.school.path));
      expect(mount(argv, "--tmpfs", join(f.school.path, ".git"))).toBeGreaterThan(mount(argv, "--bind", f.school.path, f.school.path));
      expect(mount(argv, "--tmpfs", join(f.root, "state/school2"))).toBeGreaterThan(0);
      expect(mount(argv, "--bind", f.school.bare, f.school.bare)).toBe(-1);
      expect(argv.some(p => p.includes("unregistered"))).toBe(false);
    }
  });

  it("reads/edits the explicitly named original School2 file through pinned pi tools without changing the project cwd", async () => {
    const f = fixture(); const cwd = join(f.root, "agent-work/project-clone"); mkdirSync(cwd, { recursive: true });
    const prefix = process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0");
    const fs = await filesystemBinding({ cli: join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), node: process.execPath,
      script: resolve("server/engine/pi/ext/filesystem.mjs"), cwd, home: f.root, outer: null, shell: null,
      denyRead: [...f.sb.denyRead, ...f.content().hidden], denyWrite: [], allowed: ["read", "edit", "write"], env: () => ({}), fileWrite: async () => true });
    const call = (name: string, args: any) => fs.call(name, args, { signal: new AbortController().signal });
    expect((await call("read", { path: join(f.school.path, "Poll.md") })).text).toContain("8474915651");
    expect(await call("edit", { path: join(f.school.path, "Poll.md"), edits: [{ oldText: "8474915651", newText: "# VC planning" }] })).toMatchObject({ ok: true });
    expect(readFileSync(join(f.school.path, "Poll.md"), "utf8")).toBe("# VC planning");
    expect(readFileSync(join(f.own.path, "Poll.md"), "utf8")).toBe("wrong basename");
    for (const path of [join(f.school.path, ".vault-chat/events/private"), join(f.school.bare, "HEAD"), join(f.root, "state/school2/session"), join(f.root, "credentials/key")]) {
      expect(await call("read", { path })).toMatchObject({ ok: false });
      expect(await call("write", { path, content: "forbidden" }), path).toMatchObject({ ok: false });
    }
    symlinkSync(join(f.school.path, ".vault-chat"), join(f.school.path, "private-link"));
    expect(await call("read", { path: join(f.school.path, "private-link/events/private") })).toMatchObject({ ok: false });
  });

  it("fails closed for symlink escapes and replaced registered roots; trusted removal/re-registration refreshes capabilities", () => {
    const f = fixture(); expect(f.content().folders).toEqual([f.school.path]);
    renameSync(f.school.path, f.school.path + "-old"); mkdirSync(f.school.path);
    expect(f.content().folders).toEqual([]); expect(f.content().hidden).toContain(f.school.path);
    f.set([f.own]); expect(f.content().folders).toEqual([]);
    f.set([f.own, f.school]); expect(f.content().folders).toEqual([f.school.path]);
    rmSync(f.school.path, { recursive: true }); symlinkSync(f.own.path, f.school.path);
    expect(f.content().folders).toEqual([]); expect(f.content().hidden).toContain(f.school.path);
    expect(mount(outerWith(f.sb)!, "--bind", f.school.path, f.school.path)).toBe(-1);
  });

  it("native capability identity changes on registration/removal without reading other conversations", () => {
    const f = fixture();
    const b = new PiBackend({ install: { version: "fixture" } as any, paths: piPaths(join(f.root, "state")), catalog: new Map(), sandbox: { ...f.sb, outer: null, shell: null }, apiKey: () => null, thinking: "off", idleMs: 1, maxProcs: 1, subagents: {} as any });
    const before = b.sandboxKey(); f.set([f.own]); expect(b.sandboxKey()).not.toBe(before);
    expect(JSON.parse(b.piEnv().VC_PI_DENY_READ!)).not.toContain(f.school.path);
  });
});
