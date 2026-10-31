// Parent StartJob only. No production edits; uses existing preview realbox/native fixture/recorder paths.
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync, symlinkSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {homedir} from 'node:os';
import {preview} from 'vite';
import {newSessionFile, appendEntries, readEntries} from '../../server/convlog/piSession';
import {ConvLog} from '../../server/convlog/log';
import {fakeChat, chatText} from '../../server/test/fakeChat';
import {chromium} from 'playwright-core';
import {encodeRecording,combinedFailure} from './native-recording.mjs';
import {auditMetadata,auditLifecycle,readNativeHeader} from './native-header-audit.mjs';

// Existing helpers have this vitest-provided global; this standalone invocation supplies the same location.
(globalThis as any).__dirname = fileURLToPath(new URL('../../server/test/', import.meta.url));
const {makeVault, startServer, waitFor} = await import('../../server/test/helpers');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const out = process.env.VC_UI_OUT!;
assert.ok(out?.startsWith('/tmp/'));
const pi = process.env.VC_TEST_PI_DIR??join(homedir(),'.local/state/vault-chat-server/pi/1.1.0');
const browserExe = process.env.VC_TEST_BROWSER!;
const ffmpeg = process.env.VC_TEST_FFMPEG!;
const pin = process.env.VC_REV!;
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),pin);
const save = (name:string, value:any) => writeFileSync(join(out,name),JSON.stringify(value,null,2));
const scope = 'Production-bundled actual desktop App via EXISTING preview realbox native-IPC/filesystem fixture; actual server/Engine/PiBackend and pinned native pi 1.1.0. Only LLM endpoint is deterministic local fakeChat. Not installed Tauri, live Main, paid inference, or acceptance proof.';
save('scope.json',{pin,scope,pi,browserExe,ffmpeg});

// Build the actual App with the existing preview's IPC/filesystem adapter, not a custom frontend.
// All chat routes use realbox; no MemoryBox/model/engine state is populated by the proof.
const desktop = join(out,'desktop-production');
// A plain-Node child built all normal production workers serially at this exact code pin.
// Consume fresh outputs or a fully verified owned copy with the ORIGINAL receipt retained.
const built=JSON.parse(readFileSync(join(out,'desktop-build-receipt.json'),'utf8'));
assert.equal(built.pin,pin);assert.equal(built.ok,true);assert.equal(built.serialize,true);
if(built.root!==root) {
  const reuse=JSON.parse(readFileSync(join(out,'desktop-build-reuse.json'),'utf8'));
  assert.equal(reuse.pin,pin);assert.equal(reuse.originalRoot,built.root);assert.equal(reuse.root,root);
  assert.equal(reuse.tree,execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:root,encoding:'utf8'}).trim());
  assert.equal(reuse.receiptSHA,createHash('sha256').update(readFileSync(join(out,'desktop-build-receipt.json'))).digest('hex'));
  assert.equal(reuse.ok,true);
}
assert.ok(built.files['index.html']);
for(const [path,hash] of Object.entries(built.files))assert.equal(createHash('sha256').update(readFileSync(join(desktop,path))).digest('hex'),hash);
save('desktop-build-consumed.json',{pin,root,buildPid:built.pid,consumerPid:process.pid,files:Object.keys(built.files).length});

// Transparent byte tee, NOT a protocol implementation/controller. It never fabricates/changes commands/events.
// fd3 and fd4 go straight to native pi: never read, copied into evidence, or printed.
function tracedNative(home:string, audit:string, networkFixture:string) {
  const prefix=join(home,'traced-native');
  const pkg=join(prefix,'node_modules/@earendil-works/pi-coding-agent');
  const actual=join(pi,'node_modules/@earendil-works/pi-coding-agent');
  assert.equal(JSON.parse(readFileSync(join(actual,'package.json'),'utf8')).version,'1.1.0');
  mkdirSync(join(pkg,'dist/bundle'),{recursive:true});
  mkdirSync(join(home,'tmp'),{recursive:true});mkdirSync(join(home,'cache'),{recursive:true});
  writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.1.0',type:'module'}));
  symlinkSync(join(actual,'dist/core'),join(pkg,'dist/core'));
  writeFileSync(join(pkg,'dist/bundle/cli.js'),`
import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
const rpc=process.argv.includes('rpc');
const child=spawn(process.execPath,[${JSON.stringify(join(actual,'dist/bundle/cli.js'))},...process.argv.slice(2)],{env:{...process.env,NODE_OPTIONS:${JSON.stringify('--import ')}+${JSON.stringify(networkFixture)},TMPDIR:${JSON.stringify(join(home,'tmp'))},XDG_CACHE_HOME:${JSON.stringify(join(home,'cache'))},NODE_COMPILE_CACHE:${JSON.stringify(join(home,'cache/node'))}},stdio:rpc?['pipe','pipe','inherit',3,4]:['inherit','inherit','inherit']});
if(rpc){
 appendFileSync(${JSON.stringify(audit)},JSON.stringify({at:Date.now(),pid:process.pid,direction:'provenance',record:{type:'native_process',childPid:child.pid,cli:${JSON.stringify(join(actual,'dist/bundle/cli.js'))}}})+'\\n');
 const buffers={input:'',output:''};
 function trace(direction,chunk){appendFileSync(${JSON.stringify(audit)}+'.'+direction+'.ndjson',chunk);buffers[direction]+=chunk.toString('utf8');let n;while((n=buffers[direction].indexOf('\\n'))>=0){const line=buffers[direction].slice(0,n);buffers[direction]=buffers[direction].slice(n+1);try{appendFileSync(${JSON.stringify(audit)},JSON.stringify({at:Date.now(),pid:process.pid,direction,record:JSON.parse(line)})+'\\n');}catch{}}}
 process.stdin.on('data',b=>trace('input',b));process.stdin.pipe(child.stdin);
 child.stdout.on('data',b=>trace('output',b));child.stdout.pipe(process.stdout);
}
child.on('error',e=>{console.error(e);process.exit(1);});child.on('exit',(c,s)=>{process.exit(c??1);});
process.on('SIGTERM',()=>child.kill('SIGTERM'));
`);
  return prefix;
}

// Recorder pattern reused from chat-asset-origin-proof.mjs: public CDP + actual timestamps + public ffmpeg.
async function record(context:any,page:any,dir:string) {
  mkdirSync(dir,{recursive:true});
  const cdp=await context.newCDPSession(page), frames:any[]=[],acks:Promise<any>[]=[],errors:string[]=[];
  cdp.on('Page.screencastFrame',(e:any)=>{
    const file=`frame-${String(frames.length).padStart(6,'0')}.jpg`;
    try {writeFileSync(join(dir,file),Buffer.from(e.data,'base64'));frames.push({file,timestamp:e.metadata.timestamp});}catch(e){errors.push(String(e));}
    acks.push(cdp.send('Page.screencastFrameAck',{sessionId:e.sessionId}).catch((e:any)=>errors.push(String(e))));
  });
  await cdp.send('Page.startScreencast',{format:'jpeg',quality:80,maxWidth:1400,maxHeight:900,everyNthFrame:1});
  return async()=>{
    const failures:any[]=[];
    try{await cdp.send('Page.stopScreencast');}catch(e){failures.push(e);}
    await Promise.all(acks);
    // Arrival-order raw evidence survives even if stop/encode fails.
    writeFileSync(join(dir,'frames.json'),JSON.stringify(frames,null,2));
    try{assert.deepEqual(errors,[]);}catch(e){failures.push(e);}
    try{encodeRecording(dir,join(dir,'presentation'),ffmpeg);}catch(e){failures.push(e);}
    const failure=combinedFailure(undefined,failures);if(failure)throw failure;
  };
}

// engine.ts's PRE-EXISTING surface envelope (also present on baseline 8e540669).
// Compare the whole native string; never strip a prefix or use substring matching for user counts.
const fixtureDevice='laptop';
const nativeText=(typed:string)=>`[Carl, on his ${fixtureDevice}]\n\n${typed}`;
const exactUserContent=(entry:any,typed:string)=>entry.message?.role==='user'&&
  JSON.stringify(entry.message.content)===JSON.stringify([{type:'text',text:nativeText(typed)}]);
// Exact fixture expectations use production profile=user: memory is HTML, document_text is literal.
// Explicit expected visible text: do not apply a generic HTML/prefix stripper to arbitrary user text.
const visibleText=new Map<string,string>();
const preflightOnly=process.env.VC_UI_IDENTITY_PREFLIGHT==='1';
const results:any[]=[];
for (const scenario of (preflightOnly?['identity-preflight']:['late-accept-queue','stop-before-accept','stop-after-accept'])) {
  const dir=join(out,scenario);mkdirSync(dir,{recursive:true});
  const home=join(dir,'home');mkdirSync(home,{recursive:true});
  const vault=makeVault(join(home,'vault')),state=join(home,'state');
  const hidden='Q1_HIDDEN_CONTEXT_CANARY_'+scenario;
  mkdirSync(join(vault,'.vault-chat'),{recursive:true});
  writeFileSync(join(vault,'.vault-chat/MEMORY.md'),`# Memory\n\n- ${hidden}\n`);
  const audit=join(dir,'native-rpc.jsonl');writeFileSync(audit,'');
  const networkFixture=join(home,'local-provider-only.mjs');
  const prefix=tracedNative(home,audit,networkFixture);
  const sid=randomUUID(),sessions=join(state,'pi/sessions');
  const session=newSessionFile(join(sessions,`2026-10-30T00-00-00-000Z_${sid}.jsonl`),vault,sid);
  const seed=appendEntries(session,[
    {type:'model_change',provider:'openrouter',modelId:'test/fake-model'},
    {type:'message',message:{role:'user',content:[{type:'text',text:'Synthetic retained fixture history. '+ 'bounded history '.repeat(300)}],timestamp:Date.now()-10000}},
    {type:'message',message:{role:'assistant',content:[{type:'text',text:'Synthetic fixture history acknowledged.'}],api:'openai-completions',provider:'openrouter',model:'test/fake-model',usage:{input:12000,output:20,cacheRead:0,cacheWrite:0,totalTokens:12020,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()-9000}}
  ] as any);
  // Only fixture seeding, before server or any pi process opens the files. No model/app state mutation afterwards.
  const instr=join(state,'pi/instr');mkdirSync(instr,{recursive:true});
  writeFileSync(join(instr,'fixture.md'),'Synthetic native UI proof. No external services.');
  writeFileSync(join(instr,`${sid}.json`),JSON.stringify({instr:join(instr,'fixture.md'),tools:'fixture-bootstrap-only',cwd:vault,subagents:false}));
  const log=new ConvLog(vault);
  log.emit('main',{type:'meta',patch:{kind:'main',source:'main',title:'Main',createdAt:Date.now()-10000,lastActivityAt:Date.now()-9000,threadId:sid,threadPath:session}});
  for(const e of seed.filter(e=>e.type==='message')) log.emit('main',{type:'entry',file:session,entry:e});
  const provider=await fakeChat();
  // HTTP-only fixture boundary: the server's hardcoded PUBLIC catalog GET goes to fakeChat's existing /models.
  // Every other non-loopback fetch fails closed. No user-facing route, engine or native event is mocked here.
  const outbound=join(dir,'outbound-fetch.jsonl');writeFileSync(outbound,'');
  writeFileSync(networkFixture,`
import {appendFileSync} from 'node:fs';
const actual=globalThis.fetch;
globalThis.fetch=(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(url.href==='https://openrouter.ai/api/v1/models'){
  appendFileSync(${JSON.stringify(outbound)},JSON.stringify({kind:'catalog-fixture',at:Date.now()})+'\\n');
  return actual(${JSON.stringify(provider.url+'/models')},init);
 }
 if(url.hostname==='127.0.0.1'||url.hostname==='localhost'||url.hostname==='[::1]')return actual(input,init);
 appendFileSync(${JSON.stringify(outbound)},JSON.stringify({kind:'refused',origin:url.origin,path:url.pathname})+'\\n');
 throw new Error('Private fixture refuses external fetch: '+url.origin+url.pathname);
};
`);
  let recovering=false;
  provider.respond=(body,n)=> {
    const summary=(body.messages??[]).some((m:any)=>m.role==='system'&&chatText({messages:[m]}).includes('You are a context summarization assistant.'));
    return summary ? {text:'Summary of synthetic retained history.',delayMs:n===1?(scenario==='stop-after-accept'?1000:68000):100}
      : {text:'Native fixture response delivered.',delayMs:recovering?500:scenario==='late-accept-queue'?1000:30000};
  };
  let srv:any, web:any, browser:any, finish:any;
  const evidence:any={scenario,pin,scope,pageErrors:[],consoleErrors:[],httpErrors:[],networkFailures:[],navigationAborts:[],blocked:[],http:[],feed:[],nativeInputs:[],ok:false};
  const rpc=()=>readFileSync(audit,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));
  const native=(type:string,direction='output')=>rpc().filter(e=>e.direction===direction&&e.record.type===type);
  const conv=async()=>{const r=await fetch(srv.base+'/conversation?id=main&full=1&n=200');assert.ok(r.ok);return r.json() as Promise<any>;};
  let scenarioFailure:any;
  try {
    srv=await startServer({home,vault,secrets:join(home,'empty-no-credentials'),openrouter:provider.url,extra:{VC_PI_DIR:prefix,VC_ENGINE_MODEL:'test/fake-model',VC_STATE_DIR:state,VC_VAULT_NAME:'main',NODE_OPTIONS:'--import '+networkFixture,VC_PI_UNSAFE:'1',VC_VOICE_PIPELINE:'off',VC_VOICE_PORT:'27321',VC_VOICE_PIPELINE_PORT:'27321'}});
    assert.equal(srv.proc.exitCode,null);assert.match(srv.logs(),/listening on/);
    assert.ok(srv.port>0&&![8848,8857].includes(srv.port),'private helper-assigned server port, never adopt a listener');
    const health=await (await fetch(srv.base+'/api/v1/health')).json();
    assert.equal(health.engine?.pi?.state,'up');assert.equal(health.engine.version,'1.1.0');
    save(`${scenario}/health.json`,health);
    // Native config fixture, before the seeded session is opened, using the same model convention as piContext.test.ts.
    const agent=join(state,'pi/agent');
    writeFileSync(join(agent,'settings.json'),JSON.stringify({compaction:{enabled:true,reserveTokens:30000,keepRecentTokens:1},retry:{enabled:false}}));
    writeFileSync(join(agent,'models.json'),JSON.stringify({providers:{openrouter:{baseUrl:provider.url,apiKey:'synthetic-local-only',api:'openai-completions',models:[{id:'test/fake-model',name:'Local synthetic fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}]}}}));
    web=await preview({root,configFile:false,base:'/',build:{outDir:desktop},preview:{host:'127.0.0.1',port:0,strictPort:true,proxy:{'/__realbox':{target:srv.base,changeOrigin:true,rewrite:(p:string)=>p.replace(/^\/__realbox/,'')}}}});
    const origin=`http://127.0.0.1:${web.httpServer.address().port}`;
    browser=await chromium.launch({executablePath:browserExe,headless:true,args:['--mute-audio']});
    const context=await browser.newContext({viewport:{width:1400,height:900}});
    await context.route('**/*',(route:any)=>{const u=new URL(route.request().url());if(['data:','blob:'].includes(u.protocol)||u.origin===origin)return route.continue();evidence.blocked.push(u.href);return route.abort();});
    // Browser fixture bootstrap ONLY. SDK 2.10.1 core.isTauri reads globalThis.isTauri;
    // official mockIPC creates __TAURI_INTERNALS__ without asserting native identity.
    // Existing preview installIpc otherwise unconditionally assigns isTauri=true.
    // Keep that adapter intact; declare honest browser identity before App evaluates.
    // Pass SOURCE TEXT: tsx keepNames inserts __name into serialized nested functions,
    // which caused the retained failed init script to throw before defining the property.
    // No SDK namespace/auth detector patch, auth header, response stub or changed bundle.
    await context.addInitScript({content: `Object.defineProperty(window, 'isTauri', {
      configurable: false, enumerable: true,
      get: function () { return false; }, set: function () {}
    });`});
    const page=await context.newPage();
    page.on('pageerror',(e:any)=>evidence.pageErrors.push(String(e.stack??e)));
    page.on('console',(m:any)=>{if(m.type()==='error')evidence.consoleErrors.push(m.text());});
    let reloading=false;
    page.on('requestfailed',(r:any)=>{
      const failure={url:r.url(),error:r.failure()};
      // Preserve expected cancellation of this page's old long-poll on real native reload separately.
      // No startup/model/HTTP errors are filtered or waived.
      if(reloading&&new URL(r.url()).pathname==='/__realbox/poll'&&r.failure()?.errorText==='net::ERR_ABORTED')evidence.navigationAborts.push(failure);
      else evidence.networkFailures.push(failure);
    });
    const releaseHealthAttempts:string[]=[];
    page.on('request',(r:any)=>{if(new URL(r.url()).pathname.includes('/release-health/'))releaseHealthAttempts.push(r.url());});
    const responses:Promise<any>[]=[];
    page.on('response',(r:any)=>{
      if(r.status()>=400)evidence.httpErrors.push({url:r.url(),status:r.status()});
      if(r.url().includes('/__realbox/'))responses.push((async()=>{const request=r.request();let data;try{data=await r.json();}catch{return;}evidence.http.push({at:Date.now(),url:r.url(),method:request.method(),input:request.postData(),status:r.status(),data});if(new URL(r.url()).pathname.endsWith('/poll'))evidence.feed.push(...(data.events??[]));})());
    });
    if(!preflightOnly)finish=await record(context,page,join(dir,'recording'));
    await page.goto(origin+'/?scenario=realbox&vault=main&side=before&overlay=0&steps=0');
    // Native browser keyboard chord, not a dispatched page event/store hook.
    await page.waitForFunction(()=>!!(window as any).__preview?.ready,null,{timeout:30000});
    evidence.browserIdentity=await page.evaluate(()=>({isTauri:(window as any).isTauri,ipc:typeof (window as any).__TAURI_INTERNALS__?.invoke}));
    assert.deepEqual(evidence.browserIdentity,{isTauri:false,ipc:'function'});
    if(preflightOnly) {
      // Wait for REAL initial conversation/checkpoint responses, not just a mounted shell.
      await waitFor(()=>evidence.http.some((x:any)=>new URL(x.url).pathname==='/__realbox/api/v2/conversations/main/checkpoint'),15000,50);
      await delay(1000);await Promise.all(responses);
      evidence.releaseHealthAttempts=releaseHealthAttempts;
      assert.deepEqual(releaseHealthAttempts,[],'no installed release-health REQUEST, regardless of response');
      assert.deepEqual(evidence.pageErrors,[]);assert.deepEqual(evidence.consoleErrors,[]);assert.deepEqual(evidence.httpErrors,[]);assert.deepEqual(evidence.blocked,[]);assert.deepEqual(evidence.networkFailures,[]);
      assert.ok(evidence.http.some((x:any)=>new URL(x.url).pathname==='/__realbox/api/v2/conversations'&&x.status===200),'realbox actual server responded');
      assert.deepEqual(provider.calls,[],'no model invocation during identity preflight');
      assert.equal(native('native_process','provenance').length,0,'no native compaction scenario during preflight');
      await page.screenshot({path:join(dir,'browser-ready.png')});
      const outboundFetch=readFileSync(outbound,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));
      evidence.outboundFetch=outboundFetch;assert.deepEqual(outboundFetch.filter(x=>x.kind==='refused'),[]);
      assert.deepEqual(releaseHealthAttempts,[]);
      assert.deepEqual(evidence.pageErrors,[]);assert.deepEqual(evidence.consoleErrors,[]);assert.deepEqual(evidence.httpErrors,[]);assert.deepEqual(evidence.blocked,[]);assert.deepEqual(evidence.networkFailures,[]);
      evidence.ok=true;results.push({scenario,ok:true});
      continue; // finally releases this owned browser/server before the full proof process.
    }
    await page.keyboard.press('Control+Shift+F');
    const composer=page.locator('textarea.composer-input:visible');await composer.waitFor({timeout:30000});
    const text=`<memory>Genuine typed ${scenario} request: preserve these literal words.</memory>`;
    visibleText.set(text,`Genuine typed ${scenario} request: preserve these literal words.`);
    const genuine=[text];
    const originalInput=()=>native('prompt','input').filter(x=>x.record.message===nativeText(text));
    const originalAccepted=()=>native('response').filter(x=>x.record.id===originalInput()[0]?.record.id&&x.record.command==='prompt'&&x.record.success&&x.record.data?.disposition==='started');
    const send=async(t:string)=>{await composer.click();await page.keyboard.type(t,{delay:12});assert.equal(await composer.inputValue(),t);await page.locator('[data-el="composer-send"]:visible').click();};
    await send(text);
    await waitFor(()=>native('compaction_start').length>0,30000,50);
    assert.equal(originalInput().length,1,'exact original prompt before either Stop boundary');
    const start=native('compaction_start')[0].at;
    await page.screenshot({path:join(dir,'01-native-compaction-pending.png')});
    if(scenario==='late-accept-queue') {
      await delay(Math.max(0,61500-(Date.now()-start)));
      assert.equal(originalAccepted().length,0,'not accepted past the former 60s deadline');
      assert.equal(originalInput().length,1,'exact laptop-enveloped original native prompt');
      const pending=await conv();assert.ok(pending.meta?.running??pending.status==='running');
      const subsequent='<document_text>Genuine subsequent ask during compaction; retain once.</document_text>';
      // CommonMark HTML tag names cannot contain underscores: document_text is literal text, unlike memory.
      visibleText.set(subsequent,subsequent);
      genuine.push(subsequent);await send(subsequent);
      await waitFor(()=>native('steer','input').some(x=>x.record.message===nativeText(subsequent)),15000,50);
      const steers=native('steer','input').filter(x=>x.record.message===nativeText(subsequent));assert.equal(steers.length,1);
      await waitFor(()=>native('response').some(x=>x.record.id===steers[0].record.id&&x.record.command==='steer'&&x.record.success&&x.record.data?.disposition==='queued'),15000,50);
      await page.locator('[data-el="waiting-mark"]:visible').waitFor({timeout:15000});
      await page.screenshot({path:join(dir,'02-over-60s-subsequent-queued.png')});
      await waitFor(()=>native('agent_settled').length>0,90000,100);
      const accepted=originalAccepted()[0];assert.ok(accepted);assert.ok(accepted.at-start>60000);
      evidence.actualPendingMs=accepted.at-start;
      assert.ok(native('agent_start').length>0);
    } else {
      if(scenario==='stop-after-accept')await waitFor(()=>originalAccepted().length===1,30000,50);
      else assert.equal(originalAccepted().length,0);
      await page.locator('[data-el="composer-stop"]:visible').click();
      await waitFor(()=>native('abort','input').length>0,15000,50);
      await waitFor(()=>native('agent_settled').length>0,45000,100);
      if(scenario==='stop-before-accept')assert.ok(native('compaction_end').some(x=>x.record.aborted));
      await page.screenshot({path:join(dir,'02-native-stop.png')});
    }
    await waitFor(async()=>{const c=await conv();return !c.meta?.running&&c.status!=='running'?c:null;},20000,100);
    await waitFor(async()=>!await page.locator('[data-el="composer-stop"]:visible').count(),15000,100);
    if(scenario!=='late-accept-queue') {
      recovering=true;
      const recovery=`Genuine recovery ask after ${scenario}: continue this same native session.`;
      visibleText.set(recovery,recovery);
      genuine.push(recovery);
      const settled=native('agent_settled').length;
      await send(recovery);
      await waitFor(()=>native('agent_settled').length>settled,30000,50);
      await waitFor(async()=>!await page.locator('[data-el="composer-stop"]:visible').count(),15000,100);
    }
    const before=await conv();save(`${scenario}/conversation-before-reload.json`,before);
    if(scenario!=='late-accept-queue')await page.getByText('Stopped.',{exact:true}).waitFor({timeout:15000});
    assert.equal(before.meta?.threadId??before.threadId,sid,'resume the seeded native session, not a replacement');
    const entries=readEntries(session);
    const header=readNativeHeader(session,sid);
    assert.ok(entries.some(e=>e.type==='custom_message'&&e.customType==='vc-context'&&(e as any).display===false),'native hidden typed context must persist');
    assert.ok(chatText({messages:provider.calls.flatMap(b=>b.messages??[])}).includes(hidden),'actual native model context includes hidden host memory');
    assert.ok(chatText({messages:provider.calls[0]?.messages??[]}).includes('You are a context summarization assistant.'),'first held provider call is real native compaction, not a delayed ordinary reply');
    assert.ok(JSON.stringify(entries.filter(e=>e.customType==='vc-context')).includes(hidden),'actual host memory reached hidden native context');
    const user=entries.filter(e=>e.message?.role==='user');
    for(const t of genuine){assert.equal(user.filter(e=>exactUserContent(e,t)).length,1,'one genuine native input');assert.equal(before.messages.filter((m:any)=>m.role==='user'&&m.content===t).length,1,'one genuine feed message');}
    assert.equal(user.length,genuine.length+1,'only seeded history and genuine inputs are native user entries');
    assert.ok(!JSON.stringify(user).includes(hidden),'hidden context is never native user input');
    assert.ok(!JSON.stringify(before.messages).includes(hidden),'hidden context is not Carl bubble');
    // Persist measured native counts BEFORE any replay/selector assertion can fail.
    evidence.nativeSession={sid,path:session,userCounts:genuine.map(t=>[t,user.filter(e=>exactUserContent(e,t)).length])};
    reloading=true;
    await page.reload();await page.waitForFunction(()=>!!(window as any).__preview?.ready,null,{timeout:30000});
    reloading=false;
    // seedLocalStorage in the EXISTING preview resets UI layout on cold boot; use the real fullscreen shortcut again.
    await page.keyboard.press('Control+Shift+F');await composer.waitFor({timeout:30000});
    // Exact profile=user rendering expectation is fixture-specific; native/feed bytes above are untouched.
    const rendered=(t:string)=>{const visible=visibleText.get(t);assert.ok(visible);return visible;};
    for(const t of genuine)await page.getByText(rendered(t),{exact:true}).waitFor({timeout:15000});
    assert.ok(!(await page.locator('body').innerText()).includes(hidden));
    const after=await conv();save(`${scenario}/conversation-after-reload.json`,after);
    for(const t of genuine){assert.equal(after.messages.filter((m:any)=>m.role==='user'&&m.content===t).length,1);assert.equal(await page.getByText(rendered(t),{exact:true}).count(),1);}
    await page.screenshot({path:join(dir,'03-reloaded-genuine-inputs.png')});
    await Promise.all(responses);
    evidence.nativeInputs=rpc().filter(x=>x.direction==='input'&&['prompt','steer','follow_up','abort','clear_queue'].includes(x.record.type));
    const original=evidence.nativeInputs.filter((x:any)=>x.record.type==='prompt'&&x.record.message===nativeText(text));assert.equal(original.length,1);
    for(const t of genuine)assert.equal(evidence.nativeInputs.filter((x:any)=>['prompt','steer','follow_up'].includes(x.record.type)&&x.record.message===nativeText(t)).length,1,'one native submission per genuine UI input');
    const submitted=evidence.nativeInputs.filter((x:any)=>['prompt','steer','follow_up'].includes(x.record.type));
    // Both vc-note payload families are source-backed and measured: typed hidden context
    // and the one display-only Stop notice. Exact envelopes classify genuine words FIRST;
    // unknown metadata, extra keys, missing handled receipts and duplicate notices fail.
    const expectedContext=`<memory file=".vault-chat/MEMORY.md">\n# Memory\n\n- ${hidden}\n</memory>\n\n<projects>(none yet)</projects>`;
    const protocol={scenario,trace:rpc(),entries,header,knownSessionId:sid,before,after,calls:provider.calls,feed:evidence.feed,genuine,nativeText,hidden,expectedContext};
    evidence.metadataAudit=auditMetadata(protocol);
    evidence.lifecycleAudit=auditLifecycle(protocol);
    const metadata=submitted.filter((x:any)=>evidence.metadataAudit.context.includes(x.record.id)||evidence.metadataAudit.notices.includes(x.record.id));
    const genuineSubmissions=submitted.filter((x:any)=>!metadata.includes(x));
    if(scenario!=='late-accept-queue') {
      assert.equal(await page.getByText('Stopped.',{exact:true}).count(),1,'public Stop notice renders once after reload');
    }
    assert.deepEqual(genuineSubmissions.map((x:any)=>x.record.message).sort(),genuine.map(nativeText).sort(),'no extra or duplicate native submissions');
    assert.ok(genuineSubmissions.every((x:any)=>!JSON.stringify(x.record).includes(hidden)),'no host context concatenated into genuine prompt/steer');
    const modelUsers=provider.calls.flatMap(b=>(b.messages??[]).filter((m:any)=>m.role==='user'));
    for(const t of genuine){
      const counts=provider.calls.map(b=>(b.messages??[]).filter((m:any)=>m.role==='user').reduce((n:number,m:any)=>n+
        (typeof m.content==='string'?Number(m.content===nativeText(t)):Array.isArray(m.content)?m.content.filter((p:any)=>p.type==='text'&&p.text===nativeText(t)).length:0),0));
      assert.ok(counts.every(n=>n<=1),'no duplicate genuine input within any actual model request');
      // A canceled original need not reach inference; native/session exactness is still required above.
      if(scenario==='late-accept-queue'||t!==text)assert.ok(counts.some(n=>n===1),'whole genuine envelope and typed bytes reach actual model input');
    }
    // auditMetadata checks exact command identities, not a substring ban on genuine user words.
    const seeded=String(seed.find(e=>e.message?.role==='user')!.message!.content[0].text);
    assert.equal(after.messages.filter((m:any)=>m.role==='user'&&m.content===seeded).length,1,'history remains once after compaction/reload');
    const trace=rpc();
    const promptId=original[0].record.id;
    const acceptedIndex=trace.findIndex(x=>x.direction==='output'&&x.record.type==='response'&&x.record.id===promptId&&x.record.success&&x.record.data?.disposition==='started');
    assert.ok(acceptedIndex>=0,'original prompt natively accepted once, not merely HTTP ack');
    assert.equal(trace.filter(x=>x.direction==='output'&&x.record.type==='response'&&x.record.id===promptId).length,1);
    if(scenario==='late-accept-queue') {
      const subsequentId=evidence.nativeInputs.find((x:any)=>x.record.type==='steer'&&x.record.message===nativeText(genuine[1])).record.id;
      const queuedIndex=trace.findIndex(x=>x.direction==='output'&&x.record.type==='response'&&x.record.id===subsequentId&&x.record.command==='steer'&&x.record.success&&x.record.data?.disposition==='queued');
      assert.ok(queuedIndex>=0&&queuedIndex<acceptedIndex);
      assert.ok(entries.some(e=>e.type==='compaction'),'native compaction persisted its own entry');
    } else {
      const abortIndices=trace.flatMap((x,i)=>x.direction==='input'&&x.record.type==='abort'?[i]:[]);
      assert.ok(abortIndices.length>0);
      if(scenario==='stop-before-accept'){assert.ok(abortIndices[0]<acceptedIndex);assert.ok(abortIndices.some(i=>i>acceptedIndex),'Stop honored again at native acceptance');}
      else assert.ok(abortIndices[0]>acceptedIndex);
      assert.ok(native('agent_settled').some(x=>x.record.aborted),'native cancellation, not a fabricated stopped state');
      assert.ok(evidence.http.some((x:any)=>x.method==='POST'&&JSON.parse(x.input??'{}').type==='stop'),'real UI Stop reached actual HTTP intent');
    }
    const nativePids=[...new Set(native('native_process','provenance').map(x=>x.record.childPid))];assert.equal(nativePids.length,1);
    assert.equal(new Set(native('agent_start').map(x=>x.pid)).size,1);
    const raw=JSON.stringify({before,after,feed:evidence.feed,log:srv.logs()});
    assert.doesNotMatch(raw,/already processing|could not start this turn|pi did not answer prompt|aborted.startup/i);
    const sends=evidence.http.filter((x:any)=>x.method==='POST'&&new URL(x.url).pathname==='/__realbox/api/v2/intent').map((x:any)=>JSON.parse(x.input??'{}')).filter((x:any)=>x.type==='send'||x.type==='steer');
    // Existing boxSend uses steer while running, send after idle. Assert each exact route, not 'send' for both.
    const expectedIntents=genuine.map((text,i)=>({type:scenario==='late-accept-queue'&&i===1?'steer':'send',text,client:fixtureDevice}));
    assert.deepEqual(sends.map(({type,text,client}:any)=>({type,text,client})),expectedIntents,'exactly one correctly typed real UI HTTP intent per genuine input');
    assert.equal(new Set(sends.map((x:any)=>x.clientId)).size,genuine.length,'distinct genuine input identities');
    assert.ok(evidence.feed.some((x:any)=>JSON.stringify(x).includes('compaction_start')),'native compaction projected through actual HTTP feed');
    const outboundFetch=readFileSync(outbound,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));
    evidence.outboundFetch=outboundFetch;assert.deepEqual(outboundFetch.filter(x=>x.kind==='refused'),[],'no attempted public API/model fetch');
    evidence.releaseHealthAttempts=releaseHealthAttempts;
    assert.deepEqual(releaseHealthAttempts,[],'browser cannot claim installed Tauri health');
    assert.equal(evidence.http.filter((x:any)=>new URL(x.url).pathname.includes('/release-health/')).length,0,'browser cannot claim installed Tauri health');
    assert.deepEqual(evidence.pageErrors,[]);assert.deepEqual(evidence.consoleErrors,[]);assert.deepEqual(evidence.httpErrors,[]);assert.deepEqual(evidence.blocked,[]);assert.deepEqual(evidence.networkFailures,[]);
    evidence.genuine=genuine;evidence.nativeSession={sid,path:session,pids:nativePids,userCounts:genuine.map(t=>[t,user.filter(e=>exactUserContent(e,t)).length])};evidence.ok=true;
    results.push({scenario,ok:true,actualPendingMs:evidence.actualPendingMs});
  } catch(e) {scenarioFailure=e;evidence.failure=String((e as any)?.stack??e);}
  finally {
    // Preserve both identities, then release EVERY owned child even if a prior teardown failed.
    save(`${scenario}/evidence.json`,evidence);save(`${scenario}/provider-calls.json`,provider.calls);
    if(srv)writeFileSync(join(dir,'server.log'),srv.logs());
    const teardown:any[]=[];
    try{if(finish)await finish();}catch(e){evidence.recordingFailure=String((e as any)?.stack??e);teardown.push(e);}
    for(const [phase,release] of [
      ['browser',()=>browser?.close()],
      ['preview',()=>new Promise<void>(r=>web?web.httpServer.close(()=>r()):r())],
      ['server',()=>srv?.stop()],['provider',()=>provider.close()]
    ] as const)try{await release();}catch(e){teardown.push(new Error(`${phase} release: ${String(e)}`,{cause:e}));}
    const failure=combinedFailure(scenarioFailure,teardown);
    if(failure){evidence.ok=false;evidence.failures=[...(scenarioFailure?[{phase:'scenario',identity:evidence.failure}]:[]),...teardown.map(e=>({phase:'teardown',identity:String(e.stack??e)}))];}
    save(`${scenario}/evidence.json`,evidence);
    if(failure)throw failure;
  }
}
save(preflightOnly?'identity-preflight-result.json':'result.json',{pin,scope,ok:results.length===(preflightOnly?1:3),preflightOnly,results});
console.log(JSON.stringify({out,pin,ok:true,results}));
