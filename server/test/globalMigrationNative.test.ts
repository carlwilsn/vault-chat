// Actual production server -> genuine pi 1.1 -> loopback scripted model.
// No live roots, network models, devices or audio. Parent runs this via StartJob.
import {it,expect} from 'vitest';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {makeVault,startServer,tmp,waitFor,type Running} from './helpers';
import {fakeChat,chatText} from './fakeChat';
import {previewGlobalConversations,applyGlobalConversations} from '../../scripts/global-conversations-offline';
it('cold global cohort resumes original native project session and full model context, not a bounded transcript handover',async()=>{
 const root=tmp('vc-global-migration-native-'),master=join(root,'master');
 const home=makeVault(join(master,'vaults/owner')),peer=makeVault(join(master,'vaults/peer')),project=join(root,'external-project');
 mkdirSync(project);writeFileSync(join(project,'AGENTS.md'),'GLOBAL-MIGRATION-ORIGINAL-PROJECT-CWD');
 for(const name of ['owner','peer']){const bare=join(master,'.hub/vaults',name+'.git');mkdirSync(bare,{recursive:true});execFileSync('git',['init','--bare','-q',bare]);}
 const provider=await fakeChat();provider.respond=()=>({text:'Native original context retained.'});
 const network=join(root,'local-only.mjs');
 writeFileSync(network,`const actual=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(u.href==='https://openrouter.ai/api/v1/models')return actual(${JSON.stringify(provider.url+'/models')},init);if(['127.0.0.1','localhost','[::1]'].includes(u.hostname))return actual(input,init);throw Error('External fetch refused');};`);
 const native=process.env.VC_TEST_PI_DIR??join(homedir(),'.local/state/vault-chat-server/pi/1.1.0');
 const homeState=join(root,'owner-process'),peerState=join(root,'peer-process');
 let srv:Running|undefined;
 const boot=async(vault:string,processHome:string)=>{
  mkdirSync(processHome,{recursive:true});
  const running=await startServer({home:processHome,vault,secrets:join(processHome,'empty-no-credentials'),openrouter:provider.url,extra:{VC_MASTER:master,VC_PI_DIR:native,VC_ENGINE_MODEL:'test/fake-model',VC_PI_UNSAFE:'1',VC_VOICE_PIPELINE:'off',NODE_OPTIONS:'--import '+network}});
  const agent=join(processHome,'state/pi/agent');mkdirSync(agent,{recursive:true});
  writeFileSync(join(agent,'settings.json'),JSON.stringify({compaction:{enabled:false},retry:{enabled:false}}));
  writeFileSync(join(agent,'models.json'),JSON.stringify({providers:{openrouter:{baseUrl:provider.url,apiKey:'synthetic-local-only',api:'openai-completions',models:[{id:'test/fake-model',name:'local',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}]}}}));
  return running;
 };
 const ask=async(id:string,text:string)=>{
  const r=await fetch(srv!.base+'/api/v2/intent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'send',convId:id,client:'laptop',clientId:text,text})});expect(r.ok).toBe(true);
  return waitFor(async()=>{const c=await(await fetch(srv!.base+`/conversation?id=${id}&full=1&n=200`)).json();const h=await(await fetch(srv!.base+'/api/v1/health')).json();return c.messages?.some((m:any)=>m.role==='user'&&m.content===text)&&h.engine.liveTurns.length===0&&h.engine.pi.procs.every((p:any)=>!p.busy)?c:null;},20_000,20);
 };
 try{
  srv=await boot(peer,peerState);await ask('main','PEER-ORIGINAL-MAIN');
  const made=await(await fetch(srv.base+'/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({folder:project})})).json();expect(made.ok).toBe(true);
  const old=await ask(made.convId,'PROJECT-ORIGINAL-USER-CONTEXT'),oldFile=old.meta.threadPath,oldBytes=readFileSync(oldFile);
  const oldHeader=JSON.parse(oldBytes.toString('utf8').split('\n',1)[0]);expect(oldHeader?.id).toBe(old.meta.threadId);
  await srv.stop();srv=undefined;
  srv=await boot(home,homeState);await ask('main','HOME-ORIGINAL-MAIN');await srv.stop();srv=undefined;
  const backupsRoot=join(root,'backups');await mkdir(backupsRoot);
  const from={sessionsDir:join(peerState,'state/pi/sessions'),instrDir:join(peerState,'state/pi/instr')},to={sessionsDir:join(homeState,'state/pi/sessions'),instrDir:join(homeState,'state/pi/instr')};
  const p=await previewGlobalConversations({home,sources:[{root:peer,mainAlias:'legacy-peer-main',native:from}],targetNative:to,backupsRoot,idleMs:1},{assertStopped:async()=>{expect(srv).toBeUndefined();}});
  await applyGlobalConversations(p.intentPath,{assertStopped:async()=>{expect(srv).toBeUndefined();}});
  srv=await boot(home,homeState);
  const resumed=await ask(made.convId,'PROJECT-AFTER-GLOBAL-CUTOVER');
  expect(resumed.meta.threadId).toBe(old.meta.threadId);expect(resumed.meta.threadPath).not.toBe(oldFile);
  const after=readFileSync(resumed.meta.threadPath);expect(after.subarray(0,oldBytes.length).equals(oldBytes)).toBe(true);expect(readFileSync(oldFile).equals(oldBytes)).toBe(true);
  expect(chatText(provider.calls.at(-1))).toContain('PROJECT-ORIGINAL-USER-CONTEXT');expect(chatText(provider.calls.at(-1))).toContain('GLOBAL-MIGRATION-ORIGINAL-PROJECT-CWD');
  expect(chatText(provider.calls.at(-1))).not.toContain('<earlier_conversation>');
  const rows=await(await fetch(srv.base+'/api/v2/conversations')).json();expect(rows.rows.filter((r:any)=>r.id==='main')).toHaveLength(1);expect(rows.rows.filter((r:any)=>r.id===made.convId)).toHaveLength(1);expect(rows.rows.some((r:any)=>r.id==='legacy-peer-main')).toBe(true);
 }finally{if(srv){writeFileSync(join(root,'server-final.log'),srv.logs());await srv.stop();}writeFileSync(join(root,'provider-calls.json'),JSON.stringify(provider.calls,null,2));await provider.close();}
},180_000);
