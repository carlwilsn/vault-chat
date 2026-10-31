import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {auditMetadata,auditLifecycle,separateSubmissions,STOP_NOTE,readNativeHeader} from './native-header-audit.mjs';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const retained=process.env.VC_STARTUP_EVIDENCE;
assert.ok(retained,'VC_STARTUP_EVIDENCE must name retained actual three-scenario evidence (no fixture fallback)');
const nativeText=t=>'[Carl, on his laptop]\n\n'+t;
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const checks=[];
const helper=readFileSync(join(root,'preview/tools/startup-context-ui-proof.ts'),'utf8');
const {transformSync}=await import(pathToFileURL(join(root,'node_modules/esbuild/lib/main.js')).href);
const finalBegin=helper.indexOf('    const modelUsers=provider.calls.flatMap('),finalEnd=helper.indexOf('    const outboundFetch=readFileSync(outbound',finalBegin);assert.ok(finalBegin>0&&finalEnd>finalBegin);
const finalTail=transformSync(helper.slice(finalBegin,finalEnd),{loader:'ts',format:'esm',target:'node22'}).code;
const replayFinal=new Function('assert','provider','genuine','nativeText','scenario','text','seed','after','original','evidence','native','entries','before','srv','rpc','fixtureDevice',finalTail+';return true;');
// Exercise the real caller's two boundaries, not raw JSONL masquerading as readEntries.
const {readEntries}=await import(pathToFileURL(join(root,'server/convlog/piSession.ts')).href);
const section=(start,end)=>{const a=helper.indexOf(start),b=helper.indexOf(end,a);assert.ok(a>=0&&b>a);return helper.slice(a,b);};
const readerSource=section('    const entries=readEntries(session);','    assert.ok(entries.some');
assert.ok(readerSource.includes('const header=readNativeHeader(session,sid);'));
const callerSource=section('    evidence.nativeInputs=rpc().filter',"    if(scenario!=='late-accept-queue') {\n      assert.equal(await page.getByText('Stopped.'");
assert.ok(callerSource.includes('entries,header,knownSessionId:sid,before,after'));
const postDOM=section('    assert.deepEqual(genuineSubmissions.map','    const modelUsers=');
const callerJS=transformSync(readerSource+callerSource+postDOM+'\nreturn protocol;',{loader:'ts',target:'node22'}).code;
const replayCaller=new Function('readEntries','readNativeHeader','session','sid','scenario','rpc','before','after','provider','evidence','genuine','nativeText','hidden','text','auditMetadata','auditLifecycle','assert',callerJS);
const fixtures=['late-accept-queue','stop-before-accept','stop-after-accept'].map(scenario=>({retained,scenario}));
if(process.env.VC_STARTUP_EXTRA_LATE_EVIDENCE)fixtures.push({retained:process.env.VC_STARTUP_EXTRA_LATE_EVIDENCE,scenario:'late-accept-queue'});
for(const {retained,scenario} of fixtures) {
 const dir=join(retained,scenario),e=load(join(dir,'evidence.json'));
 const session=join(dir,'home/state/pi/sessions',readdirSync(join(dir,'home/state/pi/sessions')).find(n=>n.endsWith('.jsonl')));
 const entries=readEntries(session),header=readNativeHeader(session,e.nativeSession.sid);
 assert.equal(session,e.nativeSession.path,'retained known fixture path, no guessed SID');
 assert.ok(!entries.some(e=>e.type==='session'));
 const trace=readFileSync(join(dir,'native-rpc.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const genuine=e.http.filter(x=>x.method==='POST'&&new URL(x.url).pathname==='/__realbox/api/v2/intent').map(x=>JSON.parse(x.input??'{}')).filter(x=>['send','steer'].includes(x.type)).map(x=>x.text);
 const hidden='Q1_HIDDEN_CONTEXT_CANARY_'+scenario;
 const before=load(join(dir,'conversation-before-reload.json')),after=load(join(dir,'conversation-after-reload.json')),calls=load(join(dir,'provider-calls.json'));
 const submitted=trace.filter(x=>x.direction==='input'&&['prompt','steer','follow_up'].includes(x.record.type));
 const replayEvidence=structuredClone(e);
 const a=replayCaller(readEntries,readNativeHeader,session,e.nativeSession.sid,scenario,()=>trace,before,after,{calls},replayEvidence,genuine,nativeText,hidden,genuine[0],auditMetadata,auditLifecycle,assert);
 assert.deepEqual(a.entries,entries);assert.deepEqual(a.header,header);
 assert.throws(()=>auditMetadata({...a,header:undefined}),undefined,'regression: headerless caller without separate actual header fails before any slow browser run');
 checks.push({scenario,retained,sourceExtractedFullCallerReaderAndProtocol:true,headerSeparate:true,knownSeedSID:e.nativeSession.sid,entries:entries.length,oldNormalizationMismatchRejected:true,DOMNotReplayed:true});
 const nativeLines=readFileSync(session,'utf8').trim().split('\n');
 const scratch=mkdtempSync(join(tmpdir(),'native-header-controls-'));
 try {
   const file=join(scratch,'owned.jsonl');
   for(const [name,lines] of [
     ['missing first header',nativeLines.slice(1)],
     ['wrong first header type',[JSON.stringify({...header,type:'message'}),...nativeLines.slice(1)]],
     ['wrong actual file header ID',[JSON.stringify({...header,id:'00000000-0000-0000-0000-000000000000'}),...nativeLines.slice(1)]],
     ['second identical native header',[...nativeLines,JSON.stringify(header)]],
     ['second different native header',[...nativeLines,JSON.stringify({...header,id:'00000000-0000-0000-0000-000000000000'})]],
     ['empty native file',[]],
   ]) {
     writeFileSync(file,lines.join('\n')+'\n');
     assert.throws(()=>readNativeHeader(file,e.nativeSession.sid),undefined,name);
     checks.push({nativeFileNegative:name,rejected:true});
   }
 } finally {rmSync(scratch,{recursive:true});}
 const run=o=>{auditMetadata(o);auditLifecycle(o);};run(a);checks.push({scenario,retainedReplay:true,metadata:auditMetadata(a),lifecycle:auditLifecycle(a)});
 // Execute the UNCHANGED real helper final-audit code (after schema audit), not a paraphrased assertion set.
 // It contains model multiplicity, retained seed/history, correlated acceptance, Stop ordering,
 // same-process recovery, error-log exclusions, exact HTTP intent/cardinality and compaction-feed assertions.
 const original=trace.filter(x=>x.direction==='input'&&x.record.type==='prompt'&&x.record.message===nativeText(genuine[0]));
 const native=(type,direction='output')=>trace.filter(x=>x.direction===direction&&x.record.type===type);
 assert.equal(replayFinal(assert,{calls:a.calls},genuine,nativeText,scenario,genuine[0],[entries.find(x=>x.message?.role==='user')],a.after,original,e,native,entries,a.before,{logs:()=>readFileSync(join(dir,'server.log'),'utf8')},()=>trace,'laptop'),true);
 const outbound=readFileSync(join(dir,'outbound-fetch.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);assert.deepEqual(outbound.filter(x=>x.kind==='refused'),[]);
 for(const key of ['pageErrors','consoleErrors','httpErrors','blocked','networkFailures'])assert.deepEqual(e[key],[]);
 assert.equal(e.http.filter(x=>new URL(x.url).pathname.includes('/release-health/')).length,0);
 checks.push({scenario,sourceExtractedRemainingFinalAuditReplay:true,errorArraysAndOutboundAndReleaseHealthHTTP:true,releaseHealthRequestAttemptsRecorded:Array.isArray(e.releaseHealthAttempts),noticeDOMBeforeReloadExecuted:scenario!=='late-accept-queue',noticeDOMAfterReloadExecuted:scenario==='stop-before-accept',noticeDOMAfterReloadRetrospectiveOnly:scenario==='stop-after-accept'});
 const reject=(name,mutate)=>{const b=structuredClone({...a,nativeText:undefined});b.nativeText=nativeText;mutate(b);assert.throws(()=>run(b),undefined,name);if(/header|fixture SID/.test(name)&&!name.startsWith('public API'))assert.throws(()=>auditLifecycle(b),undefined,'lifecycle independently rejects '+name);checks.push({negative:name,rejected:true});};
 reject('missing explicit native header',b=>delete b.header);
 reject('wrong native header type',b=>b.header.type='message');
 reject('native header missing ID',b=>delete b.header.id);
 reject('native header wrong ID',b=>b.header.id='00000000-0000-0000-0000-000000000000');
 reject('independent fixture SID mismatch',b=>b.knownSessionId='00000000-0000-0000-0000-000000000000');
 reject('independent fixture SID missing',b=>delete b.knownSessionId);
 reject('raw header cannot be laundered into entries',b=>b.entries.unshift(structuredClone(b.header)));
 reject('entry/header ID collision',b=>b.entries[0].id=b.header.id);
 reject('missing actual before API meta cannot fall back to threadId',b=>{b.before.threadId=b.knownSessionId;delete b.before.meta;});
 reject('missing actual after API meta cannot fall back to threadId',b=>{b.after.threadId=b.knownSessionId;delete b.after.meta;});
 reject('before API native session mismatch',b=>b.before.meta.threadId='wrong-session');
 reject('public API cannot supply missing native header',b=>{delete b.header;b.before.threadId=b.knownSessionId;b.after.threadId=b.knownSessionId;});
 reject('reloaded conversation session replaced',b=>b.after.meta.threadId='wrong-session');
 reject('native get_state session replaced',b=>b.trace.find(x=>x.record.command==='get_state').record.data.sessionId='wrong-session');
 reject('genuine native journal duplicated',b=>b.entries.push(structuredClone(b.entries.find(e=>e.message?.role==='user'))));
 reject('same-phase duplicate unchanged context command',b=>{const c=b.trace.find(x=>x.direction==='input'&&x.record.message?.startsWith('/vc-note {"kind":"context"'));b.trace.splice(b.trace.indexOf(c)+1,0,structuredClone(c));});
 reject('context handled receipt missing',b=>{const c=b.trace.find(x=>x.direction==='input'&&x.record.message?.startsWith('/vc-note {"kind":"context"'));b.trace=b.trace.filter(x=>!(x.direction==='output'&&x.record.id===c.record.id));});
 reject('context queued receipt is not handled',b=>{const c=b.trace.find(x=>x.direction==='input'&&x.record.message?.startsWith('/vc-note {"kind":"context"'));b.trace.find(x=>x.direction==='output'&&x.record.id===c.record.id).record.data.disposition='queued';});
 if(scenario==='stop-after-accept') {
   reject('Abort alone cannot justify redelivery',b=>b.trace.find(x=>x.record.type==='compaction_end'&&x.record.result).record.result=undefined);
   reject('recovery context before canceled settlement',b=>{const i=b.trace.findLastIndex(x=>x.direction==='input'&&x.record.message?.startsWith('/vc-note {"kind":"context"'));const [c]=b.trace.splice(i,1);b.trace.splice(b.trace.findIndex(x=>x.record.type==='agent_settled'),0,c);});
   reject('model canary alone is not whole context',b=>{const m=b.calls.at(-1).messages.find(x=>JSON.stringify(x).includes(hidden));m.content=hidden;});
   reject('both contexts in actual active model input',b=>{const m=b.calls.at(-1).messages;m.push(structuredClone(m.find(x=>JSON.stringify(x).includes(hidden))));});
   reject('recovery compaction retained both contexts',b=>b.entries.filter(e=>e.type==='compaction').at(-1).firstKeptEntryId=b.entries.find(e=>e.customType==='vc-context').id);
 }

 reject('missing actual provider request',b=>b.calls.shift());
 reject('extra context-free actual provider request',b=>b.calls.push({messages:[{role:'user',content:'extra request'}]}));
 reject('duplicate context canary in model',b=>b.calls.push({messages:[{role:'user',content:hidden+hidden}]}));
 reject('context display flag leak',b=>b.entries.find(x=>x.customType==='vc-context').display=true);
 reject('unexpected context command metadata',b=>{const x=b.trace.find(x=>x.direction==='input'&&x.record.message?.startsWith('/vc-note '));x.record.message='/vc-note '+JSON.stringify({kind:'context',text:b.expectedContext,display:false});});
 reject('context changed to display-only custom',b=>b.entries.find(x=>x.customType==='vc-context').type='custom');
 reject('hidden context replay bubble',b=>b.after.messages.push({role:'user',content:hidden}));
 reject('hidden context public feed leak',b=>b.feed.push({type:'entry',entry:{content:hidden}}));
 reject('extra native genuine submission',b=>b.trace.push(structuredClone(b.trace.find(x=>x.direction==='input'&&x.record.message===nativeText(genuine[0])))));
 reject('wrong genuine envelope not normalized away',b=>b.trace.find(x=>x.direction==='input'&&x.record.message===nativeText(genuine[0])).record.message='[Carl, on his phone]\n\n'+genuine[0]);
 if(scenario!=='late-accept-queue') {
  const notice=b=>b.trace.find(x=>x.direction==='input'&&x.record.type==='prompt'&&x.record.message=== '/vc-note '+JSON.stringify(STOP_NOTE));
  reject('unknown notice text',b=>notice(b).record.message='/vc-note '+JSON.stringify({...STOP_NOTE,text:'Anything else.'}));
  reject('unexpected notice key',b=>notice(b).record.message='/vc-note '+JSON.stringify({...STOP_NOTE,display:false}));
  reject('extra notice cardinality',b=>b.trace.push(structuredClone(notice(b))));
  reject('missing handled receipt',b=>{const id=notice(b).record.id;b.trace=b.trace.filter(x=>!(x.direction==='output'&&x.record.id===id));});
  reject('started instead of handled',b=>{const id=notice(b).record.id;b.trace.find(x=>x.direction==='output'&&x.record.id===id).record.data.disposition='started';});
  reject('notice sent to model',b=>b.calls.push({messages:[{role:'user',content:'Stopped.'}]}));
  reject('notice wrongly persisted as context',b=>b.entries.find(x=>x.customType==='vc-note').type='custom_message');
  reject('notice replay id mismatch',b=>b.after.messages.find(x=>x.content==='Stopped.').mid='wrong-id');
  reject('no native canceled settle',b=>b.trace.find(x=>x.record.type==='agent_settled'&&x.record.aborted).record.aborted=false);
  reject('no acceptance-boundary reabort',b=>{const x=b.trace.findLast(x=>x.direction==='input'&&x.record.type==='abort');b.trace=b.trace.filter(y=>y!==x);});
  reject('duplicate original acceptance receipt',b=>{const p=b.trace.find(x=>x.direction==='input'&&x.record.message===nativeText(genuine[0]));b.trace.push(structuredClone(b.trace.find(x=>x.direction==='output'&&x.record.id===p.record.id)));});
  reject('no recovery normal settle',b=>b.trace.findLast(x=>x.record.type==='agent_settled').record.aborted=true);
  reject('recovery unhandled',b=>{const x=b.trace.find(x=>x.direction==='input'&&x.record.message===nativeText(genuine[1]));b.trace.find(y=>y.direction==='output'&&y.record.id===x.record.id).record.data.disposition='handled';});
  if(scenario==='stop-before-accept') {
  // Retain prior source-backed protocol permutation and its rejection control.
  const later=structuredClone({...a,nativeText:undefined});later.nativeText=nativeText;later.scenario='stop-after-accept';
  const early=later.trace.find(x=>x.direction==='input'&&x.record.type==='abort');
  const earlyClear=later.trace.find(x=>x.direction==='input'&&x.record.type==='clear_queue');
  const ids=[early.record.id,earlyClear.record.id];later.trace=later.trace.filter(x=>!ids.includes(x.record.id));
  auditLifecycle(later);
  const wrongAfter=structuredClone({...later,nativeText:undefined});wrongAfter.nativeText=nativeText;
  const stop=wrongAfter.trace.findIndex(x=>x.direction==='input'&&x.record.type==='abort');const [ar]=wrongAfter.trace.splice(stop,1);const accepted=wrongAfter.trace.findIndex(x=>x.direction==='output'&&x.record.data?.disposition==='started');wrongAfter.trace.splice(accepted,0,ar);assert.throws(()=>auditLifecycle(wrongAfter),undefined,'stop-after rejects abort-before-accept');
  checks.push({syntheticStopAfterProtocolPermutation:true,notNativeUIProof:true,earlyAbortRejected:true});
  }
 }
}
// Test the actual handler body WITHOUT initializing the extension (no fd3/fd4 or credential access).
const vc=readFileSync(join(root,'server/engine/pi/ext/vc.mjs'),'utf8');
const start=vc.indexOf('  pi.registerCommand("vc-note", {'),end=vc.indexOf('\n  });',start)+6;
assert.ok(start>=0&&end>start);
let handler;const sent=[],appended=[];
new Function('pi','json','CLEAR_TYPE','VOICE_TYPE','voiceLineContent',vc.slice(start,end))({registerCommand:(name,opts)=>{assert.equal(name,'vc-note');handler=opts.handler;},sendMessage:(...args)=>sent.push(args),appendEntry:(...args)=>appended.push(args)},(s,d)=>{try{return JSON.parse(s)}catch{return d}},'vc-clear','vc-voice',()=>{throw Error('voice not part of fixture')});
await handler(JSON.stringify({kind:'context',text:'CANARY'}));await handler(JSON.stringify(STOP_NOTE));
assert.deepEqual(sent,[[{customType:'vc-context',content:'CANARY',display:false},{triggerTurn:false}]]);
assert.deepEqual(appended,[['vc-note',STOP_NOTE]]);
// Real shared reducer, overlapping replay included. No app/model state or browser mocked here.
const {fold,foldInto}=await import(pathToFileURL(join(root,'src/convlog/reduce.ts')).href);
const base={conv:'fixture',at:123,type:'entry',file:'/private/fixture'};
const records=[{...base,seq:1,entry:{type:'custom_message',customType:'vc-context',content:'CANARY',display:false,id:'11111111',parentId:null,timestamp:'2026-10-30T00:00:00.000Z'}},{...base,seq:2,entry:{type:'custom',customType:'vc-note',data:STOP_NOTE,id:'22222222',parentId:'11111111',timestamp:'2026-10-30T00:00:01.000Z'}}];
const picture=fold(records,'fixture');assert.deepEqual(picture.items.map(({id,kind,text,level})=>({id,kind,text,level})),[{id:'22222222',kind:'notice',text:'Stopped.',level:'info'}]);assert.equal(foldInto(picture,records).items.length,1);
for(const typed of ['/vc-note '+JSON.stringify(STOP_NOTE),'[Carl, on his phone]\n\n/vc-note {"kind":"context","text":"genuine"}','<memory>genuine words</memory>']) {
 const row={direction:'input',record:{type:'prompt',id:'genuine',message:nativeText(typed)}};
 const split=separateSubmissions([row],[typed],nativeText);assert.equal(split.metadata.length,0);assert.equal(split.users[0].record.message,nativeText(typed));
 const p=fold([{...base,seq:1,entry:{type:'message',id:'33333333',parentId:null,timestamp:'2026-10-30T00:00:00.000Z',message:{role:'user',content:[{type:'text',text:nativeText(typed)}],timestamp:123}}}],'fixture');assert.equal(p.items[0].kind,'user');assert.equal(p.items[0].text,nativeText(typed));
}
// Native readonly SDK session projection/conversion, entirely in memory; no runtime/model/credentials initialized.
const sdk=join(process.env.VC_TEST_PI_DIR??join(homedir(),'.local/state/vault-chat-server/pi/1.1.0'),'node_modules/@earendil-works/pi-coding-agent');
const {SessionManager,buildSessionContext}=await import(pathToFileURL(join(sdk,'dist/core/session-manager.js')).href);
const {convertToLlm}=await import(pathToFileURL(join(sdk,'dist/core/messages.js')).href);
const sm=SessionManager.inMemory(root);sm.appendCustomMessageEntry('vc-context','CANARY',false);sm.appendCustomEntry('vc-note',STOP_NOTE);
const typed='/vc-note '+JSON.stringify(STOP_NOTE),envelope=nativeText(typed);
sm.appendMessage({role:'user',content:[{type:'text',text:envelope}],timestamp:123});
for(let n=0;n<2;n++) {
 const ctx=buildSessionContext(sm.getEntries(),sm.getLeafId());assert.equal(ctx.messages.filter(m=>m.role==='custom'&&m.customType==='vc-context'&&m.display===false).length,1);
 const converted=convertToLlm(ctx.messages);assert.deepEqual(converted.map(m=>m.content),[[{type:'text',text:'CANARY'}],[{type:'text',text:envelope}]]);
}
checks.push({nativeInMemorySDKProjectionAndModelConversion:true,contextOnce:true,noticeNotInModel:true,genuineMetadataLookalikeUnchanged:true,modelCalls:0});
// Source contract anchors audited before another long native run. Not a substitute for native proof.
const engine=readFileSync(join(root,'server/engine/engine.ts'),'utf8'),backend=readFileSync(join(root,'server/engine/pi/backend.ts'),'utf8');
assert.ok(engine.includes('else if (status === "interrupted" && !l.sendNow) await this.notice(l.convId, "Stopped.", "info");'));
assert.ok(engine.includes('if (live.stopped && !live.finished) await this.d.backend.interrupt(threadId, turnId);'));
assert.ok(backend.includes('await t.proc.request({ type: "clear_queue" }, 10_000);\n      await t.proc.request({ type: "abort" }, 30_000);'));
assert.ok(vc.includes('else if (d.kind === "context") pi.sendMessage({ customType: "vc-context", content: String(d.text ?? ""), display: false }, { triggerTurn: false });'));
checks.push({sourceStopNoticeAndReabortAndClearQueueAndTypedContextAnchors:true});

// Causal isolated-method fixture: execute unchanged Engine cache methods and actual
// readonly SDK sendCustomMessage/abort/projection. No AgentSession constructor,
// runtime, credentials, model, native child, browser or network is initialized.
const changed=engine.slice(engine.indexOf('  private changedSections('),engine.indexOf('  /** One current host policy'));
const onPi=engine.slice(engine.indexOf('  private onPi('),engine.indexOf('  private onThreadLost('));
assert.ok(changed.includes('sectionsSent')&&onPi.includes('if (ev.result) this.sectionsSent.delete(l.threadId);'));
const isolated=transformSync('class CacheMethods { '+changed+onPi+' }; return CacheMethods;', {loader:'ts',target:'node22'}).code;
const CacheMethods=new Function('turnSections',isolated)(()=>[{key:'memory',text:'CANARY'}]);
const cache=new CacheMethods();cache.sectionsSent=new Map();cache.taps=new Map();cache.folderOf=()=>null;
const turn={threadId:'one-native-session',convId:'main',rec:{pi(){}},feed:{onPi(){}}};
assert.equal(cache.changedSections(turn.threadId,{}),'CANARY');assert.equal(cache.changedSections(turn.threadId,{}),'');
const {AgentSession}=await import(pathToFileURL(join(sdk,'dist/core/agent-session.js')).href);
const ns=Object.create(AgentSession.prototype),nsEvents=[];let aborts=0;
ns.sessionManager=SessionManager.inMemory(root);ns._entryIdsByMessage=new WeakMap();ns._isAgentRunActive=false;
ns.agent={state:{messages:[]},abort:()=>{aborts++;}};ns._emit=e=>nsEvents.push(e);
let nativeHandler;
new Function('pi','json','CLEAR_TYPE','VOICE_TYPE','voiceLineContent',vc.slice(start,end))({registerCommand:(name,opts)=>{nativeHandler=opts.handler;},sendMessage:(...args)=>ns.sendCustomMessage(...args),appendEntry:(...args)=>ns.sessionManager.appendCustomEntry(...args)},JSON.parse,'vc-clear','vc-voice',()=>{throw Error('voice excluded')});
await nativeHandler(JSON.stringify({kind:'context',text:'CANARY'}));
assert.equal(ns.agent.state.messages.filter(m=>m.customType==='vc-context').length,1);
const beforeAbort=structuredClone(ns.sessionManager.getEntries());await ns.abort();assert.equal(aborts,1);
assert.deepEqual(ns.sessionManager.getEntries(),beforeAbort,'native Abort does not replace/delete custom-message entries');
assert.equal(cache.changedSections(turn.threadId,{}),'','Abort alone never invalidates Engine.sectionsSent');
cache.onPi(turn,{type:'compaction_end',aborted:true});assert.equal(cache.changedSections(turn.threadId,{}),'','aborted compaction also leaves cache intact');
cache.onPi(turn,{type:'compaction_end',aborted:false,result:{summary:'fixture'}});
assert.equal(cache.changedSections(turn.threadId,{}),'CANARY','successful compaction alone causes unchanged context redelivery');
assert.equal(cache.changedSections(turn.threadId,{}),'','unnecessary repeat within same phase suppressed by existing production cache');
await nativeHandler(JSON.stringify({kind:'context',text:'CANARY'}));
assert.equal(ns.sessionManager.getEntries().filter(e=>e.customType==='vc-context').length,2);
assert.equal(ns.agent.state.messages.filter(m=>m.customType==='vc-context').length,2,'public sendMessage is APPEND, NOT same-type replacement');
assert.equal(JSON.stringify(convertToLlm(ns.agent.state.messages)).split('CANARY').length-1,2,'without another compaction this would really duplicate model input: fixture is not a dedup implementation');
const newer=ns.sessionManager.getEntries().filter(e=>e.customType==='vc-context').at(-1);
ns.sessionManager.appendCompaction('fixture summary omits canary',newer.id,1000);ns._refreshFinalizedContext();
assert.equal(ns.agent.state.messages.filter(m=>m.customType==='vc-context').length,1);
assert.equal(JSON.stringify(convertToLlm(ns.agent.state.messages)).split('CANARY').length-1,1,'native kept boundary, not Abort or replacement hook, selects new context');
checks.push({isolatedActualEngineMethodsAndNativeSDKAbortAndSendMessage:true,abortDoesNotInvalidate:true,successfulCompactionInvalidates:true,abortedCompactionDoesNotInvalidate:true,sendMessageAppendsNotReplaces:true,transientActiveProjectionCanHaveTwo:true,compactionRemovesOld:true,modelCalls:0});

const result={ok:true,negativeCount:checks.filter(x=>x.negative).length,nativeFileNegativeCount:checks.filter(x=>x.nativeFileNegative).length,checks,sourceRoot:root,sourceHashes:Object.fromEntries(['server/engine/pi/ext/vc.mjs','server/engine/pi/backend.ts','server/engine/engine.ts','server/engine/convs.ts','server/engine/piFeed.ts','server/convlog/piSession.ts','src/convlog/reduce.ts','src/convlog/view.ts','src/ChatPane.tsx'].map(p=>[p,sha(join(root,p))])),sdkHashes:Object.fromEntries(['dist/core/session-manager.js','dist/core/messages.js','dist/core/agent-session.js','dist/modes/rpc/rpc-mode.js'].map(p=>[p,sha(join(sdk,p))])),handlerBodyAndRealReducer:true,genuineLookalikePreserved:true,noNativeUIOrGatesRun:true};
if(process.env.VC_PROTOCOL_RESULT)writeFileSync(process.env.VC_PROTOCOL_RESULT,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
