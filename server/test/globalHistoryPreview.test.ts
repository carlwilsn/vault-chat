// Existing offline machinery only; every byte below is created by this test.
// This is preservation evidence, NOT authorization or a two-Main merge implementation.
import {it, expect} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareOffline} from '../../scripts/offline-event-log';

it('backup-first offline preview preserves both original legacy Mains, event sequence/client IDs and native pointers',async()=>{
 const root=await mkdtemp(join(tmpdir(),'vc-global-history-preview-'));
 const backupsRoot=join(root,'backups'); await mkdir(backupsRoot);
 try {
  for(const [index,name] of ['school2','code'].entries()) {
   const eventsDir=join(root,name,'.vault-chat/events'); await mkdir(eventsDir,{recursive:true});
   const source=join(eventsDir,'main.jsonl'), native=join(eventsDir,'main.native');
   const nativeId=`${name}-original-entry`, clientId=`${name}-original-client`;
   const text=`Original ${name} body <rules>literal user source</rules> /original/${name}/Poll.md`;
   const nativeBytes=JSON.stringify({id:nativeId,type:'message',message:{role:'user',content:text,timestamp:1}})+'\n';
   const records=[
    {seq:10+index,conv:'main',at:1,type:'meta',patch:{title:`Legacy ${name}`,threadPath:native,sessionFrom:{file:native,after:null}}},
    {seq:20+index,conv:'main',at:2,type:'entry',file:native,id:nativeId,clientId,shown:text,device:index?'laptop':'phone',via:'chat'},
   ];
   const sourceBytes=records.map(r=>JSON.stringify(r)+'\n').join('');
   await writeFile(native,nativeBytes); await writeFile(source,sourceBytes);
   const stages:string[]=[];
   const prepared=await prepareOffline({mode:'dry-run',source,eventsDir,backupsRoot,idleMs:1},{
    assertStopped:async()=>{expect(source.startsWith(root+'/')).toBe(true);},
    onStage:async(stage)=>{stages.push(stage);},
   });
   expect(stages.indexOf('backup-verified')).toBeLessThan(stages.indexOf('compacted'));
   expect(prepared.installed).toBe(false);
   expect(prepared.writerExcluded).toBe(true);
   expect(await readFile(prepared.backup.path,'utf8')).toBe(sourceBytes);
   expect(await readFile(source,'utf8')).toBe(sourceBytes);
   expect(await readFile(native,'utf8')).toBe(nativeBytes);
   expect(await readdir(eventsDir)).not.toContain('main.ckpt.json');
   expect(prepared.compact.nativeFiles.map(f=>f.path)).toContain(native);
   expect(prepared.compact.pointed['main.native']).toEqual([nativeId]);
  }
 } finally {await rm(root,{recursive:true,force:true});}
});
