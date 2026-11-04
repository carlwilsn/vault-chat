/** Real seven-command runner on a tiny git fixture, NOT a published release/device proof. */
import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { ship, type ShipConfig } from "../simpleShipHost";
import { acceptedChanges, updateShippingJournal } from "../changeShipping";
import { configureChangeDelivery, deliveryChallenge, observeChangeDelivery, reportLaptopHealth } from "../changeDelivery";
import { registerFolder } from "../projectFolders";

it("normal branch shipping runs all seven gates; later native failure leaves accepted source and tests untouched", async () => {
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
    const npm = realpathSync(execFileSync("bash", ["-c", "command -v npm"], { encoding: "utf8" }).trim());
    const npmBin = npm.includes("/lib/node_modules/npm/") ? npm.split("/lib/node_modules/npm/")[0] + "/bin" : dirname(npm);
    const path = [npmBin, ...(process.env.PATH ?? "").split(":").map(p => { try { return realpathSync(p); } catch { return ""; } }).filter(p => p.startsWith("/nix/store/"))].join(":");
    const bwrap = readdirSync("/nix/store").filter(n => /-bubblewrap-[0-9]/.test(n)).map(n => join("/nix/store", n, "bin/bwrap")).find(existsSync)!;
    const config: ShipConfig = { repo, remote: "origin", workRoot: join(root, "runs"), dependencies, pi: process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0"), node: realpathSync(process.execPath), npm, bash: realpathSync("/run/current-system/sw/bin/bash"), bwrap, path };
    expect(await ship(config, { branch: "agent/feature", title: "Feature with regression", slug: "app", convId: "project-app" })).toContain("Accepted");
    const feature = (await acceptedChanges(repo))[0];
    put("later.txt", "unrelated later work"); g("add", "."); g("commit", "-qm", "later work");
    registerFolder(vault, "app", repo);
    const release = { id: "fixture-release", version: "1.0.1", revision: feature.source.head, tag: "v1.0.1", publishedAt: new Date().toISOString() };
    await updateShippingJournal(repo, j => { j.changes[0].release = release; });
    let calls = 0;
    configureChangeDelivery({ vaults: () => [{ name: "fixture", path: vault }], stateDir: join(root, "state"),
      boxHealth: async () => ({ version: release.version, revision: release.revision, observedAt: Date.now(), ready: true }),
    });
    await observeChangeDelivery(repo);
    const challenge = await deliveryChallenge(repo, "fixture-native");
    await reportLaptopHealth(repo, "fixture-native", { ...challenge!, tauri: true, frontendMounted: true, boxConnected: true, syncReady: true, updaterReady: false });
    await observeChangeDelivery(repo);
    expect(calls).toBe(0);
    expect(readFileSync(join(repo, "app.ts"), "utf8")).toContain("= 2");
    expect(readFileSync(join(repo, "later.txt"), "utf8")).toBe("unrelated later work");
    expect(existsSync(join(repo, "server/test/regression.test.ts"))).toBe(true);
    expect(existsSync(join(repo, "test/harness/regression.test.ts"))).toBe(true);
    expect(await acceptedChanges(repo)).toHaveLength(1);
    expect(await updateShippingJournal(repo, j => j.delivery!.releases[release.id].result?.status)).toBe("failed");
    expect(existsSync(join(vault, ".vault-chat/shipments"))).toBe(false);
    expect(calls).toBe(0); // card retry dedupes against native acceptance
    const logs = readdirSync(config.workRoot).map(d => JSON.parse(readFileSync(join(config.workRoot, d, "gates.json"), "utf8")));
    expect(logs).toHaveLength(1);
    for (const log of logs) for (const side of [log.baseline, log.candidate]) {
      expect(side).toHaveLength(7); expect(side.every((r: { complete: boolean; exitCode: number }) => r.complete && r.exitCode === 0)).toBe(true);
    }
  } catch (e) {
    for (const d of readdirSync(join(root, "runs"))) for (const f of readdirSync(join(root, "runs", d))) if (f.endsWith("-test-server.log")) console.error(readFileSync(join(root, "runs", d, f), "utf8"));
    throw e;
  } finally { rmSync(root, { recursive: true, force: true }); }
});
