// Actual production server -> genuine pi 1.1 -> loopback scripted model.
// No live roots, network models, devices or audio. Parent runs this via StartJob.
import {it,expect} from 'vitest';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {makeVault,startServer,tmp,waitFor,type Running} from './helpers';
import {fakeChat,chatText,lastUser} from './fakeChat';
import {previewGlobalConversations,applyGlobalConversations} from '../../scripts/global-conversations-offline';
it('cold cohort exposes both old Mains in GET Main and one continuing native owner with full peer context; project identity survives',async()=>{
 const root=tmp('vc-global-migration-native-'),master=join(root,'master');
 const home=makeVault(join(master,'vaults/owner')),peer=makeVault(join(master,'vaults/peer')),project=join(root,'external-project');
 mkdirSync(project);writeFileSync(join(project,'AGENTS.md'),'GLOBAL-MIGRATION-ORIGINAL-PROJECT-CWD');
 for(const name of ['owner','peer']){const bare=join(master,'.hub/vaults',name+'.git');mkdirSync(bare,{recursive:true});execFileSync('git',['init','--bare','-q',bare]);}
 const provider=await fakeAnthropic(),requestedTools=new Set<string>();
 provider.respond=(body)=>{
  const original=['PEER-ORIGINAL-MAIN','HOME-ORIGINAL-MAIN'].find(marker=>lastUser(body).includes(marker));
  if(original&&!requestedTools.has(original)) {
   requestedTools.add(original);return {call:{name:'bash',args:{command:`printf '${original}-TOOL-RESULT'`}}};
  }
  return {text:'Native original context retained.'};
 };
 const network=join(root,'local-only.mjs');
 writeFileSync(network,`const actual=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(u.href==='https://openrouter.ai/api/v1/models')return actual(${JSON.stringify(provider.url+'/models')},init);if(['127.0.0.1','localhost','[::1]'].includes(u.hostname))return actual(input,init);throw Error('External fetch refused');};`);
 const homeState=join(root,'owner-process'),peerState=join(root,'peer-process');
 let srv:Running|undefined;
 const boot=async(vault:string,processHome:string)=>{
  mkdirSync(processHome,{recursive:true});
  const running=await startServer({home:processHome,vault,secrets:join(processHome,'empty-no-credentials'),openrouter:provider.url,extra:{VC_MASTER:master,VC_VOICE_PIPELINE:'off',NODE_OPTIONS:'--import '+network}});
  return running;
 };
 const ask=async(id:string,text:string)=>{
  const r=await fetch(srv!.base+'/api/v2/intent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'send',convId:id,client:'laptop',clientId:text,text})});expect(r.ok).toBe(true);
  return waitFor(async()=>{const c=await(await fetch(srv!.base+`/conversation?id=${id}&full=1&n=200`)).json();const h=await(await fetch(srv!.base+'/api/v1/health')).json();return c.messages?.some((m:any)=>m.role==='user'&&m.content===text)&&h.engine.liveTurns.length===0&&h.engine.claude.sessions.every((p:any)=>!p.busy)?c:null;},20_000,20);
 };
 try{
  const peerText='PEER-ORIGINAL-MAIN 🧪 '+ '𐐀café'.repeat(20000);
  srv=await boot(peer,peerState);const peerMain=await ask('main',peerText),peerMainFile=peerMain.meta.threadPath,peerMainBytes=readFileSync(peerMainFile);
  const made=await(await fetch(srv.base+'/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({folder:project})})).json();expect(made.ok).toBe(true);
  const old=await ask(made.convId,'PROJECT-ORIGINAL-USER-CONTEXT'),oldFile=old.meta.threadPath,oldBytes=readFileSync(oldFile);
  const oldHeader=JSON.parse(oldBytes.toString('utf8').split('\n',1)[0]);expect(oldHeader?.id).toBe(old.meta.threadId);
  await srv.stop();srv=undefined;
  srv=await boot(home,homeState);const homeMain=await ask('main','HOME-ORIGINAL-MAIN'),homeMainFile=homeMain.meta.threadPath,homeMainBytes=readFileSync(homeMainFile);await srv.stop();srv=undefined;
  // Actual Pi, not handcrafted pointers: each original Main has a tool call
  // and result with distinct native entry IDs and the SAME logical call ID.
  for(const bytes of [homeMainBytes,peerMainBytes]) {
   const entries=bytes.toString('utf8').trim().split('\n').map(line=>JSON.parse(line));
   const request=entries.find(e=>e.message?.role==='assistant'&&e.message.content.some((b:any)=>b.type==='toolCall'));
   expect(request).toBeDefined();
   const call=request.message.content.find((b:any)=>b.type==='toolCall');
   const result=entries.find(e=>e.message?.role==='toolResult'&&e.message.toolCallId===call.id);
   expect(result).toBeDefined();expect(result.id).not.toBe(request.id);expect(result.message.toolName).toBe(call.name);
  }
  const backupsRoot=join(root,'backups');await mkdir(backupsRoot);
  const from={sessionsDir:join(peerState,'state/pi/sessions'),instrDir:join(peerState,'state/pi/instr')},to={sessionsDir:join(homeState,'state/pi/sessions'),instrDir:join(homeState,'state/pi/instr')};
  const p=await previewGlobalConversations({home,piDir:native,sources:[{root:peer,mainAlias:'legacy-peer-main',native:from}],targetNative:to,backupsRoot,idleMs:1},{assertStopped:async()=>{expect(srv).toBeUndefined();}});
  await applyGlobalConversations(p.intentPath,{assertStopped:async()=>{expect(srv).toBeUndefined();}});
  expect(readFileSync(peerMainFile).equals(peerMainBytes)).toBe(true);
  const intent=JSON.parse(readFileSync(p.intentPath,'utf8'));
  // Preview does not mutate native originals; apply retains the original home
  // native inode as well as fresh external backups before publishing routing.
  const applied=JSON.parse(readFileSync(join(intent.artifact,'apply.json'),'utf8'));
  const retained=applied.replacements.find((r:any)=>r.original.path===homeMainFile);
  expect(readFileSync(retained.parked).equals(homeMainBytes)).toBe(true);
  const importedNative=readFileSync(homeMainFile);expect(importedNative.subarray(0,homeMainBytes.length).equals(homeMainBytes)).toBe(true);
  const homeInstr=readFileSync(join(to.instrDir,homeMain.meta.threadId+'.json'));
  expect(applied.nativeCopies.some((c:any)=>c.source===peerMainFile)).toBe(false);
  srv=await boot(home,homeState);
  const merged=await(await fetch(srv.base+'/conversation?id=main&full=1&n=200')).json();
  const originals=[...homeMain.messages,...peerMain.messages].filter((m:any)=>m.role==='user'||m.role==='assistant');
  for(const m of originals)expect(merged.messages).toContainEqual(m);
  expect(merged.meta.threadId).toBe(homeMain.meta.threadId);expect(merged.meta.threadPath).toBe(homeMainFile);
  expect(merged.meta.threadId).not.toBe(peerMain.meta.threadId);
  const mainAfter=await ask('main','MAIN-AFTER-GLOBAL-CUTOVER');
  expect(mainAfter.meta.threadId).toBe(homeMain.meta.threadId);expect(mainAfter.meta.threadPath).toBe(homeMainFile);
  const modelRequest=chatText(provider.calls.at(-1));
  expect(modelRequest).toContain('HOME-ORIGINAL-MAIN');expect(modelRequest).toContain(peerText);
  // Decode labelled native JSON from the ACTUAL provider request. Preserve all
  // original IDs/bodies, including JSON-escaped device-prefix newlines.
  const marker='Full original JSON follows:\n';
  const capturedNative=provider.calls.at(-1).messages.flatMap((m:any)=>typeof m.content==='string'?[m.content]:(m.content??[]).map((c:any)=>c.text)).filter((text:any)=>typeof text==='string'&&text.includes(marker)).map((text:string)=>JSON.parse(text.slice(text.indexOf(marker)+marker.length)));
  for(const line of peerMainBytes.toString('utf8').trim().split('\n'))expect(capturedNative).toContainEqual(JSON.parse(line));
  expect(modelRequest).toContain('Native original context retained.');
  expect(modelRequest).not.toContain('<earlier_conversation>');
  expect(provider.calls.at(-1).model).toBe('test/fake-model');
  expect(readFileSync(join(to.instrDir,homeMain.meta.threadId+'.json')).equals(homeInstr)).toBe(true);
  const callCount=provider.calls.length;
  const stale=await(await fetch(srv.base+'/api/v2/intent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'send',convId:'legacy-peer-main',client:'phone',clientId:'stale-main-link',text:'MUST-NOT-CONTINUE-PEER'})})).json();
  expect(stale.error).toMatch(/not found/);expect(provider.calls.length).toBe(callCount);
  const resumed=await ask(made.convId,'PROJECT-AFTER-GLOBAL-CUTOVER');
  expect(resumed.meta.threadId).toBe(old.meta.threadId);expect(resumed.meta.threadPath).not.toBe(oldFile);
  const after=readFileSync(resumed.meta.threadPath);expect(after.subarray(0,oldBytes.length).equals(oldBytes)).toBe(true);expect(readFileSync(oldFile).equals(oldBytes)).toBe(true);
  expect(chatText(provider.calls.at(-1))).toContain('PROJECT-ORIGINAL-USER-CONTEXT');expect(chatText(provider.calls.at(-1))).toContain('GLOBAL-MIGRATION-ORIGINAL-PROJECT-CWD');
  expect(chatText(provider.calls.at(-1))).not.toContain('<earlier_conversation>');
  const rows=await(await fetch(srv.base+'/api/v2/conversations')).json();expect(rows.rows.filter((r:any)=>r.id==='main')).toHaveLength(1);expect(rows.rows.filter((r:any)=>r.id===made.convId)).toHaveLength(1);expect(rows.rows.some((r:any)=>r.id==='legacy-peer-main')).toBe(false);
  expect(readFileSync(peerMainFile).equals(peerMainBytes)).toBe(true);
  expect(readFileSync(retained.parked).equals(homeMainBytes)).toBe(true);
 }finally{if(srv){writeFileSync(join(root,'server-final.log'),srv.logs());await srv.stop();}writeFileSync(join(root,'provider-calls.json'),JSON.stringify(provider.calls,null,2));await provider.close();}
},180_000);
