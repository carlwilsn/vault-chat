/** Finite dev fixture. No engine/model, installed authority, main mutation, or private-state file editing. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer as netServer } from 'node:net';
import { startHttpServer } from '../../server/http';
import { configureContext } from '../../server/context/config';
import { configureChangeDelivery, observeChangeDelivery } from '../../server/changeDelivery';
import { acceptedChanges, updateShippingJournal, type AcceptedChange } from '../../server/changeShipping';
import { promote } from '../../server/simpleShipHost';
import { ensureMain, appendNotes, patchMeta } from '../../server/engine/convs';
import { gitCommands } from '../../server/commands/gitcmds';

const root = process.env.VC_APP_PROOF_OUT!, repoSource = process.cwd(), runFull = process.argv.includes('--run');
assert.ok(root && root !== repoSource); mkdirSync(root, { recursive: true });
const { createServer, react, build, appProof, previewPlugin } = (globalThis as any).__nativeProofModules;
const bind = async (port: number) => { const s = netServer(); await new Promise<void>((yes, no) => { s.once('error', no); s.listen(port, '127.0.0.1', yes); }); return s; };
for (const key of ['VC_PORT', 'VC_APP_PROOF_PORT']) { const port = Number(process.env[key]); assert.ok(port > 1024 && port < 65536 && ![8848,8857].includes(port)); const s = await bind(port); await new Promise<void>(r => s.close(() => r())); }
// Prove refusal of an occupied private listener without adopting or killing it.
const occupied = await bind(0); try { await assert.rejects(bind((occupied.address() as any).port), {code:'EADDRINUSE'}); } finally { occupied.close(); }
const vault = process.env.VC_VAULT!; mkdirSync(vault, { recursive: true }); configureContext({ vault }); await ensureMain(vault);
const scope = { name: 'fixture', path: vault, bare: join(root, 'unused.git'), main: true };
const http = await startHttpServer({ health: async () => ({ ok: true, app:'vault-chat-server', version:'fixture', revision:'synthetic', keys:{}, hasKey:false }), syncStatus: () => ({}), alert: async () => { throw Error('OS push forbidden'); }, onGitPushed: () => { throw Error('fixture publication forbidden'); }, vault: name => !name || name === 'fixture' ? scope : null, vaultList: () => [scope], vaultStatus: async () => ({ running:false }), engine: { models: () => [], message: async () => { throw Error('models forbidden'); }, answer: async () => { throw Error('answers forbidden'); }, kill: async () => ({ok:false}), subagent: async () => ({ok:false}), intent: async () => { throw Error('no user intents in read-only fixture'); } } });
const baseHTTP = `http://127.0.0.1:${process.env.VC_PORT}`;
const request = async (path: string, body?: unknown, native = false) => {
 const r = await fetch(baseHTTP + path + (path.includes('?') ? '&' : '?') + 'vault=fixture', { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type':'application/json', ...(native ? { 'tailscale-user-login':'fixture@example.invalid', 'x-forwarded-for':'100.64.0.99' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
 const data = await r.json(); if (!r.ok) throw Error(`${r.status}: ${JSON.stringify(data)}`); return data;
};
let vite: any;
try {
 const repo = join(vault, 'app'); mkdirSync(repo);
 const put = (p: string, text: string) => { mkdirSync(dirname(join(repo,p)),{recursive:true}); writeFileSync(join(repo,p),text); };
 const g = (...args: string[]) => execFileSync('git', ['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args], {cwd:repo, encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 put('.gitignore', '.vault-chat/\nnode_modules/\ndist/\ndist-server/\nphone/dist/\nboard/dist/\n');
 // Explicitly small SYNTHETIC source, real installed compiler/test/builder packages, not fake app gates.
 const manifest = JSON.stringify({name:'private-native-history-fixture',version:'0.0.0',private:true,type:'module'});
 const lock = JSON.stringify({name:'private-native-history-fixture',version:'0.0.0',lockfileVersion:3,packages:{'':{name:'private-native-history-fixture',version:'0.0.0'}}});
 put('package.json', manifest); put('package-lock.json',lock);
 put('app.ts','export const value: number = 1;\n');
 put('tsconfig.json',JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',noEmit:true,skipLibCheck:true,types:[]},files:['app.ts']}));
 for (const dir of ['phone','board','server']) put(`${dir}/tsconfig.json`,JSON.stringify({extends:'../tsconfig.json',files:['../app.ts']}));
 for (const dir of ['phone','board']) put(`${dir}/vite.config.ts`, `export default {build:{outDir:'${dir}/dist',lib:{entry:'app.ts',formats:['es'],fileName:'fixture'}}};`);
 put('server/build.mjs',"import {build} from 'esbuild'; await build({entryPoints:['app.ts'],bundle:true,outfile:'dist-server/fixture.js'});\n");
 put('server/vitest.config.ts',"export default {test:{include:['server/test/*.test.ts']}};\n");
 put('server/test/fixture.test.ts',"import {it,expect} from 'vitest'; import {value} from '../../app'; it('synthetic value remains positive',()=>expect(value).toBeGreaterThan(0));\n");
 put('test/harness/register.mjs','// No globals needed by this synthetic fixture.\n');
 put('test/harness/fixture.test.ts',"import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../../app.ts'; test('synthetic value remains positive',()=>assert.ok(value>0));\n");
 g('init','-qb','main'); g('add','.');g('commit','-qm','Synthetic base');
 const project = await request('/projects',{folder:repo}); assert.equal(project.slug,'app');
 // Registering the folder excludes project memory from Git. Commit only genuine fixture source.
 assert.equal(g('status','--porcelain'),'');
 const base=g('rev-parse','HEAD'); g('switch','-qc','agent/fixture-change');put('app.ts','export const value: number = 2;\n');g('commit','-qam','Synthetic source change');
 const head=g('rev-parse','HEAD'), tree=g('rev-parse','HEAD^{tree}');g('switch','-q','main');g('remote','add','origin',repo);
 const title='Synthetic source change';
 const change: AcceptedChange = {id:head,source:{base,head,tree,branch:'agent/fixture-change'},preparedAt:new Date().toISOString(),proofDir:join(root,'PRIVATE_SENTINEL'),review:{convId:project.convId,slug:'app',folder:repo,clone:repo,base:'main',branch:'agent/fixture-change',sha:head,title,at:new Date().toISOString()}};
 const dependencies=join(root,'fixture-deps/node_modules');mkdirSync(dependencies,{recursive:true});writeFileSync(join(dirname(dependencies),'package.json'),manifest);writeFileSync(join(dirname(dependencies),'package-lock.json'),lock);
 for(const p of readdirSync('node_modules')) if(!p.startsWith('.vite'))symlinkSync(realpathSync(join('node_modules',p)),join(dependencies,p));
 const config=join(root,'native-config.json');
 writeFileSync(config,JSON.stringify({repo,remote:'origin',workRoot:join(root,'native-runs'),dependencies,pi:process.env.VC_TEST_PI_DIR,node:process.execPath,npm:realpathSync(process.env.VC_PROOF_NPM!),bash:realpathSync('/run/current-system/sw/bin/bash'),bwrap:process.env.VC_PROOF_BWRAP,path:process.env.PATH}));
 let rollbackDone: Promise<void> | undefined;
 const cli = async (mode: string, value: string, name: string) => {
  const child=spawn(process.execPath,[join(root,'native-cli.mjs'),config,repo,mode,value,name,'app',project.convId],{env:process.env,stdio:['ignore','pipe','pipe']});
  let log=''; child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
  try { await new Promise<void>((yes,no)=>{ child.once('error',no);child.once('exit',code=>code===0?yes():no(Error(`native CLI exit ${code}`))); }); }
  finally {writeFileSync(join(root,mode==='--branch'?'native-forward.log':'native-revert.log'),log);}
 };
 if(runFull){
  // --run is parent StartJob only; --check's actual App DOM must pass FIRST.
  await build({entryPoints:['server/simpleShipHost.ts'],bundle:true,platform:'node',format:'esm',outfile:join(root,'native-cli.mjs'),external:['playwright-core'],banner:{js:"import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"}});
  await cli('--branch','agent/fixture-change',title);
 } else await promote(repo,base,head,change);
 assert.equal((await acceptedChanges(repo))[0].source.head,head);
 put('later.txt','unrelated later scope preserved\n');g('add','later.txt');g('commit','-qm','Unrelated later scope');const later=g('rev-parse','HEAD');
 await appendHistory();
 async function appendHistory(){ const log=await gitCommands.git_log_subdir!({vault,subdir:'app',maxCount:20});appendNotes(vault,project.convId,[{kind:'line',role:'assistant',text:`Private fixture native Git history\n\nAccepted range: ${base}..${head}\n\n\`\`\`text\n${log}\n\`\`\``}]); }
 await patchMeta(vault,project.convId,{subagents:[{id:'fixture-worker',task:'Inspect synthetic native range',status:'done',startedAt:Date.now()-1000,finishedAt:Date.now(),said:`Native Git ${base.slice(0,8)}..${head.slice(0,8)}`} ]});
 let release={id:'fixture-release',version:'0.0.1',revision:head,tag:'fixture-only-v0.0.1',publishedAt:new Date(Date.now()-1000).toISOString()};
 configureChangeDelivery({vaults:()=>[scope],stateDir:join(root,'delivery-state'),boxHealth:async()=>({version:release.version,revision:release.revision,observedAt:Date.now(),ready:true}),requestSourceRollback:async(_repo,id)=>{
   assert.equal(_repo,repo);assert.equal(id,head);
   rollbackDone=cli('--rollback',id,'Synthetic native source revert').then(async()=>{
    assert.equal(readFileSync(join(repo,'app.ts'),'utf8'),'export const value: number = 1;\n');
    assert.equal(readFileSync(join(repo,'later.txt'),'utf8'),'unrelated later scope preserved\n');
    assert.equal(g('status','--porcelain'),'');await appendHistory();
    const changes=await acceptedChanges(repo);assert.equal(changes.at(-1)?.rollbackOf,head);
    writeFileSync(join(root,'native-tree.json'),JSON.stringify({base,head,later,revert:g('rev-parse','HEAD'),tree:g('rev-parse','HEAD^{tree}'),changes},null,2));
   });
   await rollbackDone;return {status:'accepted'};
 }});
 process.env.VC_REALBOX=baseHTTP;
 vite=await createServer({configFile:false,root:repoSource,base:'/proof/',clearScreen:false,logLevel:'warn',cacheDir:join(root,'vite-cache'),plugins:[react(),previewPlugin({side:'proof',tree:repoSource,label:'private native fixture',base:'/proof/'})],server:{host:'127.0.0.1',port:Number(process.env.VC_APP_PROOF_PORT),strictPort:true,fs:{allow:[repoSource,realpathSync('node_modules'),...readdirSync('node_modules/@fontsource').map(n=>realpathSync(join('node_modules/@fontsource',n)))]}},optimizeDeps:{entries:['index.html']}});
 await vite.listen();
 const healthy=async()=>{
  await observeChangeDelivery(repo);
  const {challenge}=await request('/api/v1/release-health/challenge',undefined,true);assert.ok(challenge);
  await request('/api/v1/release-health/laptop',{...challenge,tauri:true,frontendMounted:true,boxConnected:true,syncReady:true,updaterReady:true},true);
  await observeChangeDelivery(repo);
 };
 await appProof({base:`http://127.0.0.1:${process.env.VC_APP_PROOF_PORT}/proof`,out:root,id:head,title,smoke:!runFull,rollback:async()=>{assert.ok(rollbackDone);await rollbackDone;},advance:async(phase:string)=>{
  if(phase==='pending'){await updateShippingJournal(repo,j=>{j.changes[0]!.release=release;});await observeChangeDelivery(repo);}
  else if(phase==='healthy')await healthy();
  else if(phase==='revert-healthy'){
   const revert=(await acceptedChanges(repo)).at(-1)!;release={...release,id:'fixture-revert-release',version:'0.0.2',revision:revert.source.head,tag:'fixture-only-v0.0.2'};
   await updateShippingJournal(repo,j=>{j.changes.find(c=>c.id===revert.id)!.release=release;});await healthy();
  }else if(phase==='redirect'){
   const {shipments}=await request('/api/v1/shipments');const p=new URL(shipments.find((c:any)=>c.id===head).proof.summaryUrl,baseHTTP).searchParams.get('path')!;
   const path=join(vault,p);unlinkSync(path);symlinkSync(join(root,'absent-PRIVATE_SENTINEL'),path);
  }else throw Error('unknown phase');
 }});
 writeFileSync(join(root,'result.json'),JSON.stringify({mode:runFull?'private-native-cli-fixture':'preflight-native-promote-only',scope:'actual App + actual HTTP; synthetic auth observations NOT authenticated installed hardware',source:process.env.VC_APP_SOURCE,base,head,later},null,2));
 console.log(`PASS ${runFull?'private native CLI App fixture':'short actual App DOM/native history preflight'} ${root}`);
} finally { await vite?.close();http.closeAllConnections();await new Promise<void>(yes=>http.close(()=>yes())); }
