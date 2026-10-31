// Dev-only regression assertions. Source-backed vc-note fixture schema, not a product allowlist.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {join} from 'node:path';
const sdk=process.env.VC_TEST_PI_DIR??join(homedir(),'.local/state/vault-chat-server/pi/1.1.0');
const {buildSessionContext}=await import(pathToFileURL(sdk+'/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js').href);
/** @typedef {{type:'session', id:string, version:number, timestamp:string, cwd:string}} NativeHeader */
/** @typedef {{header:NativeHeader, knownSessionId:string, entries:Array<{type:string,id:string}>}} SessionInput */
// Owned fixture file only. Keep the real header SEPARATE from readEntries' headerless
// append-order entries; never reconstruct identity from public conversation metadata.
export function readNativeHeader(file, knownSessionId) {
  const lines=readFileSync(file,'utf8').split('\n').filter(line=>line.trim());
  const header=JSON.parse(lines[0]);
  assert.equal(lines.slice(1).filter(line=>JSON.parse(line).type==='session').length,0,'one native header at the first line only');
  validateSession({header,knownSessionId,entries:[]});
  return header;
}
/** @param {SessionInput} input */
export function validateSession({header,knownSessionId,entries}) {
  assert.ok(header&&typeof header==='object','actual native header required separately');
  assert.equal(header.type,'session','actual first record is a native session header');
  assert.equal(typeof header.id,'string');assert.match(header.id,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(typeof knownSessionId,'string');assert.equal(header.id,knownSessionId,'native header matches independent fixture seed SID');
  assert.equal(header.version,3);assert.ok(Number.isFinite(Date.parse(header.timestamp)));assert.equal(typeof header.cwd,'string');assert.ok(header.cwd.length);
  assert.ok(Array.isArray(entries));assert.ok(entries.every(e=>e.type!=='session'),'readEntries contract is HEADERLESS; never insert a header');
  assert.ok(entries.every(e=>e.id!==header.id),'entry ID cannot collide with native session header ID');
  return header.id;
}
export const STOP_NOTE=Object.freeze({kind:'notice',text:'Stopped.',level:'info'});
export const modelTextBlocks=calls=>calls.flatMap(b=>(b.messages??[]).flatMap(m=>typeof m.content==='string'?[m.content]:(m.content??[]).filter(p=>p.type==='text').map(p=>p.text)));
const responses=(trace,id)=>trace.filter(x=>x.direction==='output'&&x.record.type==='response'&&x.record.id===id);
export function receipt(trace,input,disposition) {
  const rs=responses(trace,input.record.id);assert.equal(rs.length,1,'one correlated terminal receipt');
  assert.deepEqual(rs[0].record,{id:input.record.id,type:'response',command:input.record.type,success:true,...(disposition?{data:{disposition}}:{})},'exact native receipt');
  assert.ok(trace.indexOf(rs[0])>trace.indexOf(input),'terminal receipt follows its native command');
  return trace.indexOf(rs[0]);
}
export function separateSubmissions(trace,genuine,nativeText) {
  const submitted=trace.filter(x=>x.direction==='input'&&['prompt','steer','follow_up'].includes(x.record.type));
  const expected=genuine.map(nativeText), metadata=[], users=[];
  for(const x of submitted) {
    // Exact owned envelope first: genuine metadata-looking words are NEVER stripped or reclassified.
    if(expected.includes(x.record.message))users.push(x);
    else {assert.equal(x.record.type,'prompt','metadata is a prompt command');assert.ok(x.record.message.startsWith('/vc-note '),'unexpected native submission');metadata.push(x);}
  }
  assert.deepEqual(users.map(x=>x.record.message).sort(),expected.slice().sort(),'exactly one native submission per genuine input');
  return {metadata,users};
}
/** @param {SessionInput & {scenario:string,trace:Array<any>,before:any,after:any,calls:Array<any>,feed:Array<any>,genuine:Array<string>,nativeText:Function,hidden:string,expectedContext:string}} input */
export function auditMetadata({scenario,trace,entries,header,knownSessionId,before,after,calls,feed,genuine,nativeText,hidden,expectedContext}) {
  const {metadata,users}=separateSubmissions(trace,genuine,nativeText);
  const sid=validateSession({header,knownSessionId,entries});
  for(const c of [before,after])assert.equal(c.meta?.threadId,sid,'same native session before and after recovery/reload');
  const persistedUsers=entries.filter(e=>e.message?.role==='user');assert.equal(persistedUsers.length,genuine.length+1,'only seed and genuine native user inputs');
  for(const t of genuine)assert.equal(persistedUsers.filter(e=>JSON.stringify(e.message.content)===JSON.stringify([{type:'text',text:nativeText(t)}])).length,1,'each genuine envelope persisted exactly once');
  assert.equal(typeof expectedContext,'string');assert.ok(expectedContext.includes(hidden));
  const context=[],notices=[];
  for(const x of metadata) {
    const note=JSON.parse(x.record.message.slice('/vc-note '.length));
    if(note.kind==='context'){assert.deepEqual(note,{kind:'context',text:expectedContext},'exact fixture context schema/content');context.push(x);}
    else {assert.deepEqual(note,STOP_NOTE,'only measured Stop notice schema/text/level; unknown metadata fails');notices.push(x);}
    receipt(trace,x,'handled');
  }
  // Successful compaction, NOT Abort, invalidates Engine.sectionsSent. This fixture
  // crosses that boundary before recovery only in stop-after. No same-phase repeats.
  const expectedDeliveries=scenario==='stop-after-accept'?2:1;
  assert.equal(context.length,expectedDeliveries,'exact context deliveries per native compaction/turn phase');
  assert.ok(context.every(x=>x.record.message===context[0].record.message),'unchanged payload bytes, not merely matching canary');
  const firstUser=users.find(x=>x.record.message===nativeText(genuine[0]));
  assert.ok(trace.indexOf(context[0])<receipt(trace,context[0],'handled')&&receipt(trace,context[0],'handled')<trace.indexOf(firstUser),'initial context handled before original genuine input');
  if(scenario==='stop-after-accept') {
    const recovered=users.find(x=>x.record.message===nativeText(genuine[1]));
    const accepted=receipt(trace,firstUser,'started');
    const compact=trace.flatMap((x,i)=>x.direction==='output'&&x.record.type==='compaction_end'&&x.record.result?[i]:[]).filter(i=>i<accepted);
    assert.equal(compact.length,1,'one successful pre-original compaction invalidates host cache');
    assert.ok(trace.indexOf(context[0])<compact[0]&&compact[0]<accepted);
    const canceled=trace.findIndex(x=>x.direction==='output'&&x.record.type==='agent_settled'&&x.record.aborted===true);
    assert.ok(accepted<canceled&&canceled<trace.indexOf(context[1]),'redelivery only after stopped original settles');
    assert.ok(trace.indexOf(context[1])<receipt(trace,context[1],'handled')&&receipt(trace,context[1],'handled')<trace.indexOf(recovered),'recovery context handled before recovery genuine input');
  } else if(scenario==='stop-before-accept') {
    const recovery=users.find(x=>x.record.message===nativeText(genuine[1]));
    assert.equal(trace.slice(0,trace.indexOf(recovery)).filter(x=>x.direction==='output'&&x.record.type==='compaction_end'&&x.record.result).length,0,'aborted preflight compaction does not invalidate the host cache');
  }
  const n=scenario==='late-accept-queue'?0:1;assert.equal(notices.length,n,'one notice per actual Stop, none otherwise');
  const ctx=entries.filter(e=>e.customType==='vc-context');assert.equal(ctx.length,expectedDeliveries);
  for(const [j,e] of ctx.entries()) {
    assert.equal(e.type,'custom_message');assert.equal(e.content,expectedContext);assert.equal(e.display,false);
    assert.deepEqual(Object.keys(e).sort(),['type','customType','content','display','id','parentId','timestamp'].sort(),'no unexpected context metadata');
    const begin=trace.indexOf(context[j]),end=receipt(trace,context[j],'handled');
    for(const type of ['message_start','message_end']) {
      const emitted=trace.slice(begin+1,end).filter(x=>x.direction==='output'&&x.record.type===type&&x.record.message?.customType==='vc-context');
      assert.equal(emitted.length,1,'one native typed context event before its handled receipt');
      const stamp=emitted[0].record.message.timestamp;
      assert.ok(stamp>=context[j].at&&stamp<=trace[end].at,'native message timestamp within delivery/handled window');
      assert.ok(Date.parse(e.timestamp)>=context[j].at&&Date.parse(e.timestamp)<=trace[end].at,'independently assigned journal timestamp within same window');
      assert.deepEqual(emitted[0].record.message,{role:'custom',customType:'vc-context',content:e.content,display:false,timestamp:stamp});
    }
  }
  const nativeProjections=entries.filter(e=>e.type==='compaction'||e.customType==='vc-context').map(e=>{
    const prefix=entries.slice(0,entries.indexOf(e)+1);
    const messages=buildSessionContext(prefix,e.id).messages;
    return {entryId:e.id,type:e.type,contextIds:messages.filter(m=>m.role==='custom'&&m.customType==='vc-context').map(m=>ctx.find(c=>Date.parse(c.timestamp)===m.timestamp)?.id),canaryCount:JSON.stringify(messages).split(hidden).length-1};
  });
  if(scenario==='stop-after-accept') {
    assert.deepEqual(nativeProjections.map(p=>p.canaryCount),[1,1,2,1],'native append is NOT replacement: transient two before recovery compaction, one afterward');
    const compact=entries.filter(e=>e.type==='compaction');assert.equal(compact.length,2);
    const matching=trace.filter(x=>x.direction==='output'&&x.record.type==='compaction_end'&&x.record.result);
    assert.deepEqual(matching.map(x=>x.record.result.firstKeptEntryId),compact.map(e=>e.firstKeptEntryId),'native successful receipts match persisted compaction cut points');
    const final=buildSessionContext(entries,entries.at(-1).id).messages.filter(m=>m.role==='custom'&&m.customType==='vc-context');
    assert.equal(final.length,1);assert.equal(final[0].timestamp,Date.parse(ctx[1].timestamp),'native compaction removes older context, retains the new delivery');
  }
  const journal=entries.filter(e=>e.customType==='vc-note');assert.equal(journal.length,n,'no unknown journal metadata');
  const blocks=modelTextBlocks(calls);
  assert.ok(blocks.includes(expectedContext),'whole typed context reaches actual model input');
  const counts=calls.map(b=>modelTextBlocks([b]).reduce((sum,s)=>sum+s.split(hidden).length-1,0));
  assert.ok(counts.every(k=>k<=1)&&counts.some(k=>k===1),'context canary once per request, not duplicated; compaction may summarize it away');
  assert.deepEqual(counts,scenario==='late-accept-queue'?[0,1]:scenario==='stop-before-accept'?[0,1,1,0]:[0,1,1,0,1],'exact measured context multiplicity in EVERY actual provider request, including compaction');
  const agentCalls=calls.filter(b=>!(typeof b.messages?.[0]?.content==='string'&&b.messages[0].content.startsWith('You are a context summarization assistant.')));
  const agentCounts=agentCalls.map(b=>modelTextBlocks([b]).join('\n').split(hidden).length-1);
  if(scenario==='stop-after-accept') {
    assert.deepEqual(agentCounts,[1,1],'both original and recovery ACTIVE MODEL inputs contain exactly one unchanged host context');
    for(const b of agentCalls)assert.equal(modelTextBlocks([b]).filter(s=>s===expectedContext).length,1,'whole unchanged typed context exactly once in each actual agent request');
  }
  for(const x of metadata)assert.ok(!blocks.includes(x.record.message),'metadata command itself is not a model input');
  for(const x of users)assert.ok(!JSON.stringify(x.record).includes(hidden),'no host context concatenated into genuine prompt');
  assert.ok(!JSON.stringify(entries.filter(e=>e.message?.role==='user')).includes(hidden),'hidden context is never a persisted user message');
  for(const c of [before,after])assert.ok(!JSON.stringify(c.messages).includes(hidden),'hidden context never displayed on replay');
  assert.ok(!JSON.stringify(feed).includes(hidden),'hidden context excluded from public feed');
  for(const e of journal) {
    assert.equal(e.type,'custom');assert.deepEqual(e.data,STOP_NOTE);assert.match(e.id,/^(?:[0-9a-f]{8}|[0-9a-f-]{36})$/);
    assert.ok(!('display' in e)&&!('content' in e),'notice is non-context CustomEntry, not a CustomMessage');
    const appended=trace.filter(x=>x.direction==='output'&&x.record.type==='entry_appended'&&x.record.entry?.id===e.id);assert.equal(appended.length,1);assert.deepEqual(appended[0].record.entry,e);
    const projected=feed.filter(x=>x.type==='entry'&&x.entry?.id===e.id);assert.equal(new Set(projected.map(x=>x.seq)).size,1);assert.ok(projected.every(x=>JSON.stringify(x.entry)===JSON.stringify(e)));
    for(const c of [before,after])assert.deepEqual(c.messages.filter(m=>m.mid===e.id),[{role:'assistant',system:true,content:'Stopped.',mid:e.id,items:[e.id]}],'notice renders once as public system line, same stable native id on reload');
    // Test content identity, not a substring ban that would reject genuine notice-looking user words.
    assert.ok(!blocks.includes(e.data.text),'display-only Stop notice not sent to model');
  }
  return {context:context.map(x=>x.record.id),notices:notices.map(x=>x.record.id),noticeEntryIds:journal.map(e=>e.id),modelCanaryCounts:counts,activeModelCanaryCounts:agentCounts,nativeProjections};
}
/** @param {SessionInput & {scenario:string,trace:Array<any>,genuine:Array<string>,nativeText:Function}} input */
export function auditLifecycle({scenario,trace,genuine,nativeText,entries,header,knownSessionId}) {
  const {users}=separateSubmissions(trace,genuine,nativeText);
  validateSession({header,knownSessionId,entries});
  const states=trace.filter(x=>x.direction==='output'&&x.record.type==='response'&&x.record.command==='get_state');assert.ok(states.length>0);
  for(const x of states)assert.equal(x.record.data.sessionId,header.id,'native get_state and persisted session retain same identity');
  const original=users.find(x=>x.record.message===nativeText(genuine[0]));assert.equal(original.record.type,'prompt');
  const accepted=receipt(trace,original,'started');
  const aborts=trace.flatMap((x,i)=>x.direction==='input'&&x.record.type==='abort'?[i]:[]);
  if(scenario==='late-accept-queue') {
    assert.equal(aborts.length,0);
    const queued=users.find(x=>x.record.message===nativeText(genuine[1]));assert.equal(queued.record.type,'steer');assert.ok(receipt(trace,queued,'queued')<accepted);
    assert.ok(entries.some(e=>e.type==='compaction'));
  } else {
    assert.ok(aborts.length>0);
    if(scenario==='stop-before-accept') {assert.ok(aborts[0]<accepted);assert.ok(aborts.some(i=>i>accepted),'re-abort at acceptance');assert.ok(trace.some(x=>x.direction==='output'&&x.record.type==='compaction_end'&&x.record.aborted===true));}
    else {assert.equal(scenario,'stop-after-accept');assert.ok(aborts[0]>accepted);}
    for(const i of aborts) {
      // Backend.interrupt always clears queues before abort; responses can interleave with prompt acceptance.
      const clear=trace.slice(0,i).findLast(x=>x.direction==='input'&&x.record.type==='clear_queue');assert.ok(clear);
      const cr=responses(trace,clear.record.id);assert.equal(cr.length,1);assert.deepEqual(cr[0].record,{id:clear.record.id,type:'response',command:'clear_queue',success:true,data:{steering:[],followUp:[]}});assert.ok(trace.indexOf(cr[0])<i);
      receipt(trace,trace[i]);
    }
    const recovery=users.find(x=>x.record.message===nativeText(genuine[1]));assert.equal(recovery.record.type,'prompt');
    const recovered=receipt(trace,recovery,'started');
    const stopped=trace.findIndex(x=>x.direction==='output'&&x.record.type==='agent_settled'&&x.record.aborted===true);assert.ok(stopped>accepted&&stopped<recovered);
    assert.ok(trace.slice(recovered+1).some(x=>x.direction==='output'&&x.record.type==='agent_settled'&&x.record.aborted===false),'same session recovery settles normally');
    assert.ok(aborts.every(i=>i<trace.indexOf(recovery)),'Stop does not cancel the recovery');
  }
  const pids=trace.filter(x=>x.direction==='provenance'&&x.record.type==='native_process').map(x=>x.record.childPid);assert.equal(new Set(pids).size,1);assert.equal(pids.length,1);
  assert.equal(new Set(trace.filter(x=>x.direction==='output'&&x.record.type==='agent_start').map(x=>x.pid)).size,1);
  return {acceptedIndex:accepted,abortIndices:aborts};
}
