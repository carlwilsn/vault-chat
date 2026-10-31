// Finite private-package check. Uses the UNCHANGED production native sandbox/gate argv.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const source = process.cwd(), out = join(process.env.VC_APP_PROOF_OUT, 'packages');
assert.equal(process.versions.node.split('.')[0], '22');
mkdirSync(out);
const repo = join(out, 'source'), dependencies = join(out, 'dependencies/node_modules');
mkdirSync(repo); await mkdir(dependencies, { recursive: true });
// This is the same existing source dependency tree copied by the full fixture.
// Dereference ALL nested links, notably @esbuild/linux-x64 and @rollup/*.
const donor = realpathSync(join(source, 'node_modules'));
assert.ok(readFileSync(join(dirname(donor), 'package-lock.json')).equals(readFileSync('package-lock.json')));
const lock = JSON.parse(readFileSync('package-lock.json'));
const native = ['esbuild', '@esbuild/linux-x64', 'rollup', '@rollup/rollup-linux-x64-gnu', '@rollup/rollup-linux-x64-musl'];
for (const name of native) {
  const pkg = JSON.parse(readFileSync(join(donor, name, 'package.json')));
  assert.equal(pkg.version, lock.packages['node_modules/' + name].version, name + ': genuine lock-matched package required');
}
await cp(donor, dependencies, { recursive: true, dereference: true, filter: p => !/\/\.vite[^/]*(\/|$)/.test(p) });
writeFileSync(join(out, 'dependency-scope.json'), JSON.stringify({ donor, native, lockMatched: true, dereference: true, privateTree: dependencies }, null, 2));
const put = (name, content) => { mkdirSync(dirname(join(repo, name)), { recursive: true }); writeFileSync(join(repo, name), content); };
const manifest = JSON.stringify({ name: 'private-native-package-preflight', version: '0.0.0', private: true, type: 'module' });
const fixtureLock = JSON.stringify({ name: 'private-native-package-preflight', version: '0.0.0', lockfileVersion: 3, packages: { '': { name: 'private-native-package-preflight', version: '0.0.0' } } });
for (const base of [repo, dirname(dependencies)]) {
  writeFileSync(join(base, 'package.json'), manifest); writeFileSync(join(base, 'package-lock.json'), fixtureLock);
}
put('.gitignore', 'node_modules/\ndist-server/\nphone/dist/\nboard/dist/\n');
put('app.ts', 'export const value: number = 42;\n');
put('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true, skipLibCheck: true, types: [] }, files: ['app.ts'] }));
for (const dir of ['phone', 'board', 'server']) put(dir + '/tsconfig.json', JSON.stringify({ extends: '../tsconfig.json', files: ['../app.ts'] }));
for (const dir of ['phone', 'board']) put(dir + '/vite.config.ts', `export default {build:{outDir:'${dir}/dist',lib:{entry:'app.ts',formats:['es'],fileName:'fixture'}}};`);
// Real native service requests, NOT a version-only or module-resolution check.
put('server/build.mjs', "import assert from 'node:assert/strict'; import {transform,build} from 'esbuild'; const result=await transform('const n: number = 42',{loader:'ts'}); assert.match(result.code,/42/); await build({entryPoints:['app.ts'],bundle:true,outfile:'dist-server/fixture.js'}); console.log('REAL esbuild transform + build passed');\n");
put('server/vitest.config.ts', "export default {test:{include:['server/test/*.test.ts']}};\n");
put('server/test/native.test.ts', "import {it,expect} from 'vitest'; import {value} from '../../app'; it('actual native compilation',()=>expect(value).toBe(42));\n");
put('test/harness/register.mjs', '// Private synthetic preflight only.\n');
put('test/harness/native.test.ts', "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../../app.ts'; test('native input',()=>assert.equal(value,42));\n");
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init', '-qb', 'main'); git('add', '.'); git('commit', '-qm', 'Private actual native package preflight');
const revision = git('rev-parse', 'HEAD');
await build({ entryPoints: ['server/simpleShipHost.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'simple-ship.mjs') });
const host = await import(pathToFileURL(join(out, 'simple-ship.mjs')).href);
const config = { repo, remote: 'origin', workRoot: join(out, 'runs'), dependencies, pi: process.env.VC_TEST_PI_DIR, node: process.execPath, npm: realpathSync(process.env.VC_PROOF_NPM), bash: realpathSync('/run/current-system/sw/bin/bash'), bwrap: process.env.VC_PROOF_BWRAP, path: process.env.PATH };
const run = host.createRunRoot(config);
const receipts = await host.runShipGates(config, repo, revision, run);
writeFileSync(join(out, 'gates.json'), JSON.stringify(receipts, null, 2));
for (const r of receipts) {
  assert.equal(r.exitCode, 0, r.gate + ': ' + r.logArtifact);
  assert.equal(r.timedOut, false, r.gate); assert.equal(r.complete, true, r.gate);
}
assert.equal(receipts.find(r => r.gate === 'test:server').tests.length, 1);
assert.equal(receipts.find(r => r.gate === 'test:harness').tests.length, 1);
console.log('PACKAGE PREFLIGHT PASSED: actual production bwrap argv/private HOME; esbuild transform/build, Vite builds, Vitest native test. Synthetic tiny input only: ' + out);
