// Parent StartJob only. Pinned, disposable first-install gate verification, NEVER an installer or promotion.
import { relinkPrivateBins } from './private-package-bins.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const source=process.cwd(), pin=process.argv[2], base=process.argv[3];
if (process.versions.node.split('.')[0] !== '22') throw Error('Use installed Node 22');
if (!source || !/^[a-f0-9]{40}$/.test(pin ?? '')) throw Error('Pass source clone and reviewed full SHA');
const g = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim();
if (g(source, 'rev-parse', 'HEAD') !== pin || g(source, 'status', '--porcelain')) throw Error('Source must be clean at the reviewed pin');
const canonical = '/home/carlwilsn/vc/projects/vault-chat';
if (g(canonical, 'rev-parse', 'HEAD') !== base || g(canonical, 'rev-parse', 'main') !== base) throw Error('Canonical baseline moved: reconcile before launching');
const pinnedNpm='/nix/store/y2j5pbj8x9kfgwgkd0hdrwm6aksszb44-nodejs-slim-22.23.2-npm/lib/node_modules/npm/bin/npm-cli.js';
const donorCheck=realpathSync('/home/carlwilsn/agent-work/vault-chat/changes/vault-chat/node_modules');
if(!readFileSync(join(dirname(donorCheck),'package-lock.json')).equals(readFileSync(join(source,'package-lock.json'))))throw Error('Existing donor lock mismatch');
if(!execFileSync('git',['show',base+':package-lock.json'],{cwd:source}).equals(readFileSync(join(dirname(donorCheck),'package-lock.json'))))throw Error('Baseline donor lock mismatch');
const installedManifest=JSON.parse(readFileSync(join(dirname(donorCheck),'package.json'))), sourceManifest=JSON.parse(readFileSync(join(source,'package.json')));
for(const f of ['dependencies','devDependencies','optionalDependencies','peerDependencies','overrides'])if(JSON.stringify(installedManifest[f])!==JSON.stringify(sourceManifest[f]))throw Error('Existing donor dependency field mismatch: '+f);
for(const p of [pinnedNpm,'/nix/store/d64q19q1xjdwfhqx6czvrjgrhq0n3lcc-python3-3.14.7/bin/python3','/home/carlwilsn/.local/state/vault-chat-server/pi/1.1.0/node_modules/@earendil-works/pi-coding-agent/package.json'])if(!existsSync(p))throw Error('Missing pinned runtime '+p);
if(process.argv.includes('--check')){console.log(JSON.stringify({source,pin,base,clean:true,donor:donorCheck,scope:'Preflight only; no gates/build/install/UI or acceptance executed'}));process.exit(0);}
const out = mkdtempSync('/tmp/ss-'), repo = join(out,'source'); mkdirSync(join(out,'t'));
console.log(`Owned output: ${out}\nBaseline: ${base}\nCandidate: ${pin}`);
writeFileSync(join(out,'pins.json'),JSON.stringify({base,pin,source},null,2));
g(out,'clone','--quiet','--no-local','--no-checkout',source,repo); g(repo,'checkout','--quiet','--detach',pin); g(repo,'cat-file','-e',base+'^{commit}');
const deps = join(out,'dependencies'); mkdirSync(deps);
for (const name of ['package.json','package-lock.json']) writeFileSync(join(deps,name),readFileSync(join(repo,name)));
symlinkSync(join(deps,'node_modules'),join(repo,'node_modules'));
const home=join(out,'home'); mkdirSync(home); for (const f of ['npm-user','npm-global'])writeFileSync(join(out,f),'');
const pi = '/home/carlwilsn/.local/state/vault-chat-server/pi/1.1.0';
if (!existsSync(join(pi,'node_modules/@earendil-works/pi-coding-agent/package.json')))throw Error('Missing actual readonly pi SDK');
const npm=realpathSync(pinnedNpm);
const npmBin=npm.includes('/lib/node_modules/npm/')?npm.split('/lib/node_modules/npm/')[0]+'/bin':dirname(npm);
if(!existsSync(join(npmBin,'npm')))throw Error('Missing real npm bin');
const pythonBin = '/nix/store/d64q19q1xjdwfhqx6czvrjgrhq0n3lcc-python3-3.14.7/bin';
if (!existsSync(join(pythonBin,'python3'))) throw Error('Missing genuine Python binary directory');
const path=[npmBin,dirname(realpathSync(process.execPath)),pythonBin,...process.env.PATH.split(':').map(p=>{try{return realpathSync(p)}catch{return ''}}).filter(p=>p.startsWith('/nix/store/'))].join(':');
const env={PATH:path,HOME:home,TMPDIR:join(out,'t'),LANG:'C.UTF-8',CI:'1',VC_TEST_PI_DIR:pi,VC_PORT:'19001',VC_VOICE_PORT:'19102',VC_VOICE_PIPELINE_PORT:'19101',VC_VOICE_BRAIN:'off',VC_VOICE_PIPELINE:'off',npm_config_userconfig:join(out,'npm-user'),npm_config_globalconfig:join(out,'npm-global'),npm_config_cache:join(out,'npm-cache'),GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'};
// Informational local verification only: reuse a lock-matched, already installed
// dependency tree in a private copy. No npm/package installs; NOT host acceptance provisioning.
const donor=realpathSync('/home/carlwilsn/agent-work/vault-chat/changes/vault-chat/node_modules');
const donorLock=join(dirname(donor),'package-lock.json');
if(!existsSync(donorLock)||!readFileSync(donorLock).equals(readFileSync(join(repo,'package-lock.json'))))throw Error('Existing dependency lock differs; no installation authorized');
execFileSync('cp',['-aL','--reflink=auto',donor,join(deps,'node_modules')],{env});
writeFileSync(join(out,'package-entrypoints.json'),JSON.stringify(await relinkPrivateBins(join(deps,'node_modules'),donor,join(repo,'package-lock.json')),null,2));
// Never import a donor's Vitest/Vite caches into this private verification.
const { rmSync } = await import('node:fs');
for(const name of ['.vite','.vite-temp','.vite-preview-before'])rmSync(join(deps,'node_modules',name),{recursive:true,force:true});
writeFileSync(join(out,'dependency-scope.json'),JSON.stringify({donor,donorLock,scope:'private copy of existing lock-matched dependencies, not host acceptance provisioning'},null,2));
execFileSync(join(deps,'node_modules/.bin/esbuild'),['--version'],{cwd:deps,env,stdio:'inherit'});
execFileSync(process.execPath,['node_modules/vite/bin/vite.js','--version'],{cwd:deps,env,stdio:'inherit'});
const stage=join(out,'host-stage');
await new Promise((done,fail)=>{const p=spawn(process.execPath,['scripts/prepare-simple-ship.mjs',stage],{cwd:repo,env,stdio:'inherit'});p.on('error',fail);p.on('exit',c=>c===0?done():fail(Error('Host preparation failed '+c)));});
const mod=await import(pathToFileURL(join(stage,'simple-ship.mjs')).href);
const config={...JSON.parse(readFileSync(join(stage,'config.example.json'),'utf8')),repo,dependencies:join(deps,'node_modules'),workRoot:join(out,'runs'),pi,path};
const run=mod.createRunRoot(config);
const baseline=await mod.runShipGates(config,repo,base,run);writeFileSync(join(out,'baseline.json'),JSON.stringify(baseline,null,2));
const candidate=await mod.runShipGates(config,repo,pin,run);writeFileSync(join(out,'candidate.json'),JSON.stringify(candidate,null,2));
let comparison='passed';try{mod.compareChangeGates(baseline,candidate)}catch(e){comparison=String(e);}
const summary={base,pin,out,run,baseline:baseline.map(({tests,...r})=>({...r,total:tests?.length,failures:tests?.filter(t=>t.status==='failed')})),candidate:candidate.map(({tests,...r})=>({...r,total:tests?.length,failures:tests?.filter(t=>t.status==='failed')})),ordinaryComparison:comparison};
writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
// Retired identities remain absent in the full raw reports, never relabeled candidate passes.
// A passing local comparison is NOT installation/publication authority.
process.exitCode=comparison==='passed'?0:2;
