import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildSync } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { promote, type ShipConfig } from "../simpleShipHost";
import { acceptedChanges, updateShippingJournal } from "../changeShipping";
import { configureChangeDelivery, observeChangeDelivery, shipmentCards } from "../changeDelivery";
import { registerFolder } from "../projectFolders";

it("trusted failed-release CLI preserves the first native revert and reports durable partial attention when its second range fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "vc-native-rollback-")), repo = join(root, "repo"), vault = join(root, "vault");
  const put = (p: string, text: string) => { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), text); };
  mkdirSync(repo); mkdirSync(join(vault, "agent-projects/app"), { recursive: true });
  const g = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=test", "-c", "user.email=test@local", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const dependencies = realpathSync(resolve("node_modules"));
    for (const name of ["package.json", "package-lock.json"]) put(name, readFileSync(join(dependencies, "..", name), "utf8"));
    put("app.ts", "export const value: number = 1;\n");
    put("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, skipLibCheck: true, types: [] }, files: ["app.ts"] }));
    for (const dir of ["phone", "board", "server"]) put(`${dir}/tsconfig.json`, JSON.stringify({ extends: "../tsconfig.json", files: ["../app.ts"] }));
    for (const dir of ["phone", "board"]) put(`${dir}/vite.config.ts`, `export default {build:{outDir:'${dir}/dist',lib:{entry:'app.ts',formats:['es'],fileName:'app'}}};`);
    put("server/build.mjs", "import {build} from 'esbuild'; await build({entryPoints:['app.ts'],bundle:true,outfile:'dist-server/app.js'});\n");
    put("server/vitest.config.ts", "export default {test:{include:['server/test/*.test.ts']}};\n");
    put("server/test/base.test.ts", "import {it,expect} from 'vitest'; import {value} from '../../app'; it('base contract',()=>expect(value).toBeGreaterThan(0));\n");
    put("test/harness/register.mjs", "// This fixture needs no harness globals.\n");
    put("test/harness/base.test.ts", "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../../app.ts'; test('base contract',()=>assert.ok(value>0));\n");
    g("init", "-qb", "main"); g("add", "."); g("commit", "-qm", "base");
    g("branch", "agent/feature"); g("switch", "-q", "agent/feature");
    put("app.ts", "export const value: number = 2;\n");
    put("server/test/regression.test.ts", "import {it,expect} from 'vitest'; import {value} from '../../app'; it('feature regression',()=>expect(value).toBe(2));\n");
    put("test/harness/regression.test.ts", "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../../app.ts'; test('feature regression',()=>assert.equal(value,2));\n");
    g("add", "."); g("commit", "-qm", "feature plus regression tests"); g("switch", "-q", "main");
    g("remote", "add", "origin", repo); // ordinary local remote, no publication or credentials
    const npm = realpathSync(process.env.PATH!.split(":").map(p => join(p, "npm")).find(existsSync)!);
    const npmBin = npm.includes("/lib/node_modules/npm/") ? npm.split("/lib/node_modules/npm/")[0] + "/bin" : dirname(npm);
    const path = [npmBin, ...(process.env.PATH ?? "").split(":").map(p => { try { return realpathSync(p); } catch { return ""; } }).filter(p => p.startsWith("/nix/store/"))].join(":");
    const bwrap = readdirSync("/nix/store").filter(n => /-bubblewrap-[0-9]/.test(n)).map(n => join("/nix/store", n, "bin/bwrap")).find(existsSync)!;
    const config: ShipConfig = { repo, remote: "origin", workRoot: join(root, "runs"), dependencies, pi: process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0"), node: realpathSync(process.execPath), npm, bash: realpathSync("/run/current-system/sw/bin/bash"), bwrap, path };
    const firstBase = g("rev-parse", "main"), firstHead = g("rev-parse", "agent/feature"), firstTree = g("rev-parse", "agent/feature^{tree}");
    const now = new Date().toISOString();
    const change = (base: string, head: string, tree: string, branch: string) => ({ id: head, source: { base, head, tree, branch }, proofDir: root, preparedAt: now,
      review: { convId: "project-app", slug: "app", folder: repo, clone: repo, base: "main", branch, sha: head, title: "Fixture accepted range", at: now } });
    await promote(repo, firstBase, firstHead, change(firstBase, firstHead, firstTree, "agent/feature"));
    g("switch", "-qc", "agent/second"); put("second.txt", "second range"); g("add", "."); g("commit", "-qm", "second accepted range");
    const secondHead = g("rev-parse", "HEAD"), secondTree = g("rev-parse", "HEAD^{tree}"); g("switch", "-q", "main");
    await promote(repo, firstHead, secondHead, change(firstHead, secondHead, secondTree, "agent/second"));
    const release = { id: "private-failed-release", revision: secondHead, version: "1.0.1", tag: "v1.0.1", publishedAt: now };
    await updateShippingJournal(repo, j => { for (const c of j.changes) c.release = release; });
    put("later.txt", "unrelated later work"); g("add", "."); g("commit", "-qm", "later unrelated");
    const bin = join(root, "bin"), marker = join(root, "injected-second-only"); mkdirSync(bin);
    const realGit = realpathSync(process.env.PATH!.split(":").map(p => join(p, "git")).find(existsSync)!);
    writeFileSync(join(bin, "git"), `#!${process.execPath}
const fs=require('node:fs'),{spawnSync}=require('node:child_process'),a=process.argv.slice(2);
if(a.includes('revert')&&a.includes(${JSON.stringify(firstHead)})){fs.appendFileSync(${JSON.stringify(marker)},'second failed\\n');process.stderr.write('Owned fixture second revert failed');process.exit(42);}
const r=spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);`, { mode: 0o700 });
    const cli = join(root, "simple-ship.mjs"), conf = join(root, "config.json");
    buildSync({ entryPoints: ["server/simpleShipHost.ts"], outfile: cli, bundle: true, platform: "node", format: "esm", target: "node22" });
    writeFileSync(conf, JSON.stringify(config));
    // No marker required: this CLI is a trusted host/operator entry. Automatic provenance belongs
    // to the actual post-release controller (covered independently), never branch-controlled arguments.
    const run = (revision = secondHead) => spawnSync(process.execPath, [cli, conf, "--failed-release", revision], { env: { ...process.env, PATH: bin + ":" + process.env.PATH }, encoding: "utf8", timeout: 20_000 });
    const unknown = run("f".repeat(40)); expect(unknown.status).toBe(1); expect(unknown.stderr).toContain("no original accepted ranges"); expect(existsSync(config.workRoot)).toBe(false);
    const result = run(); expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    expect(result.stdout, result.stderr).toContain("Accepted"); expect(result.stderr).toContain("1/2"); expect(result.stderr).toContain("needs attention");
    expect(result.stdout + result.stderr).not.toContain("Rolled back"); expect(result.stdout).toContain("not Shipped.");
    const accepted = await acceptedChanges(repo), reversals = accepted.filter(c => c.rollbackOf);
    expect(reversals.map(c => c.rollbackOf)).toEqual([secondHead]);
    expect(existsSync(join(repo, "second.txt"))).toBe(false); expect(readFileSync(join(repo, "app.ts"), "utf8")).toContain("= 2");
    expect(readFileSync(join(repo, "later.txt"), "utf8")).toBe("unrelated later work"); expect(g("status", "--porcelain")).toBe("");
    const persistentMain = g("rev-parse", "main");
    expect(await updateShippingJournal(repo, j => j.delivery!.rollbacks[firstHead])).toMatchObject({status:"failed",error:expect.stringContaining("needs attention")});
    registerFolder(vault, "app", repo);
    const calls: string[] = [];
    configureChangeDelivery({stateDir:join(root,"state"),vaults:()=>[],boxHealth:async()=>({version:"old",revision:firstHead,observedAt:Date.now(),ready:true}),requestSourceRollback:async(_repo,id)=>{calls.push(id);return{status:"accepted"};}});
    const markers = join(root, "state/release-failures"); mkdirSync(markers,{recursive:true});
    writeFileSync(join(markers,createHash("sha256").update(release.version).digest("hex")+".json"),JSON.stringify({version:release.version,revision:release.revision,observedAt:Date.now()}));
    await observeChangeDelivery(repo); await observeChangeDelivery(repo); expect(calls).toEqual([]);
    const [card] = (await shipmentCards(vault,"fixture")).filter(c=>c.id===firstHead); expect(card.status).toBe("needs-attention");
    const retry = run(); expect(retry.status).toBe(1); expect(readFileSync(marker,"utf8")).toBe("second failed\n");
    expect(g("rev-parse","main")).toBe(persistentMain); expect((await acceptedChanges(repo)).filter(c=>c.rollbackOf)).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 25_000);
