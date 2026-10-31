/** Real native flock/job-stop private fixture, NOT installed host/application/device evidence. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildSync } from "esbuild";
import { join } from "node:path";
import { tmpdir } from "node:os";
const state = vi.hoisted(() => ({ home: "" }));
// Redirect only the installed-location lookup to a private fixture; no spawn, git, flock or kill mocks.
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => state.home }));
import { runInstalledShip } from "../submitChange";
import { jobStop, reapJobs, startServiceJob } from "../engine/pi/jobs";
const roots: string[] = [], pids: { pid: number; start: string }[] = [];
const identity = (pid: number) => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19]!;
const remember = (pid: number) => pids.push({pid, start: identity(pid)});
const ownedJobs: { env: Parameters<typeof jobStop>[0]; id: string; conv: string }[] = [];
const tasks: Promise<string>[] = [];
afterEach(async () => { for (const j of ownedJobs.splice(0)) jobStop(j.env,j.id,j.conv); await Promise.allSettled(tasks.splice(0)); for (const {pid,start} of pids.splice(0)) { try { if(identity(pid)===start) process.kill(pid, "SIGKILL"); } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error("Private process fixture did not reach its barrier"); };
const alive = (pid: number) => { try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3)); } catch { return false; } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-ship-process-")); roots.push(root); state.home = root;
  const installed = join(root, ".local/lib/vault-chat/simple-ship"); mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "config.json"), "{}");
  const ready = join(root, "ready.json");
  writeFileSync(join(installed, "simple-ship.mjs"), `import {spawn} from 'node:child_process';import fs from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`);
  const jobs = { logDir: join(root, "jobs"), wrap: null, env: {} };
  return { root, ready, jobs };
}
function actualFixture() {
  const f = fixture(), installed = join(f.root, ".local/lib/vault-chat/simple-ship");
  buildSync({ entryPoints: ["server/simpleShipHost.ts"], outfile: join(installed,"simple-ship.mjs"), bundle: true, platform: "node", format: "esm", target: "node22" });
  const repo=join(f.root,"repo"), deps=join(f.root,"dependencies"), modules=join(deps,"node_modules");
  mkdirSync(repo); mkdirSync(join(modules,"typescript/bin"),{recursive:true});
  const pkg=JSON.stringify({name:"private-cancellation-fixture",version:"1.0.0"}), lock=JSON.stringify({lockfileVersion:3,packages:{}});
  for(const dir of [repo,deps]) { writeFileSync(join(dir,"package.json"),pkg); writeFileSync(join(dir,"package-lock.json"),lock); }
  writeFileSync(join(modules,"typescript/bin/tsc"), `const {spawn}=require('node:child_process'),fs=require('node:fs');
const child=spawn(process.execPath,['-e',"const fs=require('node:fs');fs.writeFileSync('/work/session.json',fs.readFileSync('/proc/self/stat','utf8'));setInterval(()=>fs.writeFileSync('/work/heartbeat',String(Date.now())),20)"],{detached:true,stdio:'ignore'});setInterval(()=>{},1000);`);
  const g=(...args:string[])=>execFileSync("git",["-c","core.hooksPath=/dev/null","-c","user.name=test","-c","user.email=test@local",...args],{cwd:repo,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  g("init","-qb","main");g("add",".");g("commit","-qm","base"); const base=g("rev-parse","HEAD");
  g("switch","-qc","agent/private");writeFileSync(join(repo,"candidate.txt"),"private");g("add",".");g("commit","-qm","candidate");g("switch","-q","main");g("remote","add","origin",repo);
  const bwrap=readdirSync("/nix/store").filter(n=>/-bubblewrap-[0-9]/.test(n)).map(n=>join("/nix/store",n,"bin/bwrap")).find(existsSync)!;
  const npm=realpathSync(process.env.PATH!.split(":").map(p=>join(p,"npm")).find(existsSync)!);
  const runs=join(f.root,"runs"), path=process.env.PATH!;
  writeFileSync(join(installed,"config.json"),JSON.stringify({repo,remote:"origin",workRoot:runs,dependencies:modules,pi:process.env.VC_TEST_PI_DIR,node:realpathSync(process.execPath),npm,bash:realpathSync("/run/current-system/sw/bin/bash"),bwrap,path}));
  const start=()=>{ const started=startServiceJob(f.jobs,{name:"actual-cli",command:"private actual installed-script fixture",conv:"private-native",byCarl:false},(signal,log)=>{const task=runInstalledShip(repo,"--branch","agent/private","Private","private","private-native",signal,log); tasks.push(task);return task;}); if(started.job) ownedJobs.push({env:f.jobs,id:started.job.id,conv:"private-native"});return started;};
  const stopped=async(id:string)=> { expect(jobStop(f.jobs,id,"private-native")).toContain("Stopped"); await waitFor(()=>readFileSync(join(f.jobs.logDir,id+".log"),"utf8").includes("Shipping cancelled")); expect(g("rev-parse","main")).toBe(base); expect(g("status","--porcelain")).toBe(""); };
  return {...f,repo,runs,start,stopped,g,base,installed};
}
describe("native shipping process ownership (private fixture)", () => {
  it("rejects another conversation's stop, then cancels the actual flock process group through JobStop", async () => {
    const f = fixture(); const conv = "project-private-process";
    const started = startServiceJob(f.jobs, { name: "ship-private", command: "private native fixture", conv, byCarl: false }, (signal, log) => {const task=runInstalledShip(f.root, "--branch", "agent/private-fixture", "Private", "private", conv, signal, log);tasks.push(task);return task;});
    ownedJobs.push({env:f.jobs,id:started.job!.id,conv});
    await waitFor(() => existsSync(f.ready)); const children = JSON.parse(readFileSync(f.ready, "utf8")); remember(children.parent); remember(children.child);
    expect(jobStop(f.jobs, started.job!.id, "other-conversation")).toContain("another conversation");
    expect(alive(children.parent)).toBe(true); expect(alive(children.child)).toBe(true);
    expect(jobStop(f.jobs, started.job!.id, conv)).toContain("Stopped");
    await waitFor(() => !alive(children.parent) && !alive(children.child));
    const log = join(f.jobs.logDir, started.job!.id + ".log");
    await waitFor(() => existsSync(log) && readFileSync(log, "utf8").includes("Shipping cancelled"));
    expect(reapJobs(f.jobs)[0]).toMatchObject({ id: started.job!.id, state: "stopped" });
    expect(reapJobs(f.jobs)).toEqual([]);
  });
  it("JobStop reaches the actual bundled CLI and kills detached setsid descendants through bwrap's PID namespace", async () => {
    const f=actualFixture(), job=f.start().job!;
    let work="";
    await waitFor(()=>{if(!existsSync(f.runs))return false;const run=readdirSync(f.runs)[0];if(!run)return false;work=join(f.runs,run,f.base);return existsSync(join(work,"heartbeat"));});
    const stat=readFileSync(join(work,"session.json"),"utf8").split(") "), pid=Number(stat[0].split(" ")[0]), fields=stat[1].split(" ");
    expect(Number(fields[2])).toBe(pid); expect(Number(fields[3])).toBe(pid); // detached setsid child, inside namespace
    const before=readFileSync(join(work,"heartbeat"),"utf8");
    await waitFor(()=>readFileSync(join(work,"heartbeat"),"utf8")!==before);
    await f.stopped(job.id);
    const after=readFileSync(join(work,"heartbeat"),"utf8"); await new Promise(r=>setTimeout(r,150));
    expect(readFileSync(join(work,"heartbeat"),"utf8")).toBe(after);
    expect(readdirSync(join(f.runs,readdirSync(f.runs)[0]))).not.toContain("gates.json");
  },15_000);
  it("JobStop reaches an actual CLI's long detached git child before gates and cannot advance main", async () => {
    const f=actualFixture(), bin=join(f.root,"bin"), marker=join(f.root,"git-ready");mkdirSync(bin);
    const realGit=realpathSync(process.env.PATH!.split(":").map(p=>join(p,"git")).find(existsSync)!);
    writeFileSync(join(bin,"git"),`#!${process.execPath}
const fs=require('node:fs'),{spawnSync,spawn}=require('node:child_process');const args=process.argv.slice(2);
if(args.includes('fetch')){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000)}else{const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1)}`,{mode:0o700});
    vi.stubEnv("PATH",bin+":"+process.env.PATH);
    try {
      const job=f.start().job!;await waitFor(()=>existsSync(marker));const owned=JSON.parse(readFileSync(marker,"utf8"));remember(owned.parent);remember(owned.child);
      // The child is actually owned by the wrapper we launched, not a discovered host process.
      expect(readFileSync(`/proc/${owned.child}/stat`,"utf8").split(") ")[1].split(" ")[1]).toBe(String(owned.parent));
      await f.stopped(job.id);await waitFor(()=>!alive(owned.parent)&&!alive(owned.child));
      expect(existsSync(f.runs)&&readdirSync(f.runs).some(run=>existsSync(join(f.runs,run,"gates.json")))).toBe(false);
    } finally {vi.unstubAllEnvs();}
  },15_000);
  it("rejects a pre-aborted invocation before launching a process", () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    expect(() => runInstalledShip(f.root, "--branch", "agent/private", "Private", "private", "private", controller.signal, () => {})).toThrow();
    expect(existsSync(f.ready)).toBe(false);
  });
});
