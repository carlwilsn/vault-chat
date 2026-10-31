/** Private proof only: actual pinned pi + production Engine + local scripted provider; no model service. */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Engine } from '../../server/engine/engine';
import { PiBackend } from '../../server/engine/pi/backend';
import { piPaths } from '../../server/engine/pi/config';
import { readConv } from '../../server/engine/convs';
import { fakeChat, lastToolResult, lastUser } from '../../server/test/fakeChat';

export async function finishedNativeWorker(root: string, vault: string, convId: string) {
 const paths=piPaths(join(root,'native-worker'));
 for(const dir of [paths.agentDir,paths.extDir,paths.instrDir,paths.sessionsDir])mkdirSync(dir,{recursive:true});
 for(const name of ['vc.mjs','policy.mjs','filesystem.mjs','pdf.mjs'])copyFileSync(resolve('server/engine/pi/ext',name),join(paths.extDir,name));
 const provider=await fakeChat();
 writeFileSync(join(paths.agentDir,'models.json'),JSON.stringify({providers:{openrouter:{baseUrl:provider.url+'/v1',apiKey:'fixture-not-a-key',api:'openai-completions',models:[{id:'test/fake-model',name:'fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}]}}}));
 provider.respond=(body)=>{
  const first=body.messages.find((m:any)=>m.role==='user');
  const task=typeof first?.content==='string'?first.content:JSON.stringify(first?.content);
  if(task?.includes('Task:'))return {text:'Correct native child report for fixture-delegate'};
  if(lastUser(body).startsWith('Delegated work '))return {text:'Private synthetic worker completed'};
  return lastToolResult(body)===null ? {call:{name:'Delegate',args:{title:'Inspect synthetic native range',task:'Return the native child report marker only.'}}} : {text:'Private native Delegate started'};
 };
 const prefix=process.env.VC_TEST_PI_DIR!;
 const backend=new PiBackend({paths,install:{cli:join(prefix,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),node:process.execPath,version:'1.1.0',dir:prefix,installed:false},catalog:new Map(),sandbox:{outer:null,shell:null,denyRead:[],denyWrite:[]},apiKey:()=>null,thinking:'off',idleMs:60000,maxProcs:4,subagents:{agentsDirs:[],concurrency:2,maxTasks:4,hostMax:4,timeoutMs:10000,graceMs:1000,defaultModel:null},log:()=>{}});
 const procs:any[]=[]; const spawn=backend.spawn.bind(backend); backend.spawn=async(o)=>{const result=await spawn(o);procs.push(result.proc);return result;};
 const engine=new Engine({vault,backend,ledger:{settle:async()=>({calls:0,usd:0,missing:0,byId:{}}),has:()=>false} as any,jobEnv:{logDir:join(root,'worker-jobs'),wrap:null,env:{}},model:()=>'test/fake-model',webSearchModel:'test/fake-model',apiKey:()=>null,notify:async()=> 'fixture-no-push',broadcast:()=>{},log:()=>{}});
 engine.start();
 try{
  await engine.message({convId,text:'Inspect the synthetic source range using one Delegate.'});
  const deadline=Date.now()+12000;
  while(Date.now()<deadline){
   const parent=await readConv(vault,convId); const worker=parent?.subagents?.find((s:any)=>s.state==='completed'&&s.toolCallId);
   if(worker){
    const child=await readConv(vault,worker.threadId);
    assert.ok(child?.messages.some(m=>m.content==='Correct native child report for fixture-delegate'));
    const call=parent!.messages.flatMap(m=>m.toolCalls??[]).find(t=>t.id===worker.toolCallId);
    assert.equal(call?.name,'Delegate');
    assert.ok(call?.result?.includes(worker.threadId));
    assert.ok(provider.calls.length>=2);
    const evidence={child:worker.threadId,parent:convId,callId:worker.toolCallId,provider:'local-scripted-no-model',pi:'1.1.0',nativeSession:true};
    writeFileSync(join(root,'native-worker.json'),JSON.stringify(evidence,null,2));return evidence;
   }
   await new Promise(r=>setTimeout(r,20));
  }
  throw Error('Native Delegate did not expose its completed child and exact pi call id');
 }finally{engine.stop();for(const proc of procs)await proc.close();clearInterval((backend.side as any).timer);await (backend as any).mcp.close();await provider.close();}
}
