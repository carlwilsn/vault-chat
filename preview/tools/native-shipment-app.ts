/** Finite dev fixture. No engine/model, installed authority, main mutation, or private-state file editing. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createServer as netServer } from 'node:net';
import { startHttpServer } from '../../server/http';
import { configureContext } from '../../server/context/config';
import { configureChangeDelivery, observeChangeDelivery } from '../../server/changeDelivery';
import { acceptedChanges, updateShippingJournal, type AcceptedChange } from '../../server/changeShipping';
import { promote, prepareRevert } from '../../server/simpleShipHost';
import { runInstalledShip, requestRollback } from '../../server/submitChange';
import { readJobs, probeJob } from '../../server/engine/pi/jobs';
import { cp } from 'node:fs/promises';
import { ensureMain, appendNotes, patchMeta, createConv } from '../../server/engine/convs';
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
 const data = await r.json(); writeFileSync(join(root,'private-http.jsonl'),JSON.stringify({method:body===undefined?'GET':'POST',path,status:r.status,nativeFixtureIdentity:native,responseKeys:Object.keys(data)})+'\n',{flag:'a'}); if (!r.ok) throw Error(`${r.status}: ${JSON.stringify(data)}`); return data;
};
let vite: any;
try {
 const repo = join(vault, 'app'); mkdirSync(repo);
 // Production HTTP rejection matrix. Synthetic sentinels only, no private user files.
 const outside = join(root,'PRIVATE_SENTINEL-outside'); writeFileSync(outside,'VC_FAKE_SECRET');
 symlinkSync(outside,join(vault,'live-link')); symlinkSync(join(root,'PRIVATE_SENTINEL-missing'),join(vault,'dangling-link'));
 const noRead = join(vault,'denied.txt'); writeFileSync(noRead,'VC_FAKE_SECRET'); chmodSync(noRead,0);
 try {
  for(const [name,path,status] of [['traversal','../PRIVATE_SENTINEL-outside',403],['live-symlink','live-link',403],['dangling-symlink','dangling-link',404],['missing','missing.txt',404],['permission','denied.txt',403]] as const){
   const response=await fetch(baseHTTP+'/api/v1/vault/file?vault=fixture&path='+encodeURIComponent(path)); const body=await response.text();
   assert.equal(response.status,status,name); assert.doesNotMatch(body,/PRIVATE_SENTINEL|VC_FAKE_SECRET|\/tmp\/|ENOENT|EACCES|EPERM|stack/);
   assert.ok(JSON.parse(body).error); writeFileSync(join(root,'file-boundary.jsonl'),JSON.stringify({name,status:response.status,body})+'\n',{flag:'a'});
  }
 } finally { chmodSync(noRead,0o600); }

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
 const jobs={logDir:join(root,'jobs'),wrap:null,env:{}};
 const installed=join(process.env.HOME!,'.local/lib/vault-chat/simple-ship');
 if(runFull){
  // Genuine installed packages are copied into this fixture's own dependency root.
  // Native bwrap cannot follow host-home symlinks, and caches must never mutate shared packages.
  const dependencies=join(root,'fixture-deps/node_modules');mkdirSync(dependencies,{recursive:true});
  writeFileSync(join(dirname(dependencies),'package.json'),manifest);writeFileSync(join(dirname(dependencies),'package-lock.json'),lock);
  for(const p of readdirSync('node_modules')) if(!p.startsWith('.vite'))await cp(realpathSync(join('node_modules',p)),join(dependencies,p),{recursive:true,verbatimSymlinks:true});
  mkdirSync(installed,{recursive:true});
  writeFileSync(join(installed,'config.json'),JSON.stringify({repo,remote:'origin',workRoot:join(root,'native-runs'),dependencies,pi:process.env.VC_TEST_PI_DIR,node:process.execPath,npm:realpathSync(process.env.VC_PROOF_NPM!),bash:realpathSync('/run/current-system/sw/bin/bash'),bwrap:process.env.VC_PROOF_BWRAP,path:process.env.PATH}));
  await build({entryPoints:['server/simpleShipHost.ts'],bundle:true,platform:'node',format:'esm',outfile:join(installed,'simple-ship.mjs')});
  await runInstalledShip(repo,'--branch','agent/fixture-change',title,'app',project.convId,new AbortController().signal,text=>writeFileSync(join(root,'native-forward.log'),text,{flag:'a'}));
 }else await promote(repo,base,head,change);
 assert.equal((await acceptedChanges(repo))[0].source.head,head);
 const {shipments:initialCards}=await request('/api/v1/shipments');
 const summary=initialCards.find((c:any)=>c.id===head).proof.summaryUrl;
 const legacyFile=await fetch(baseHTTP+summary+'&vault=fixture',{signal:AbortSignal.timeout(10000)});
 assert.equal(legacyFile.status,200);const publicSummary=await legacyFile.text();
 assert.ok(publicSummary.includes(head));assert.doesNotMatch(publicSummary,/PRIVATE_SENTINEL|VC_FAKE_SECRET/);
 writeFileSync(join(root,'file-route.jsonl'),JSON.stringify({phase:'source-proof',status:legacyFile.status,sourceHead:head})+'\n');
 // Preserve a healthy already-projected image through the same production Proof viewer.
 const proofRel=new URL(summary,baseHTTP).searchParams.get('path')!;
 writeFileSync(join(vault,dirname(proofRel),'recording.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=','base64'));

 put('later.txt','unrelated later scope preserved\n');g('add','later.txt');g('commit','-qm','Unrelated later scope');const later=g('rev-parse','HEAD');
 await createConv(vault,{kind:'worker',source:'worker',project:'app',title:'Native finished worker'},'Native finished worker','fixture-worker');
 appendNotes(vault,'fixture-worker',[{kind:'line',role:'assistant',text:'Correct native child report for fixture-delegate'}]);
 // A different call in the same parent must not acquire this worker link.
 appendNotes(vault,project.convId,[{kind:'tool',clientId:'fixture-other-call',name:'Read',args:{path:'app.ts'},result:'Unrelated call with no worker'}]);
 appendNotes(vault,project.convId,[{kind:'tool',clientId:'fixture-delegate',name:'Delegate',args:{task:'Inspect synthetic native range'},result:'Private synthetic worker completed'}]);
 await appendHistory();
 async function appendHistory(){ const log=await gitCommands.git_log_subdir!({vault,subdir:'app',maxCount:20});appendNotes(vault,project.convId,[{kind:'line',role:'assistant',text:`Private fixture native Git history\n\nAccepted range: ${base}..${head}\n\n\`\`\`text\n${log}\n\`\`\``}]); }
 await patchMeta(vault,project.convId,{subagents:[{threadId:'fixture-worker',toolCallId:'fixture-delegate',task:'Inspect synthetic native range',state:'completed',startedAt:Date.now()-1000,endedAt:Date.now(),said:`Native Git ${base.slice(0,8)}..${head.slice(0,8)}`} ]});
 let release={id:'fixture-release',version:'0.0.1',revision:head,tag:'fixture-only-v0.0.1',publishedAt:new Date(Date.now()-1000).toISOString()};
 configureChangeDelivery({vaults:()=>[scope],stateDir:join(root,'delivery-state'),boxHealth:async()=>({version:release.version,revision:release.revision,observedAt:Date.now(),ready:true}),requestSourceRollback:async(_repo,id)=>{
   assert.equal(_repo,repo);assert.equal(id,head);
   if(runFull){
    const accepted=(await acceptedChanges(repo)).find(c=>c.id===id)!;
    const result=await requestRollback({vault,accepted,reason:'Private fixture card click',jobs,byCarl:false});
    assert.ok(result.job);return {status:'running',jobId:result.job.id};
   }
   const original=(await acceptedChanges(repo)).find(c=>c.id===id)!;
   const rbBase=g('rev-parse','HEAD'),branch='agent/fixture-revert';
   const rb=await prepareRevert(repo,original,rbBase,root,branch);
   await promote(repo,rbBase,rb.head,{...change,review:{...change.review,title:'Synthetic native source revert'},id:rb.head,source:{base:rbBase,head:rb.head,tree:rb.tree,branch},rollbackOf:id});
   return {status:'accepted'};

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
 await appProof({base:`http://127.0.0.1:${process.env.VC_APP_PROOF_PORT}/proof`,out:root,id:head,title,smoke:false,rollback:async()=>{
  let reverted=false;
  for(let i=0;i<(runFull?12000:100);i++){
   const changes=await acceptedChanges(repo);
   if(changes.some(c=>c.rollbackOf===head)){
    reverted=true;
    assert.equal(readFileSync(join(repo,'app.ts'),'utf8'),'export const value: number = 1;\n');
    assert.equal(readFileSync(join(repo,'later.txt'),'utf8'),'unrelated later scope preserved\n');
    assert.equal(g('status','--porcelain'),'');g('merge-base','--is-ancestor',later,'HEAD');await appendHistory();
    writeFileSync(join(root,'native-tree.json'),JSON.stringify({base,head,later,revert:g('rev-parse','HEAD'),tree:g('rev-parse','HEAD^{tree}'),changes},null,2));break;
   }
   for(const job of readJobs(jobs)){const p=probeJob(jobs,job);if(p.state!=='running'&&p.exit!==0)throw Error('Private native rollback job failed: '+JSON.stringify(p));}
   await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(reverted,'native rollback must finish');
 },advance:async(phase:string)=>{
  if(phase==='pending'){await updateShippingJournal(repo,j=>{j.changes[0]!.release=release;});await observeChangeDelivery(repo);}
  else if(phase==='healthy')await healthy();
  else if(phase==='revert-healthy'){
   const revert=(await acceptedChanges(repo)).at(-1)!;release={...release,id:'fixture-revert-release',version:'0.0.2',revision:revert.source.head,tag:'fixture-only-v0.0.2'};
   await updateShippingJournal(repo,j=>{j.changes.find(c=>c.id===revert.id)!.release=release;});await healthy();
  }else if(phase==='redirect'){
   const {shipments}=await request('/api/v1/shipments');const p=new URL(shipments.find((c:any)=>c.id===head).proof.summaryUrl,baseHTTP).searchParams.get('path')!;
   const path=join(vault,p);unlinkSync(path);symlinkSync(join(root,'absent-PRIVATE_SENTINEL'),path);
   const denied=await fetch(baseHTTP+shipments.find((c:any)=>c.id===head).proof.summaryUrl+'&vault=fixture',{signal:AbortSignal.timeout(10000)});
   assert.equal(denied.status,403);const text=await denied.text();assert.doesNotMatch(text,/PRIVATE_SENTINEL|\/tmp\//);
   writeFileSync(join(root,'file-route.jsonl'),JSON.stringify({phase:'redirect-rejected',status:denied.status,body:text})+'\n',{flag:'a'});return p;
  }else throw Error('unknown phase');
 }});
 writeFileSync(join(root,'result.json'),JSON.stringify({mode:runFull?'private-native-cli-fixture':'preflight-native-promote-only',scope:'actual App + actual HTTP; synthetic auth observations NOT authenticated installed hardware',source:process.env.VC_APP_SOURCE,base,head,later},null,2));
 console.log(`COMPLETED positive worker navigation and safe visible proof rejection assertions: ${runFull?'private native CLI App fixture':'short actual App DOM/native history preflight'} ${root}`);
} finally { await vite?.close();http.closeAllConnections();await new Promise<void>(yes=>http.close(()=>yes())); }
