import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServiceJob, jobStop, probeJob } from "../engine/pi/jobs";
import { checkBranch, ship, promote, type ShipConfig } from "../simpleShipHost";
import { acceptedChanges, type AcceptedChange } from "../changeShipping";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-simple-")), repo = join(root, "repo"); roots.push(root); mkdirSync(repo);
  const g = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=test", "-c", "user.email=test@local", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  g("init", "-qb", "main"); writeFileSync(join(repo, "app.txt"), "base"); g("add", "."); g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  g("switch", "-qc", "agent/change"); writeFileSync(join(repo, "app.txt"), "changed"); g("commit", "-qam", "change");
  const head = g("rev-parse", "HEAD"), tree = g("rev-parse", "HEAD^{tree}"); g("switch", "-q", "main");
  const change: AcceptedChange = { id: head, source: { base, head, tree, branch: "agent/change" }, preparedAt: new Date().toISOString(), proofDir: root, review: { convId: "project-app", slug: "app", folder: repo, clone: "untouched", base: "main", branch: "agent/change", sha: head, title: "Change", at: new Date().toISOString() } };
  return { root, repo, g, base, head, change };
}
describe("single box script: native git promotion and rollback", () => {
  it("fast-forwards exactly the pinned range and worktree, records acceptance but never Shipped or a push", async () => {
    const f = fixture(); await promote(f.repo, f.base, f.head, f.change);
    expect(f.g("rev-parse", "main")).toBe(f.head);
    expect(f.g("status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("changed");
    const accepted = await acceptedChanges(f.repo);
    expect(accepted).toEqual([expect.objectContaining({ source: f.change.source, acceptedAt: expect.any(String) })]);
    expect(accepted[0].release).toBeUndefined();
  });
  it("rejects current main advancement rather than accepting stale gates or making a merge commit", async () => {
    const f = fixture(); writeFileSync(join(f.repo, "later.txt"), "later"); f.g("add", "."); f.g("commit", "-qm", "later");
    const current = f.g("rev-parse", "main");
    await expect(promote(f.repo, f.base, f.head, f.change)).rejects.toThrow("Main changed");
    expect(f.g("rev-parse", "main")).toBe(current); expect(await acceptedChanges(f.repo)).toEqual([]);
  });
  it("preserves uncommitted data and refuses dirty main", async () => {
    const f = fixture(); writeFileSync(join(f.repo, "app.txt"), "Carl's uncommitted edit");
    await expect(promote(f.repo, f.base, f.head, f.change)).rejects.toThrow("Main changed");
    expect(f.g("rev-parse", "main")).toBe(f.base);
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("Carl's uncommitted edit");
  });
  it("rejects obsolete rollback input before any configuration, git, gates or promotion", async () => {
    const f = fixture(), refs = f.g("show-ref"), head = readFileSync(join(f.repo, ".git/HEAD"));
    await expect(ship({} as ShipConfig, { branch: "agent/change", rollback: f.head, title: "stale", slug: "app", convId: "project-app" } as never)).rejects.toThrow("Source recovery is not supported");
    expect(f.g("show-ref")).toBe(refs); expect(readFileSync(join(f.repo, ".git/HEAD"))).toEqual(head);
    expect(existsSync(join(f.repo, ".git/vault-chat-shipping"))).toBe(false);
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("base");
  });
  it("leaves ordinary user-directed git revert available, preserving later unrelated work", async () => {
    const f = fixture(); await promote(f.repo, f.base, f.head, f.change);
    writeFileSync(join(f.repo, "later.txt"), "later"); f.g("add", "."); f.g("commit", "-qm", "later");
    f.g("revert", "--no-edit", f.head);
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("base");
    expect(readFileSync(join(f.repo, "later.txt"), "utf8")).toBe("later");
    expect(await acceptedChanges(f.repo)).toHaveLength(1);
  });
  it("does not move main when the private acceptance journal cannot be persisted", async () => {
    const f = fixture(); const dir = join(f.repo, ".git/vault-chat-shipping"); mkdirSync(dir);
    writeFileSync(join(dir, "journal.lock"), ""); chmodSync(dir, 0o500);
    try { await expect(promote(f.repo, f.base, f.head, f.change)).rejects.toThrow(); }
    finally { chmodSync(dir, 0o700); }
    expect(f.g("rev-parse", "main")).toBe(f.base); expect(f.g("status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("base");
  });
  it("does not advance main or record acceptance when native git cannot lock its index", async () => {
    const f = fixture(); writeFileSync(join(f.repo, ".git/index.lock"), "owned concurrent git writer fixture");
    await expect(promote(f.repo, f.base, f.head, f.change)).rejects.toThrow();
    expect(f.g("rev-parse", "main")).toBe(f.base);
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("base");
    expect(await acceptedChanges(f.repo)).toEqual([]);
    expect(readFileSync(join(f.repo, ".git/index.lock"), "utf8")).toContain("owned concurrent git writer");
  });
  it("does not record acceptance when native git cannot take main's expected-old ref lock", async () => {
    const f = fixture(); writeFileSync(join(f.repo, ".git/refs/heads/main.lock"), "owned native ref writer fixture");
    await expect(promote(f.repo, f.base, f.head, f.change)).rejects.toThrow();
    expect(f.g("rev-parse", "main")).toBe(f.base); expect(await acceptedChanges(f.repo)).toEqual([]);
    expect(readFileSync(join(f.repo, ".git/refs/heads/main.lock"), "utf8")).toContain("owned native ref writer");
    // Git's checkout and ref storage are not a multi-file atomic transaction. Do NOT promise
    // automatic worktree recovery after a ref write fails; the unchanged main is not accepted.
  });
  it("holds the exact expected-old native ref lock throughout checkout against an independent git writer", async () => {
    const f = fixture(), bin = join(f.root, "bin"); mkdirSync(bin);
    const competitor = f.g("commit-tree", f.g("rev-parse", `${f.base}^{tree}`), "-p", f.base, "-m", "competing writer");
    const realGit = realpathSync(process.env.PATH!.split(":").map(p => join(p, "git")).find(existsSync)!);
    const marker = join(f.root, "competitor-status");
    writeFileSync(join(bin, "git"), `#!${process.execPath}
const {spawnSync}=require('node:child_process'),fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('read-tree')){const r=spawnSync(${JSON.stringify(realGit)},['update-ref','refs/heads/main',${JSON.stringify(competitor)},${JSON.stringify(f.base)}],{cwd:process.cwd(),encoding:'utf8'});fs.writeFileSync(${JSON.stringify(marker)},String(r.status));}
const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);`, { mode: 0o700 });
    vi.stubEnv("PATH", bin + ":" + process.env.PATH);
    try { await promote(f.repo, f.base, f.head, f.change); } finally { vi.unstubAllEnvs(); }
    expect(readFileSync(marker, "utf8")).toBe("128");
    expect(f.g("rev-parse", "main")).toBe(f.head); expect(f.g("status", "--porcelain")).toBe("");
  });
  it("rejects a pre-aborted promotion without preparing a journal or advancing main", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(promote(f.repo, f.base, f.head, f.change, controller.signal)).rejects.toThrow();
    expect(f.g("rev-parse", "main")).toBe(f.base);
    expect(f.g("status", "--porcelain")).toBe("");
    expect(existsSync(join(f.repo, ".git/vault-chat-shipping/accepted.json"))).toBe(false);
  });
  it("aborts before native ref commit after checkout without hidden worktree repair", async () => {
    const f = fixture(), bin = join(f.root, "bin"); mkdirSync(bin);
    const realGit = realpathSync(process.env.PATH!.split(":").map(p => join(p, "git")).find(existsSync)!);
    const marker = join(f.root, "checked-out"), release = join(f.root, "release");
    writeFileSync(join(bin, "git"), `#!${process.execPath}
const {spawnSync}=require('node:child_process'),fs=require('node:fs');
const args=process.argv.slice(2);
const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
if(args.includes('read-tree')&&r.status===0){fs.writeFileSync(${JSON.stringify(marker)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
process.exit(r.status??1);`, { mode: 0o700 });
    vi.stubEnv("PATH", bin + ":" + process.env.PATH);
    try {
      const env={logDir:join(f.root,"jobs"),wrap:null,env:{}};
      let result: Promise<unknown> = Promise.resolve("service callback not reached");
      const started=startServiceJob(env,{name:"precommit",command:"owned native commit boundary",conv:"private-phase",byCarl:false},async signal=>{
        const operation=promote(f.repo,f.base,f.head,f.change,signal); result=operation.then(()=>null,e=>e); await operation;return "accepted";
      });
      for(let i=0;i<300&&!existsSync(marker);i++) await new Promise(r=>setTimeout(r,10));
      expect(existsSync(marker)).toBe(true);
      expect(jobStop(env,started.job!.id,"private-phase")).toContain("Stopped"); writeFileSync(release, "release owned checkout fixture");
      expect(await result).toBeInstanceOf(Error);
      expect(probeJob(env,started.job!).state).toBe("stopped");
    } finally { writeFileSync(release, "release"); vi.unstubAllEnvs(); }
    expect(f.g("rev-parse", "main")).toBe(f.base);
    expect(await acceptedChanges(f.repo)).toEqual([]);
    // Native checkout already happened. Failure is visible, not silently reset or accepted.
    expect(readFileSync(join(f.repo,"app.txt"),"utf8")).toBe("changed");
    expect(f.g("status", "--porcelain")).not.toBe("");
    expect(existsSync(join(f.repo,".git/refs/heads/main.lock"))).toBe(false);
  });
  it("retains a native commit that wins before abort rather than pretending JobStop undoes acceptance", async () => {
    const f=fixture(), bin=join(f.root,"bin");mkdirSync(bin);
    const realGit=realpathSync(process.env.PATH!.split(":").map(p=>join(p,"git")).find(existsSync)!);
    const committed=join(f.root,"committed"), release=join(f.root,"release");
    writeFileSync(join(bin,"git"),`#!${process.execPath}
const {spawn,spawnSync}=require('node:child_process'),fs=require('node:fs'),args=process.argv.slice(2);
if(args.includes('update-ref')&&args.includes('--stdin')){const child=spawn(${JSON.stringify(realGit)},args,{stdio:['pipe','pipe','inherit']});process.stdin.pipe(child.stdin);child.stdout.on('data',d=>{process.stdout.write(d);if(String(d).includes('commit: ok'))fs.writeFileSync(${JSON.stringify(committed)},'native commit acknowledged');});child.on('close',code=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exit(code??1)}},10)});}else{const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1)}`,{mode:0o700});
    vi.stubEnv("PATH",bin+":"+process.env.PATH);
    try {
      const env={logDir:join(f.root,"jobs"),wrap:null,env:{}};
      let result:Promise<unknown>=Promise.resolve("service callback not reached");
      const started=startServiceJob(env,{name:"postcommit",command:"owned native committed boundary",conv:"private-phase",byCarl:false},async signal=>{
        const operation=promote(f.repo,f.base,f.head,f.change,signal);result=operation;await operation;return "accepted";
      });
      for(let i=0;i<300&&!existsSync(committed);i++)await new Promise(r=>setTimeout(r,10));
      expect(existsSync(committed)).toBe(true);expect(f.g("rev-parse","main")).toBe(f.head);
      expect(jobStop(env,started.job!.id,"private-phase")).toContain("Stopped");writeFileSync(release,"release owned native transaction");await result;
      expect(probeJob(env,started.job!).state).toBe("stopped");
    } finally {writeFileSync(release,"release");vi.unstubAllEnvs();}
    expect((await acceptedChanges(f.repo))[0]).toMatchObject({source:f.change.source,acceptedAt:expect.any(String)});
    expect(f.g("status","--porcelain")).toBe("");
  });
  it("refuses unsafe refs before passing anything to git", () => {
    for (const branch of ["main", "--upload-pack=bad", "agent/../main", "agent/a//b", "agent/b.lock", "agent/x\nmain", "agent/x;touch /tmp/no"]) expect(() => checkBranch(branch)).toThrow();
    expect(() => checkBranch("agent/simple-ship-reset-1030")).not.toThrow();
  });
});
