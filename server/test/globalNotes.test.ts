// The genuine compiled server and its real runtime, on a local stand-in model.
// Only generated fixtures, no private workspace inspection or live note writes.
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmp, cleanup, makeVault, startServer, waitFor, type Running } from './helpers';
import { lastUser, lastToolResult } from './fakeChat';
import { configureContext, resetContextConfig } from '../context/config';
import { globalNotes, appendGlobalNote, writeGlobalNotes } from '../notesStorage';
import type { Note } from '../../src/notes';
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
const seed: Note = { id:'existing-fixture',timestamp:'2026-01-01T00:00:00Z',last_updated:'2026-01-01T00:00:00Z',status:'open',user_draft:'Existing original reminder',turns:[],anchors:[{source_path:'same.md',source_kind:'markdown',source_anchor:null,primary:true}] };

describe('global notes read-through safety (no migration)', () => {
 it('reads never write; routes edits once; stale snapshots and omission preserve concurrent notes and untouched bytes', () => {
  const home=tmp('global-note-storage-'), a=join(home,'a'), b=join(home,'b');
  for(const v of [a,b]) mkdirSync(join(v,'.vault-chat'),{recursive:true});
  const untouched=' { "id":"untouched", "timestamp":"2025", "last_updated":"2025", "status":"resolved", "user_draft":"Keep exactly", "turns":[], "anchors":[] }\n';
  writeFileSync(join(b,'.vault-chat/notes.jsonl'),untouched+JSON.stringify(seed)+'\n');
  configureContext({vault:a,conversationRoot:a,vaults:()=>[a,b]});
  try {
   const before=readFileSync(join(b,'.vault-chat/notes.jsonl'),'utf8');
   const stale=globalNotes(b);
   expect(globalNotes(a)).toEqual(stale);
   expect(readFileSync(join(b,'.vault-chat/notes.jsonl'),'utf8')).toBe(before);
   expect(existsSync(join(a,'.vault-chat/notes.jsonl'))).toBe(false);
   appendGlobalNote(b,{...seed,id:'new',user_draft:'Concurrent new',anchors:[]});
   writeGlobalNotes(a,[{...stale.find(n=>n.id===seed.id)!,user_draft:'Edited',last_updated:'2026-01-02'}]);
   writeGlobalNotes(b,stale);
   expect(globalNotes(a).find(n=>n.id===seed.id)?.user_draft).toBe('Edited');
   expect(globalNotes(b).find(n=>n.id==='new')?.user_draft).toBe('Concurrent new');
   const edited = globalNotes(a).find(n=>n.id===seed.id)!;
   writeGlobalNotes(b,[{...edited,status:'cleared',last_updated:'2026-01-03'}]);
   writeGlobalNotes(a,[{...edited,status:'open',last_updated:'2026-01-04'}]);
   expect(globalNotes(a).find(n=>n.id===seed.id)?.status).toBe('cleared');
   expect(readFileSync(join(b,'.vault-chat/notes.jsonl'),'utf8').startsWith(untouched)).toBe(true);
   expect(readFileSync(join(a,'.vault-chat/notes.jsonl'),'utf8')).not.toContain(seed.id);
  } finally { resetContextConfig(); cleanup(home); }
 });
});

describe('compiled Notes APIs and native tools across viewers and owner threads', () => {
 let home:string,a:string,b:string,c:string,srv:Running,provider:FakeApi;
 let step:{name:string,args:Record<string,unknown>}|null=null;
 let output=''; let serial=0;
 const post=async(path:string,body:unknown)=>{
  const r=await fetch(srv.base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json(); expect(r.status,JSON.stringify(d)).toBe(200); return d;
 };
 const list=async(viewer:string)=> (await (await fetch(srv.base+'/notes?full=1&vault='+viewer)).json()).notes as Note[];
 beforeAll(async()=>{
  home=tmp('global-note-native-'); a=makeVault(join(home,'vaults/home')); b=makeVault(join(home,'vaults/fixture-a')); c=makeVault(join(home,'vaults/fixture-b'));
  for(const v of [a,b,c]) { mkdirSync(join(v,'.vault-chat'),{recursive:true}); writeFileSync(join(v,'same.md'),v===b?'ORIGINAL SOURCE':'WRONG VIEWER SOURCE'); }
  writeFileSync(join(b,'.vault-chat/notes.jsonl'),JSON.stringify(seed)+'\n');
  provider=await fakeAnthropic();
  provider.respond=body=>{
   // 400, not 503: a refusal the runtime would retry for ever is a hang.
   const user=lastUser(body); if(!user.includes('OWNED-NOTES-')) return {status:400,body:'{"type":"error","error":{"type":"invalid_request_error","message":"Unowned inference refused"}}'};
   const result=lastToolResult(body);
   if(result!==null){ output=result; return {text:'Owned note step complete',noCost:true}; }
   return step?{call:step,noCost:true}:{text:'Owned note idle',noCost:true};
  };
  srv=await startServer({home,vault:a,secrets:join(home,'absent-secrets'),anthropic: provider.url,extra:{VC_VAULT_NAME:'home',VC_MASTER:home}});
  await post('/api/v1/vaults',{name:'fixture-a'}); await post('/api/v1/vaults',{name:'fixture-b'});
 });
 afterAll(async()=>{await srv?.stop();await provider?.close();if(home)cleanup(home);});
 const tool=async(viewer:string,convId:string,name:string,args:Record<string,unknown>={})=>{
  step={name,args}; output=''; const id='OWNED-NOTES-'+(++serial);
  await post('/api/v2/intent?vault='+viewer,{type:'send',convId,client:'laptop',clientId:id,text:id});
  await waitFor(()=>output||null,60000);
  await waitFor(async()=>{const d=await(await fetch(srv.base+'/conversation?id='+convId+'&vault='+viewer+'&full=1')).json();return d.meta?.state!=='running'&&d.messages?.some((m:any)=>m.role==='assistant'&&m.content==='Owned note step complete')?true:null;},60000);
  return output;
 };
 it('one existing id/text/status under both viewer scopes and different conversation owners, with correct original source',async()=>{
  const n=(await list('fixture-b')).find(n=>n.id===seed.id)!;
  expect(n).toMatchObject(seed); expect(n.origin_vault).toBe(b);
  expect((await list('home')).find(n=>n.id===seed.id)).toEqual(n);
  for(const viewer of ['home','fixture-a','fixture-b']) expect(await tool(viewer,'main','ListNotes')).toContain('['+seed.id+'] open');
  // A pre-existing project conversation in a different owner workspace is
  // created via the actual public project API, not a parallel owner registry.
  const folder=makeVault(join(home,'projects/owned-notes-project'));
  const p=await post('/projects?vault=fixture-a',{folder});
  expect(await tool('fixture-b',p.convId,'ListNotes')).toContain(seed.user_draft);
  const r=await fetch(srv.base+'/api/v1/vault/file?'+new URLSearchParams({vault:'fixture-b',path:join(n.origin_vault!,'same.md')}));
  expect(r.status).toBe(200);expect(Buffer.from((await r.json()).base64,'base64').toString()).toBe('ORIGINAL SOURCE');
 }, 300_000);
 it('startup and repeated global reads never backfill titles or compact original notes',async()=>{
  const p=join(b,'.vault-chat/notes.jsonl'), before=readFileSync(p,'utf8');
  await new Promise(r=>setTimeout(r,8500));
  await list('fixture-a');await list('fixture-b');
  expect(readFileSync(p,'utf8')).toBe(before);
 });
 it('Create/Update/Resolve/Reopen/Delete from alternate scopes mutate the same original id once',async()=>{
  const created=await tool('fixture-b','main','CreateNote',{text:'Created globally'});
  const id=/Saved note (\S+) /.exec(created)![1];
  expect((await list('fixture-a')).filter(n=>n.id===id)).toHaveLength(1);
  expect(await tool('fixture-a','main','UpdateNote',{id,text:'Updated globally'})).toContain('Updated note '+id);
  expect((await list('fixture-b')).find(n=>n.id===id)?.user_draft).toBe('Updated globally');
  for(const [name,status] of [['ResolveNote','resolved'],['ReopenNote','open'],['DeleteNote','cleared']]){
   expect(await tool('fixture-b','main',name,{id})).not.toMatch(/^Error/);
   for(const viewer of ['fixture-a','home'])expect((await list(viewer)).find(n=>n.id===id)?.status).toBe(status);
  }
  expect((await(await fetch(srv.base+'/notes?vault=fixture-b')).json()).notes.some((n:any)=>n.id===id)).toBe(false);
  expect(readFileSync(join(b,'.vault-chat/notes.jsonl'),'utf8')).toBe(JSON.stringify(seed)+'\n');
  expect(existsSync(join(c,'.vault-chat/notes.jsonl'))).toBe(false);
  expect(readFileSync(join(a,'.vault-chat/notes.jsonl'),'utf8').split('\n').filter(l=>l.includes(id))).toHaveLength(1);
 }, 300_000);
 it('source provenance never permits .git or an escaping symlink, even with an anchor',async()=>{
  writeFileSync(join(home,'outside.md'),'PRIVATE OUTSIDE FIXTURE');
  symlinkSync(join(home,'outside.md'),join(c,'escape.md'));
  // Seed a SECOND registered store, not a caller-supplied provenance field.
  const file=join(c,'.vault-chat/notes.jsonl');
  writeFileSync(file,JSON.stringify({...seed,id:'original-private-anchor-fixture',anchors:[
   {source_path:'.git/config',source_kind:'code',source_anchor:null,primary:true},
   {source_path:'escape.md',source_kind:'markdown',source_anchor:null,primary:false}
  ]})+'\n');
  for(const path of [join(c,'.git/config'),join(c,'escape.md'),join(home,'outside.md')]) {
   const r=await fetch(srv.base+'/api/v1/vault/file?'+new URLSearchParams({vault:'fixture-b',path}));
   expect(r.status).toBe(403);
  }
 });
 it('phone edit/status/create in any workspace uses the same notes, no relay main-only split',async()=>{
  await post('/notes/edit?vault=fixture-b',{id:seed.id,text:'Phone edit'});
  expect((await list('fixture-a')).find(n=>n.id===seed.id)?.user_draft).toBe('Phone edit');
  await post('/notes/status?vault=fixture-b',{id:seed.id,status:'resolved'});
  await post('/notes/status?vault=fixture-a',{id:seed.id,status:'open'});
  expect((await list('home')).find(n=>n.id===seed.id)?.status).toBe('open');
  await post('/notes?vault=fixture-b',{text:'Phone global note'});
  expect((await list('fixture-a')).some(n=>n.user_draft==='Phone global note')).toBe(true);
 });
});
