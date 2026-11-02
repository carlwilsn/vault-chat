/** Retired recovery commands must fail before opening a repo, gates, main or listeners. */
import { afterEach, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { simpleShipCli } from "../simpleShipHost";
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
it.each(["--failed-release", "--rollback", "recover-published-release"])("rejects obsolete %s CLI without reading even a missing config", async mode => {
  await expect(simpleShipCli(["/nonexistent-config", mode, "a".repeat(40)])).rejects.toThrow("Usage:");
  await expect(simpleShipCli(["/nonexistent-config", "/nonexistent-repo", mode, "id"])).rejects.toThrow("Usage:");
});
it("actual standalone CLI cannot change HEAD/refs, invoke git or create a recovery job", () => {
  const root = mkdtempSync(join(tmpdir(), "vc-retired-ship-")); roots.push(root);
  const repo = join(root, "repo"); mkdirSync(repo);
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@local", ...args], {cwd:repo,encoding:"utf8"}).trim();
  g("init", "-qb", "main"); writeFileSync(join(repo,"app"),"accepted feature"); g("add","."); g("commit","-qm","accepted");
  const refs = g("show-ref"), head = readFileSync(join(repo,".git/HEAD"));
  const cli = join(root,"simple-ship.mjs"), conf = join(root,"config.json"), bin = join(root,"bin"); mkdirSync(bin);
  buildSync({entryPoints:["server/simpleShipHost.ts"],outfile:cli,bundle:true,platform:"node",format:"esm",target:"node22"});
  writeFileSync(conf,JSON.stringify({repo,workRoot:join(root,"runs")}));
  const trap = join(root,"git-called"); writeFileSync(join(bin,"git"),`#!/bin/sh\necho forbidden > '${trap}'\nexit 99\n`,{mode:0o700});
  for(const args of [[conf,"--failed-release","a".repeat(40)],[conf,repo,"--rollback","id"]]) {
    const result = spawnSync(process.execPath,[cli,...args],{cwd:repo,env:{HOME:root,PATH:bin},encoding:"utf8",timeout:3000});
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stderr).toContain("Usage:");
    expect(result.stdout).toBe(""); expect(g("show-ref")).toBe(refs); expect(readFileSync(join(repo,".git/HEAD"))).toEqual(head);
  }
  expect(existsSync(trap)).toBe(false); expect(existsSync(join(root,"runs"))).toBe(false); expect(existsSync(join(repo,".git/vault-chat-shipping"))).toBe(false);
});
it("actual server bundle rejects recovery/unknown commands before ANY listener, child or state initialization", () => {
  const root = mkdtempSync(join(tmpdir(), "vc-retired-server-cli-")); roots.push(root);
  const preload = join(root,"deny-side-effects.cjs"), marker = join(root,"side-effect");
  // Throw before listen can bind even an owned port. This regression can NEVER start a second live server.
  writeFileSync(preload,`const fs=require('node:fs'); const deny=()=>{fs.appendFileSync(${JSON.stringify(marker)},'unexpected initialization\\n');throw Error('forbidden initialization');}; require('node:net').Server.prototype.listen=deny; const cp=require('node:child_process'); for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[k]=deny; require('node:module').syncBuiltinESMExports();`);
  const bundle=resolve("dist-server/vault-chat-server.mjs"); expect(existsSync(bundle)).toBe(true);
  for(const args of [["recover-published-release","id"],["--failed-release","id"],["--rollback","id"],["--unknown"],["build-info","extra"],["record-ui","extra"]]) {
    const result=spawnSync(process.execPath,["--require",preload,bundle,...args],{cwd:root,env:{HOME:root,PATH:"",VC_HOST:"127.0.0.1"},encoding:"utf8",timeout:3000});
    expect(result.error).toBeUndefined(); expect(result.status,result.stderr).toBe(2); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Unsupported server command; use no arguments, build-info, record-ui, master or projects\n");
  }
  const info=spawnSync(process.execPath,["--require",preload,bundle,"build-info"],{cwd:root,env:{HOME:root,PATH:""},encoding:"utf8",timeout:3000});
  expect(info.status,info.stderr).toBe(0); expect(JSON.parse(info.stdout)).toMatchObject({version:expect.any(String),rev:expect.any(String)});
  expect(existsSync(marker)).toBe(false); expect(existsSync(join(root,".local"))).toBe(false);
  // Existing recorder transport must still work; malformed stdin stops before browser/scratch work.
  const recorder=spawnSync(process.execPath,["--require",preload,bundle,"record-ui"],{cwd:root,env:{HOME:root,PATH:"",VC_VOICE_PIPELINE:"off"},input:"{invalid",encoding:"utf8",timeout:3000});
  expect(recorder.status,recorder.stderr).toBe(0); expect(recorder.stdout).toContain("@@vc-record@@");
  expect(JSON.parse(recorder.stdout.split("@@vc-record@@")[1]!)).toMatchObject({ok:false});
  expect(recorder.stdout).not.toContain("starting"); expect(existsSync(marker)).toBe(false);
});
