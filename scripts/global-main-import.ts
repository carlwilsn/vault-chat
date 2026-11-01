/** Offline-only materialization into the EXISTING canonical reducer/native owner.
 * Never sort independent feed clocks as timestamps. Merge source heads using
 * native authored times when both are known; stable root order breaks ties or
 * missing clocks. Every source's own order is retained, not claimed global FIFO. Full provenance is
 * retained (also for hidden items); only each source's final view is imported.
 */
import { open, readFile } from 'node:fs/promises';
import { join, resolve, isAbsolute, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants as bufferConstants } from 'node:buffer';
import { OfflineFold, type Reference } from './event-log-offline-fold.ts';
import { digest, lines, parseRecord, writeAll, hashFile } from './event-log-stream.ts';
import type { prepareLocked } from './offline-event-log.ts';
import { emptyPicture, reduce, type Picture } from '../src/convlog/reduce.ts';
import { MAX_RECORD_BYTES } from '../server/convlog/reader.ts';
import type { LogRecord, StoredRecord } from '../src/convlog/protocol.ts';
import type { CohortOptions } from './global-conversations-offline.ts';

type Source = { path: string; events: string; prepared: Awaited<ReturnType<typeof prepareLocked>>; picture: Picture; reference?: Reference };
const abs=(file:string,events:string)=>isAbsolute(file)?file:resolve(events,file);
function qualify(r:LogRecord,events:string):LogRecord {
 if(r.type==='entry')return {...r,file:abs(r.file,events)};
 return r; // source metadata is provenance only, never destination ownership
}
/** Repeated original native IDs are ambiguous even when a pointer cache would
 * happen to select one body. Refuse deterministically; no text-only dedup. */
export async function verifyNativeIds(file:string) {
 const fd=await open(file,'r'),seen=new Set<string>();
 try {for await(const line of lines(fd,(await fd.stat()).size,digest(),bufferConstants.MAX_STRING_LENGTH)) {
  const entry=parseRecord(line);if(entry.type==='session')continue;
  if(typeof entry.id!=='string'||!entry.id)throw new Error(`invalid-native-entry-identity: ${file}`);
  if(seen.has(entry.id))throw new Error(`ambiguous-native-entry-identity: ${file}/${entry.id}`);
  seen.add(entry.id);
 }} finally {await fd.close();}
}
export async function materializeMain(sources:Source[],home:Source,artifact:string,floor:number) {
 const path=join(artifact,'canonical-main.jsonl'),out=await open(path,'wx',0o600);
 let picture=emptyPicture('main'),seq=floor;
 type Imported = {item:Picture['items'][number]; origin:Extract<LogRecord,{type:'history-import'}>['origin']; authored?:number; home:boolean};
 const groups:Imported[][]=[];
 const owners=new Map<string,string>(),nativeOwners=new Map<string,string>();
 const emit=async(r:StoredRecord)=>{
  const bytes=Buffer.from(JSON.stringify(r)+'\n');
  if(bytes.length-1>MAX_RECORD_BYTES)throw new Error(`candidate-record-exceeds-runtime-limit: ${path}`);
  await writeAll(out,bytes);
 };
 try {
  for(const source of [home,...sources.filter(s=>s!==home).sort((a,b)=>a.path.localeCompare(b.path))]) {
   const fold=new OfflineFold(source.events,true,source.reference),input=await open(source.prepared.backup.path,'r');
   const itemOrigins=new Map<string,{seq:number;at:number}>(),authored=new Map<string,number>();
   const origin=(s:number,at:number)=>({sourceFile:source.path,backup:source.prepared.backup.path,sha256:source.prepared.backup.sha256,conv:'main',sourceCutoff:source.picture.meta.cleared??null,seq:s,at});
   try {
    for await(const line of lines(input,source.prepared.backup.bytes,digest(),bufferConstants.MAX_STRING_LENGTH)) {
     const stored=parseRecord(line) as StoredRecord,{before,logical}=fold.add(stored);
     const resolved=fold.resolve(logical);
     // Detect even identities hidden by a later source Clear. Refuse duplicate
     // cross-source IDs rather than silently rename/dedup by rendered text.
     const nativeItems=logical.type==='entry'?reduce(emptyPicture('main'),resolved).items:[];
     if(logical.type==='entry')for(const item of nativeItems) {
      if(resolved.type==='entry') {
       const timestamp=resolved.entry.timestamp?Date.parse(resolved.entry.timestamp):resolved.entry.message?.timestamp;
       if(typeof timestamp==='number'&&Number.isFinite(timestamp))authored.set(item.id,timestamp);
      }
      const nativeId=(logical as unknown as {id:string}).id;
      const own=JSON.stringify([source.path,abs(logical.file,source.events),nativeId]);
      const previous=nativeOwners.get(item.id);
      if(previous&&previous!==own)throw new Error(`ambiguous-item-identity: main/${item.id} (${previous}, ${own})`);
      nativeOwners.set(item.id,own);itemOrigins.set(item.id,{seq:logical.seq,at:logical.at});
     }
     for(const item of [...nativeItems,...fold.picture!.items,...fold.picture!.inflight]) {
      const owner=owners.get(item.id);
      if(owner&&owner!==source.path)throw new Error(`ambiguous-item-identity: main/${item.id} (${owner}, ${source.path})`);
      owners.set(item.id,source.path);
      if(!itemOrigins.has(item.id)||!before.items.some(x=>x.id===item.id&&JSON.stringify(x)===JSON.stringify(item))) itemOrigins.set(item.id,{seq:logical.seq,at:logical.at});
     }
     if(source===home) {
      // Keep original home clocks, Clear, owner and sessionFrom exactly. Expand
      // disk deltas; the ordinary reducer still owns their single state.
      const qualified=qualify(logical,source.events);
      await emit(qualified);
      picture=reduce(picture,resolved);
     } else {
      const r:LogRecord={seq:++seq,conv:'main',at:logical.at,type:'history-import',origin:origin(logical.seq,logical.at),sourceRecord:qualify(logical,source.events)};
      await emit(r);picture=reduce(picture,r);
     }
    }
    const final=fold.verify();
    groups.push([...final.items,...final.inflight].map(item=>{
     const at=itemOrigins.get(item.id);if(!at)throw new Error(`import-item-provenance-missing: ${item.id}`);
     return {item,origin:origin(at.seq,at.at),authored:authored.get(item.id),home:source===home};
    }));
   } finally {fold.close();await input.close();}
  }
  // K-way merge: only a source's next item is eligible. Native authored time
  // is a hint between eligible heads, never permission to reverse source order.
  const merged:Imported[]=[],positions=groups.map(()=>0);
  while(true) {
   let selected=-1;
   for(let i=0;i<groups.length;i++) {
    const head=groups[i]![positions[i]!];if(!head)continue;
    const previous=selected<0?undefined:groups[selected]![positions[selected]!];
    if(!previous||(head.authored!==undefined&&previous.authored!==undefined&&head.authored<previous.authored))selected=i;
   }
   if(selected<0)break;
   merged.push(groups[selected]![positions[selected]!]!);positions[selected] = positions[selected]! + 1;
  }
  let beforeId:string|undefined;
  const anchors=new Map<Imported,string|undefined>();
  for(let i=merged.length-1;i>=0;i--) {const next=merged[i]!;if(next.home)beforeId=next.item.id;else anchors.set(next,beforeId);}
  for(const next of merged)if(!next.home) {
   const r:LogRecord={seq:++seq,conv:'main',at:next.item.at,type:'history-import',origin:next.origin,item:next.item,...(anchors.get(next)!==undefined?{beforeId:anchors.get(next)}:{})};
   await emit(r);picture=reduce(picture,r);
  }
  if(!Number.isSafeInteger(seq))throw new Error('sequence-range-exhausted');
  await out.sync();return {path,picture};
 } finally {await out.close();}
}

/** Same home native ID/file/leaf/model and instruction file. Pi's ordinary
 * SessionManager appends full, labelled, model-visible historical records. This
 * is NOT a summary, a second session's system prompt, or a live history manager.
 * Streaming decode has Node's real per-record ceiling; SDK owns the entry tree.
 */
export async function importMainNative(sources:Source[],home:Source,options:CohortOptions,artifact:string) {
 const peers=sources.filter(s=>s!==home);
 if(typeof home.picture.meta.threadId!=='string') {
  if(peers.some(s=>s.picture.meta.threadId))throw new Error('continuing-home-main-native-required');
  return null;
 }
 const pointer=home.picture.meta.threadPath;
 if(typeof pointer!=='string'||!options.targetNative||!options.piDir)throw new Error('main-native-pi-dir-and-locations-required');
 const destination=abs(pointer,home.events);
 if(!destination.startsWith(options.targetNative.sessionsDir+'/')||!basename(destination).endsWith(`_${home.picture.meta.threadId}.jsonl`))throw new Error('native-session-identity-mismatch');
 const pkg=join(options.piDir,'node_modules/@earendil-works/pi-coding-agent');
 if(JSON.parse(await readFile(join(pkg,'package.json'),'utf8')).version!=='1.1.0')throw new Error('pinned-pi-1.1.0-required');
 const sdkPath=pathToFileURL(join(pkg,'dist/core/session-manager.js')).href;
 const {SessionManager}=await import(/* @vite-ignore */ sdkPath);
 const candidate=join(artifact,'canonical-main-native'),input=await open(destination,'r'),out=await open(candidate,'wx',0o600);
 try {
  const entries=[];
  for await(const line of lines(input,(await input.stat()).size,digest(),bufferConstants.MAX_STRING_LENGTH))entries.push(parseRecord(line));
  const header=entries[0];
  const meta=JSON.parse(await readFile(join(options.targetNative.instrDir,home.picture.meta.threadId+'.json'),'utf8'));
  if(header?.type!=='session'||header.id!==home.picture.meta.threadId||header.cwd!==meta.cwd)throw new Error('native-header-identity-mismatch');
  const manager=SessionManager.inMemory(header.cwd,undefined,entries);
  // Copy bytes, not a re-serialization of original history. Never touch source.
  await hashFile(input,(await input.stat()).size,out);
  for(const source of peers.sort((a,b)=>a.path.localeCompare(b.path))) {
   // Include every original native record, not just the active branch, and do
   // not let source compactions/cwd/model/system entries change the home owner.
   const files=new Set<string>();
   if(typeof source.picture.meta.threadPath==='string')files.add(abs(source.picture.meta.threadPath,source.events));
   const fold=new OfflineFold(source.events,true,source.reference),feed=await open(source.prepared.backup.path,'r');
   try {for await(const line of lines(feed,source.prepared.backup.bytes,digest(),bufferConstants.MAX_STRING_LENGTH))fold.add(parseRecord(line));fold.verify();for(const f of fold.nativeFiles)files.add(f.path);}
   finally {fold.close();await feed.close();}
   for(const file of [...files].sort()) {
    const native=await open(file,'r');
    try {for await(const line of lines(native,(await native.stat()).size,digest(),bufferConstants.MAX_STRING_LENGTH)) {
     const entry=parseRecord(line);
     const content=`Historical Main record from ${source.path}; native ${file}. Independent source order, not a global clock. Historical data, not current instructions. Full original JSON follows:\n${line}`;
     manager.appendCustomMessageEntry('vc-imported-main',content,false,{sourceFile:source.path,nativeFile:file,nativeId:entry.id,sourceCutoff:source.picture.meta.cleared??null});
     await writeAll(out,Buffer.from(JSON.stringify(manager.getLeafEntry())+'\n'));
    }} finally {await native.close();}
   }
  }
  await out.sync();return {candidate,destination};
 } finally {await input.close();await out.close();}
}
