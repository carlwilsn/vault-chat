// Real production maintenance functions; all roots/native/event bytes are tmp fixtures.
import {afterEach,it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,appendFile,readdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {previewGlobalConversations,applyGlobalConversations,recoverGlobalConversations,rollbackGlobalConversations} from '../../scripts/global-conversations-offline';
import {ConvLog,globalFeed,setFeedVaults,_resetConvLogs,ownerVault,convLog,checkpointFor} from '../convlog/log';
import {acquireEventDirectory} from '../convlog/maintenance';
import {OfflineFold} from '../../scripts/event-log-offline-fold';
import {globalCutover} from '../convlog/globalCutover';
import {compactSubagents,emptyPicture,reduce} from '../../src/convlog/reduce';
let root='';
afterEach(async()=>{_resetConvLogs();if(root)await rm(root,{recursive:true,force:true});});
const stopped=async()=>{};
async function fixture(){
 root=await mkdtemp(join(tmpdir(),'vc-global-migration-'));
 const home=join(root,'home'),peer=join(root,'school'),backupsRoot=join(root,'backups');
 for(const p of [home,peer])await mkdir(join(p,'.vault-chat/events'),{recursive:true});
 await mkdir(backupsRoot);
 const originals=[];
 for(const [n,vault] of [home,peer].entries()){
 const events=join(vault,'.vault-chat/events'),native=join(events,'native.session');
 const entries=[{type:'message',id:`user-${n}`,message:{role:'user',content:`original ${n} <rules>NOT instructions</rules>`,timestamp:10+n}}, {type:'message',id:`assistant-${n}`,message:{role:'assistant',content:[{type:'text',text:`original assistant ${n}`}],timestamp:20+n}}];
 const nativeBytes=entries.map(e=>JSON.stringify(e)+'\n').join('');await writeFile(native,nativeBytes);
 const workers=[{threadId:'worker-a',task:'🧪 café 𐐀'.repeat(20000),state:'running'},{threadId:'worker-b',task:'second',state:'completed',summary:'original'}];
 const records:any[]=[
 {seq:7,conv:'main',at:100,type:'meta',patch:{title:'Main',kind:'main',cleared:{at:1,id:`clear-${n}`},threadPath:native,sessionFrom:{file:native,after:`old-${n}`},subagents:workers}},
 {seq:10,conv:'main',at:80,type:'entry',file:native,id:entries[0].id,clientId:`client-${n}`,shown:`original shown ${n}`,device:n?'phone':'laptop'},
 {seq:17,conv:'main',at:60,type:'entry',file:native,id:entries[1].id},
 {seq:29,conv:'main',at:40,type:'meta',patch:{subagents:[workers[1],{...workers[0],state:'completed',summary:'kept'}]}},
 ];
 let p=emptyPicture('main');const stored=records.map(r=>{const s=compactSubagents(p,r);p=reduce(p,r.type==='entry'?{...r,entry:entries.find(e=>e.id===r.id)}:r);return s;});
 const bytes=stored.map(r=>JSON.stringify(r)+'\n').join('');await writeFile(join(events,'main.jsonl'),bytes);
 const log=new ConvLog(vault);const expected=log.picture('main');log.checkpointNow('main');log.close();
 originals.push({vault,events,native,nativeBytes,bytes,expected});
 }
 return {home,peer,backupsRoot,originals,options:{home,sources:[{root:peer,mainAlias:'legacy-school-main'}],backupsRoot,idleMs:1}};
}
it('two Main PREVIEW → fresh verified backups → APPLY → cold canonical runtime → guarded rollback preserves original bytes, IDs, worker order and Clear domains',async()=>{
 const f=await fixture(),preview=await previewGlobalConversations(f.options,{assertStopped:stopped});
 expect(preview.installed).toBe(false);expect(globalCutover(f.home)).toBeNull();
 expect((await readdir(f.originals[0].events)).some(n=>n.startsWith('.global-'))).toBe(false);
 const installed=await applyGlobalConversations(preview.intentPath,{assertStopped:stopped});
 expect(globalCutover(f.home)?.legacyRoots).toEqual([f.peer]);
 const log=new ConvLog(f.home),main=log.picture('main')!;
 expect(main.items).toEqual([...f.originals[0].expected!.items,...f.originals[1].expected!.items]);
 expect(main.meta.cleared).toEqual({at:1,id:'clear-0'});
 expect(main.meta.sessionFrom).toEqual(f.originals[0].expected!.meta.sessionFrom);
 expect(main.meta.threadPath).toBe(f.originals[0].native);
 expect(log.picture('legacy-school-main')).toBeNull();log.close();
 setFeedVaults(f.home,()=>[f.home,f.peer]);
 expect(globalFeed(f.peer).rows().map(r=>r.id)).toEqual(['main']);_resetConvLogs();
 expect(await rollbackGlobalConversations(installed.intentPath,{assertStopped:stopped})).toEqual({rolledBack:true});
 expect(globalCutover(f.home)).toBeNull();
 for(const o of f.originals){expect(await readFile(join(o.events,'main.jsonl'),'utf8')).toBe(o.bytes);expect(await readFile(o.native,'utf8')).toBe(o.nativeBytes);}
});
it('source and native mutation after preview refuse apply before cutover',async()=>{
 const f=await fixture(),p=await previewGlobalConversations(f.options,{assertStopped:stopped});
 await appendFile(f.originals[1].native,'\n');
 await expect(applyGlobalConversations(p.intentPath,{assertStopped:stopped})).rejects.toThrow(/CAS-refused/);
 expect(globalCutover(f.home)).toBeNull();
});
it('kernel shared writer excludes preview and a source mutation excludes apply',async()=>{
 const f=await fixture(),release=acquireEventDirectory(f.originals[1].events,'shared');
 try{await expect(previewGlobalConversations(f.options,{assertStopped:stopped})).rejects.toThrow(/exclusive lock unavailable/);}finally{release();}
 const p=await previewGlobalConversations(f.options,{assertStopped:stopped});await appendFile(join(f.originals[1].events,'main.jsonl'),'\n');
 await expect(applyGlobalConversations(p.intentPath,{assertStopped:stopped})).rejects.toThrow(/CAS-refused/);
});
it('interrupted installation fails closed on cold runtime and verified forward recovery finishes whole cohort',async()=>{
 const f=await fixture(),p=await previewGlobalConversations(f.options,{assertStopped:stopped});let intent='';
 await expect(applyGlobalConversations(p.intentPath,{assertStopped:stopped,stage:async(stage,path)=>{if(stage==='member-installed'){intent=path;throw Error('power-loss');}}})).rejects.toThrow('power-loss');
 expect(globalCutover(f.home)).toBeNull();expect(()=>new ConvLog(f.home)).toThrow(/maintenance incomplete/);
 expect(await recoverGlobalConversations(intent,{assertStopped:stopped})).toEqual({installed:true});
 const log=new ConvLog(f.home);expect(log.picture('main')!.items).toEqual([...f.originals[0].expected!.items,...f.originals[1].expected!.items]);log.close();
});
it('post-cutover appended event refuses rollback without removing routing or history',async()=>{
 const f=await fixture(),p=await previewGlobalConversations(f.options,{assertStopped:stopped}),a=await applyGlobalConversations(p.intentPath,{assertStopped:stopped});
 const log=new ConvLog(f.home);log.emit('main',{type:'meta',patch:{title:'new user write'}});log.close();
 await expect(rollbackGlobalConversations(a.intentPath,{assertStopped:stopped})).rejects.toThrow(/CAS-refused/);
 expect(globalCutover(f.home)).not.toBeNull();
});
it('interrupted rollback resumes only recognized parked inodes',async()=>{
 const f=await fixture(),p=await previewGlobalConversations(f.options,{assertStopped:stopped}),a=await applyGlobalConversations(p.intentPath,{assertStopped:stopped});
 await expect(rollbackGlobalConversations(a.intentPath,{assertStopped:stopped,stage:async(stage)=>{if(stage==='rollback-member')throw Error('power-loss');}})).rejects.toThrow('power-loss');
 expect(()=>new ConvLog(f.home)).toThrow(/maintenance incomplete/);
 expect(await rollbackGlobalConversations(a.intentPath,{assertStopped:stopped})).toEqual({rolledBack:true});
});
it('preview refuses alias collision and symlinks rather than rewriting original identities',async()=>{
 const f=await fixture();
 f.options.sources[0].mainAlias='main';await expect(previewGlobalConversations(f.options,{assertStopped:stopped})).rejects.toThrow(/main-alias-required/);
 f.options.sources[0].mainAlias='legacy-school-main';await symlink(f.originals[1].native,join(f.originals[1].events,'redirect'));
 await expect(previewGlobalConversations(f.options,{assertStopped:stopped})).rejects.toThrow(/symlink/);
});
it('native runtime session/instructions relocate byte-for-byte without losing thread identity or original pointers on rollback',async()=>{
 const f=await fixture(),from={sessionsDir:join(root,'peer-state/sessions'),instrDir:join(root,'peer-state/instr')},to={sessionsDir:join(root,'owner-state/sessions'),instrDir:join(root,'owner-state/instr')};
 for(const dir of [from.sessionsDir,from.instrDir,to.sessionsDir,to.instrDir])await mkdir(dir,{recursive:true});
 const thread='original-native-thread',session=join(from.sessionsDir,`original_${thread}.jsonl`),instr=join(from.instrDir,'original.md');
 const bytes=JSON.stringify({type:'session',version:3,id:thread,cwd:f.peer,timestamp:new Date(0).toISOString()})+'\n'+f.originals[1].nativeBytes;
 await writeFile(session,bytes);await writeFile(instr,'Original model-only instructions.');
 await writeFile(join(from.instrDir,thread+'.json'),JSON.stringify({instr,tools:join(from.instrDir,'old-tools.json'),cwd:f.peer,subagents:true}));
 await writeFile(join(f.originals[1].events,'project-native.jsonl'),f.originals[1].bytes.replaceAll('\"conv\":\"main\"','\"conv\":\"project-native\"'));
 const log=new ConvLog(f.peer);log.emit('project-native',{type:'meta',patch:{threadId:thread,threadPath:session,sessionFrom:{file:session,after:'user-1'}}});log.checkpointNow('project-native');log.close();
 const options={...f.options,targetNative:to,sources:[{...f.options.sources[0],native:from}]};
 const p=await previewGlobalConversations(options,{assertStopped:stopped}),a=await applyGlobalConversations(p.intentPath,{assertStopped:stopped});
 const cold=new ConvLog(f.home),archived=cold.picture('project-native')!;cold.close();
 expect(archived.meta.threadId).toBe(thread);expect(archived.meta.threadPath).toBe(join(to.sessionsDir,`original_${thread}.jsonl`));
 expect(await readFile(String(archived.meta.threadPath),'utf8')).toBe(bytes);
 const meta=JSON.parse(await readFile(join(to.instrDir,thread+'.json'),'utf8'));expect(await readFile(meta.instr,'utf8')).toBe('Original model-only instructions.');
 expect(archived.meta.sessionFrom).toEqual({file:archived.meta.threadPath,after:'user-1'});
 await rollbackGlobalConversations(a.intentPath,{assertStopped:stopped});expect(await readFile(session,'utf8')).toBe(bytes);
});
it('actual competing process cannot take writer lock during cohort install; a hook-induced native race refuses routing',async()=>{
 const {spawnSync}=await import('node:child_process');
 const f=await fixture(),p=await previewGlobalConversations(f.options,{assertStopped:stopped});
 await expect(applyGlobalConversations(p.intentPath,{assertStopped:stopped,stage:async(stage)=>{
  if(stage!=='before-commit')return;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`import {ConvLog} from './server/convlog/log.ts';new ConvLog(${JSON.stringify(f.peer)});`],{cwd:process.cwd(),encoding:'utf8'});
  expect(child.status).not.toBe(0);expect(child.stderr).toContain('shared lock unavailable');
  await appendFile(f.originals[1].native,'\n');
 }})).rejects.toThrow(/CAS-refused/);
 expect(globalCutover(f.home)).toBeNull();expect(()=>new ConvLog(f.home)).toThrow(/maintenance incomplete/);
});
it('a stale v2 native/body checkpoint is never replaced by two equally partial folds',async()=>{
 const f=await fixture(),checkpoint=join(f.originals[1].events,'main.ckpt.json'),ck=JSON.parse(await readFile(checkpoint,'utf8'));
 ck.v=2;delete ck.position;ck.picture.items[1].text='body present only in old authoritative checkpoint';await writeFile(checkpoint,JSON.stringify(ck));
 const {prepareOffline}=await import('../../scripts/offline-event-log');
 await expect(prepareOffline({mode:'checkpoint-only',eventsDir:f.originals[1].events,source:join(f.originals[1].events,'main.jsonl'),backupsRoot:f.backupsRoot,idleMs:1},{assertStopped:stopped})).rejects.toThrow(/authoritative-checkpoint-fold-mismatch/);
 expect(await readFile(join(f.originals[1].events,'main.jsonl'),'utf8')).toBe(f.originals[1].bytes);
});
it('fresh registry creation after preview refuses apply',async()=>{
 const f=await fixture(),p=await previewGlobalConversations(f.options,{assertStopped:stopped});
 await mkdir(join(f.home,'.vault-chat/local'));await writeFile(join(f.home,'.vault-chat/local/project-folders.json'),'{}');
 await expect(applyGlobalConversations(p.intentPath,{assertStopped:stopped})).rejects.toThrow(/new-registry/);
});
it('recovery refuses a mutated prepared checkpoint instead of declaring the routing cutover complete',async()=>{
 const f=await fixture(),p=await previewGlobalConversations(f.options,{assertStopped:stopped});let intent='';
 await expect(applyGlobalConversations(p.intentPath,{assertStopped:stopped,stage:async(stage,path)=>{if(stage==='member-installed'){intent=path;throw Error('power-loss');}}})).rejects.toThrow('power-loss');
 await appendFile(join(f.originals[0].events,'main.ckpt.json'),' ');
 await expect(recoverGlobalConversations(intent,{assertStopped:stopped})).rejects.toThrow(/CAS-refused/);expect(globalCutover(f.home)).toBeNull();
});
it('actual original assistant item-ID collision refuses preview without rewriting either native entry',async()=>{
 const f=await fixture(),o=f.originals[1];
 const collision={type:'message',id:'different-native-entry',message:{role:'assistant',content:[{type:'text',text:'different original body same timestamp'}],timestamp:21}};
 await appendFile(o.native,JSON.stringify(collision)+'\n');
 await appendFile(join(o.events,'main.jsonl'),JSON.stringify({seq:35,conv:'main',at:30,type:'entry',file:o.native,id:collision.id})+'\n');
 const log=new ConvLog(f.peer);log.checkpointNow('main');log.close();
 const before=await readFile(o.native,'utf8');
 await expect(previewGlobalConversations(f.options,{assertStopped:stopped})).rejects.toThrow(/ambiguous-item-identity/);
 expect(await readFile(o.native,'utf8')).toBe(before);
});
it('same project conversation in two roots refuses instead of silently selecting one owner',async()=>{
 const f=await fixture();
 for(const o of f.originals)await writeFile(join(o.events,'project-physics.jsonl'),o.bytes.replaceAll('"conv":"main"','"conv":"project-physics"'));
 await expect(previewGlobalConversations(f.options,{assertStopped:stopped})).rejects.toThrow(/ambiguous-conversation-identity: project-physics/);
});
it('rollback rechecks a write racing its durable journal hook and never parks that written history',async()=>{
 const f=await fixture(),p=await previewGlobalConversations(f.options,{assertStopped:stopped}),a=await applyGlobalConversations(p.intentPath,{assertStopped:stopped});
 const file=join(f.originals[0].events,'main.jsonl');
 await expect(rollbackGlobalConversations(a.intentPath,{assertStopped:stopped,stage:async(stage)=>{if(stage==='rollback-started')await appendFile(file,'\n');}})).rejects.toThrow(/CAS-refused/);
 expect(globalCutover(f.home)).not.toBeNull();expect(await readFile(file,'utf8')).toMatch(/\n\n$/);
});
it('actual child SIGKILL before routing commit retains recoverable inodes and cold runtime fails closed',async()=>{
 const {spawnSync}=await import('node:child_process');
 const f=await fixture(),p=await previewGlobalConversations(f.options,{assertStopped:stopped}),descriptor=join(root,'killed-intent');
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`
 import {writeFileSync} from 'node:fs';
 import {applyGlobalConversations} from './scripts/global-conversations-offline.ts';
 await applyGlobalConversations(${JSON.stringify(p.intentPath)},{assertStopped:async()=>{},stage:async(stage,path)=>{if(stage==='before-commit'){writeFileSync(${JSON.stringify(descriptor)},path);process.kill(process.pid,'SIGKILL');}}});
 `],{cwd:process.cwd(),encoding:'utf8',timeout:10000});
 expect(child.signal,child.stderr).toBe('SIGKILL');expect(globalCutover(f.home)).toBeNull();expect(()=>new ConvLog(f.home)).toThrow(/maintenance incomplete/);
 const intent=await readFile(descriptor,'utf8');await recoverGlobalConversations(intent,{assertStopped:stopped});
 const cold=new ConvLog(f.home);expect(cold.picture('main')!.items).toEqual([...f.originals[0].expected!.items,...f.originals[1].expected!.items]);cold.close();
});
it('home is part of the authoritative checkpoint/idle/native CAS cohort, not just the destination',async()=>{
 const f=await fixture(),file=join(f.originals[0].events,'main.ckpt.json');
 const ck=JSON.parse(await readFile(file,'utf8'));ck.picture.meta.title='tampered home checkpoint';await writeFile(file,JSON.stringify(ck)+'\n');
 await expect(previewGlobalConversations(f.options,{assertStopped:stopped})).rejects.toThrow(/authoritative-checkpoint-fold-mismatch/);
});
it('home activity refuses preview instead of copying sources into a busy owner',async()=>{
 const f=await fixture(),home=new ConvLog(f.home);home.emit('main',{type:'meta',patch:{running:true}});home.checkpointNow('main');home.close();
 await expect(previewGlobalConversations(f.options,{assertStopped:stopped})).rejects.toThrow(/not-idle/);
});

it('normal unmigrated roots are not silently redirected by the cutover compatibility route',async()=>{
 const f=await fixture(),other=join(root,'not-a-cohort-member');await mkdir(join(other,'.vault-chat/events'),{recursive:true});
 setFeedVaults(f.home,()=>[f.home,f.peer]);expect(convLog(other).vault).toBe(other);_resetConvLogs();
 const p=await previewGlobalConversations(f.options,{assertStopped:stopped});await applyGlobalConversations(p.intentPath,{assertStopped:stopped});
 setFeedVaults(f.home,()=>[f.home,f.peer]);expect(convLog(f.peer).vault).toBe(f.home);expect(convLog(other).vault).toBe(other);
});

it('a monolithic pre-feed source refuses rather than disappearing behind global routing',async()=>{
 const f=await fixture();await writeFile(join(f.peer,'.vault-chat/conversations.jsonl'),'unreviewed older history\n');
 await expect(previewGlobalConversations(f.options,{assertStopped:stopped})).rejects.toThrow(/legacy-conversations-require-reviewed-import/);
});
it('an unreviewed pre-feed home history refuses rather than being hidden by a new destination alias',async()=>{
 const f=await fixture();const dir=join(f.home,'.vault-chat/conversations');await mkdir(dir);await writeFile(join(dir,'older.jsonl'),'unreviewed older history\n');
 await expect(previewGlobalConversations(f.options,{assertStopped:stopped})).rejects.toThrow(/legacy-conversations-require-reviewed-import/);
});

// Test setup only: build a synthetic authoritative checkpoint from the fixture
// bytes through the same canonical owner, before invoking maintenance.
async function fixtureCheckpoint(file:string,events:string) {
 const bytes=await readFile(file,'utf8'),fold=new OfflineFold(events,true);
 try {for(const line of bytes.trim().split('\n'))fold.add(JSON.parse(line));
 await writeFile(file.replace(/\.jsonl$/,'.ckpt.json'),JSON.stringify(checkpointFor(file,fold.verify(),Buffer.byteLength(bytes),fold.pointed))+'\n');}
 finally {fold.close();}
}
it('source Clear is local, hidden native pointers and exact source clocks survive; new global Clear is view-only',async()=>{
 const f=await fixture(),o=f.originals[1];
 const hidden={type:'message',id:'peer-before-clear',message:{role:'user',content:'HIDDEN ORIGINAL 🧪 '+ '𐐀café'.repeat(20000),timestamp:3}};
 await appendFile(o.native,JSON.stringify(hidden)+'\n');
 const file=join(o.events,'main.jsonl');
 const old=JSON.parse(o.bytes.split('\n')[0]);
 const hiddenRecord={seq:2,conv:'main',at:500,type:'entry',file:o.native,id:hidden.id,clientId:'hidden-client-id'};
 await writeFile(file,[{...old,seq:1,patch:{title:'Main',kind:'main'}},hiddenRecord,...o.bytes.trim().split('\n').map(JSON.parse)].map(r=>JSON.stringify(r)+'\n').join(''));
 await fixtureCheckpoint(file,o.events);
 const before=await readFile(o.native,'utf8'),sourceBefore=await readFile(file,'utf8');
 const p=await previewGlobalConversations(f.options,{assertStopped:stopped});await applyGlobalConversations(p.intentPath,{assertStopped:stopped});
 const log=new ConvLog(f.home),main=log.picture('main')!;
 expect(main.items.map(i=>i.id)).toEqual(['client-0','20:0','client-1','21:0']);
 expect(main.meta.cleared).toEqual({at:1,id:'clear-0'});
 expect(main.meta.sessionFrom).toEqual(f.originals[0].expected!.meta.sessionFrom);
 expect(log.pointedIn('main',o.native).has(hidden.id)).toBe(true);
 const provenance=(await readFile(join(f.originals[0].events,'main.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(r=>r.type==='history-import'&&r.sourceRecord);
 expect(provenance.map(r=>[r.origin.seq,r.origin.at])).toEqual([[1,100],[2,500],[7,100],[10,80],[17,60],[29,40]]);
 expect(provenance.find(r=>r.origin.seq===7).sourceRecord.patch.subagents.map((w:any)=>w.threadId)).toEqual(['worker-a','worker-b']);
 expect(provenance.find(r=>r.origin.seq===7).sourceRecord.patch.subagents[0].task.length).toBeGreaterThan(65536);
 log.emit('main',{type:'meta',patch:{cleared:{at:999,id:'global-clear'}}});
 expect(log.picture('main')!.items).toEqual([]);expect(log.picture('main')!.meta.threadPath).toBe(f.originals[0].native);log.close();
 expect(await readFile(o.native,'utf8')).toBe(before);expect(await readFile(file,'utf8')).toBe(sourceBefore);
});
it('cross-source original item collision refuses preview with both source identities, without native rewrite',async()=>{
 const f=await fixture(),o=f.originals[1],before=await readFile(o.native,'utf8');
 await writeFile(o.native,before.replace('"timestamp":21','"timestamp":20'));
 await fixtureCheckpoint(join(o.events,'main.jsonl'),o.events);
 await expect(previewGlobalConversations(f.options,{assertStopped:stopped})).rejects.toThrow(/ambiguous-item-identity/);
 expect(await readFile(o.native,'utf8')).toBe(before.replace('"timestamp":21','"timestamp":20'));
});
it('a crash after retaining an original home inode recovers; a crash restoring one original rolls back safely',async()=>{
 const f=await fixture(),p=await previewGlobalConversations(f.options,{assertStopped:stopped});let intent='';
 await expect(applyGlobalConversations(p.intentPath,{assertStopped:stopped,stage:async(stage,path)=>{if(stage==='original-retained'){intent=path;throw Error('retention-crash');}}})).rejects.toThrow('retention-crash');
 expect(()=>new ConvLog(f.home)).toThrow(/maintenance incomplete/);
 await recoverGlobalConversations(intent,{assertStopped:stopped});
 await expect(rollbackGlobalConversations(intent,{assertStopped:stopped,stage:async(stage)=>{if(stage==='original-restored')throw Error('restore-crash');}})).rejects.toThrow('restore-crash');
 await rollbackGlobalConversations(intent,{assertStopped:stopped});
 for(const o of f.originals)expect(await readFile(join(o.events,'main.jsonl'),'utf8')).toBe(o.bytes);
});
