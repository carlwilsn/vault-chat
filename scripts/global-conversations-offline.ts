/** Operator-only global ownership migration. Explicit stopped cohorts only.
 * Old Mains materialize into ordinary canonical Main. Source-local controls
 * are retained as provenance, not replayed across independent Clear domains. Original histories
 * and native files are never moved or rewritten. The external durable intent
 * supports recognized forward recovery and CAS-only rollback, not authorization.
 */
import { constants } from 'node:fs';
import { materializeMain, importMainNative, verifyNativeIds } from './global-main-import.ts';
import { open, lstat, realpath, readdir, readFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join, resolve, isAbsolute } from 'node:path';
import { constants as bufferConstants } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { acquireEventDirectory } from '../server/convlog/maintenance.ts';
import { checkpointFor, fileStem } from '../server/convlog/log.ts';
import { GLOBAL_CUTOVER, type GlobalCutover } from '../server/convlog/globalCutover.ts';
import { MAX_RECORD_BYTES, validatePosition } from '../server/convlog/reader.ts';
import { OfflineFold, type Reference } from './event-log-offline-fold.ts';
import { prepareLocked, externalBackupRoot, type Observations } from './offline-event-log.ts';
import { digest, hashFile, identity, lines, parseRecord, same, syncDir, writeAll } from './event-log-stream.ts';
import { compactSubagents, emptyPicture, reduce, type Picture } from '../src/convlog/reduce.ts';
import type { StoredRecord, LogRecord } from '../src/convlog/protocol.ts';

type Evidence = { path: string; stamp: ReturnType<typeof identity>; bytes: number; sha256: string };
type Kept = { original: Evidence; backup: Evidence };
type NativeLocation = { sessionsDir: string; instrDir: string };
export type CohortOptions = { piDir?: string; home: string; targetNative?: NativeLocation; sources: { root: string; mainAlias: string; native?: NativeLocation }[]; backupsRoot: string; idleMs: number };
type NativeCopy = { source: string; candidate: Evidence; staged: Evidence; destination: string };
type Member = { source: string; originalId: string; id: string; seqOffset: number; prepared: Awaited<ReturnType<typeof prepareLocked>>; candidate: Evidence; log: Evidence; checkpoint: Evidence | null; destination: string; checkpointDestination: string; foldSha256: string };
type Replacement = { original: Evidence; parked: string };
type Intent = { replacements: Replacement[]; format: 'global-conversation-cohort-v1'; options: CohortOptions; artifact: string; dirs: string[]; absentPaths: string[]; kept: Kept[]; homeFiles: string[]; members: Member[]; nativeCopies: NativeCopy[]; commit: Evidence | null; commitDestination: string };
export type CohortHooks = Observations & { stage?: (stage: 'prepared' | 'member-installed' | 'before-commit' | 'committed' | 'rollback-started' | 'rollback-member' | 'original-retained' | 'original-restored', intent: string) => Promise<void> };
const canonical = (p: unknown) => JSON.parse(JSON.stringify(p));
const hashPicture = (p: Picture) => digest().update(JSON.stringify(p)).digest('hex');
async function absent(p: string) { try { await lstat(p); return false; } catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true; throw e; } }
async function evidence(path: string): Promise<Evidence> {
 const s = await lstat(path);
 if (!s.isFile() || s.nlink !== 1 || await realpath(path) !== path) throw new Error(`regular-unaliased-single-link-file-required: ${path}`);
 const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try {
  const sha256 = await hashFile(fd, s.size);
  if (!same(identity(s), identity(await fd.stat())) || !same(identity(s), identity(await lstat(path)))) throw new Error(`file-changed: ${path}`);
  return { path, stamp: identity(s), bytes: s.size, sha256 };
 } finally { await fd.close(); }
}
async function matches(e: Evidence, path = e.path, renamed = false) {
 if (await absent(path)) return false;
 const n = await evidence(path);
 // Rename changes ctime only. Never accept a copied/replaced inode.
 const { ctimeMs: _a, ...a } = e.stamp, { ctimeMs: _b, ...b } = n.stamp;
 return (renamed ? same(a,b) : same(e.stamp,n.stamp)) && e.sha256 === n.sha256;
}
async function requireMatch(e: Evidence, path = e.path, renamed = false) { if (!await matches(e,path,renamed)) throw new Error(`cohort-CAS-refused: ${path}`); }
async function writeNew(path: string, data: string) { const f = await open(path,'wx',0o600); try { await f.writeFile(data); await f.sync(); } finally { await f.close(); } await syncDir(dirname(path)); }
async function lock(options: CohortOptions, hooks: CohortHooks) {
 await hooks.assertStopped();
 const roots = [options.home, ...options.sources.map(s=>s.root)];
 if (!roots.length || new Set(roots).size !== roots.length) throw new Error('duplicate-cohort-root');
 const dirs: string[] = [];
 for (const root of roots) {
  if (resolve(root) !== root || await realpath(root) !== root) throw new Error(`cohort-root-alias: ${root}`);
  const dir = join(root,'.vault-chat/events');
  if (await realpath(dir) !== dir) throw new Error(`event-directory-alias: ${dir}`);
  dirs.push(dir);
 }
 const releases: (()=>void)[] = [];
 try { for (const dir of [...dirs].sort()) releases.push(acquireEventDirectory(dir,'exclusive')); await hooks.assertStopped(); }
 catch(e) { for(const r of releases.reverse()) r(); throw e; }
 return { dirs, release:()=>{for(const r of releases.reverse()) r();} };
}
// Existing source files (including private native subdirectories), not a second
// inventory authority. Only the transaction's CAS read set, kept externally.
async function files(dir: string): Promise<string[]> {
 const result: string[]=[];
 for (const e of await readdir(dir,{withFileTypes:true})) {
  const p=join(dir,e.name);
  if(e.isSymbolicLink()) throw new Error(`cohort-symlink: ${p}`);
  if(e.isDirectory()) result.push(...await files(p));
  else if(e.isFile()) result.push(p);
  else throw new Error(`cohort-special-file: ${p}`);
 }
 return result.sort();
}
async function keep(path: string, artifact: string, kept: Kept[]) {
 const existing=kept.find(k=>k.original.path===path); if(existing) return existing;
 const original=await evidence(path), target=join(artifact,`kept-${kept.length}`), src=await open(path,'r'), dst=await open(target,'wx',0o400);
 try { if(await hashFile(src,original.bytes,dst)!==original.sha256) throw new Error('backup-source-changed'); await dst.sync(); }
 finally {await src.close(); await dst.close();}
 const backup=await evidence(target); if(backup.sha256!==original.sha256 || backup.bytes!==original.bytes) throw new Error('backup-readback-mismatch');
 await requireMatch(original); await syncDir(artifact);
 const k={original,backup}; kept.push(k); return k;
}
async function validateKept(m: Intent, homeControlsMayAdvance=false) {
 for(const path of m.absentPaths) if(!await absent(path)) throw new Error(`cohort-CAS-refused-new-registry: ${path}`);
 for(const dir of m.dirs.slice(1)) {
  const expected=m.kept.filter(k=>k.original.path.startsWith(dir+'/')).map(k=>k.original.path).sort();
  if(!isDeepStrictEqual(await files(dir),expected)) throw new Error(`source-cohort-membership-changed: ${dir}`);
 }
 for(const k of m.kept) {
  await requireMatch(k.backup);
  if(homeControlsMayAdvance && [join(m.dirs[0],'_seq'),join(m.dirs[0],'_epoch')].includes(k.original.path)) continue;
  const replacement=m.replacements.find(r=>r.original.path===k.original.path);
  if(replacement && !await absent(replacement.parked)) await requireMatch(k.original,replacement.parked,true);
  else await requireMatch(k.original,k.original.path,!!replacement&&homeControlsMayAdvance);
 }
}
async function foldFile(path: string, events: string, reference?: Reference, nativePaths?: ReadonlyMap<string,string>) {
 const fd=await open(path,'r'), fold=new OfflineFold(events,true,reference,nativePaths);
 try { for await(const line of lines(fd,(await fd.stat()).size,digest(),bufferConstants.MAX_STRING_LENGTH)) fold.add(parseRecord(line)); return { picture:fold.verify(), pointed:fold.pointed, nativeFiles:fold.nativeFiles }; }
 finally {fold.close(); await fd.close();}
}
// Native pointers retain their ORIGINAL root. Never copy native session bodies
// into the new feed or resolve a relative pointer against the destination.
function qualify(rec: LogRecord, events: string, nativePaths?: ReadonlyMap<string,string>): LogRecord {
 const abs=(s:string)=>{const path=isAbsolute(s)?s:resolve(events,s);return nativePaths?.get(path)??path;};
 if(rec.type==='entry') return {...rec,file:abs(rec.file)};
 if(rec.type!=='meta') return rec;
 const patch={...rec.patch};
 if(typeof patch.threadPath==='string') patch.threadPath=abs(patch.threadPath);
 if(patch.sessionFrom && typeof patch.sessionFrom==='object') { const s=patch.sessionFrom as Record<string,unknown>; if(typeof s.file==='string') patch.sessionFrom={...s,file:abs(s.file)}; }
 return {...rec,patch};
}
function assertIdle(p: Picture, path: string) {
 if(p.meta.running || p.meta.working || p.meta.clearing || p.meta.pending?.length || p.inflight.length || p.meta.subagents?.some(w=>w.state==='running'||w.state==='queued')) throw new Error(`source-conversation-not-idle: ${path}`);
}
async function validateRegistry(roots: string[]) {
 const slugs=new Map<string,string>(), folders=new Map<string,string>();
 for(const root of roots) {
  const path=join(root,'.vault-chat/local/project-folders.json');
  if(await absent(path)) continue;
  await evidence(path);
  const r=JSON.parse(await readFile(path,'utf8'));
  for(const [slug,e] of Object.entries(r.folders??{}) as [string,{path:string}][]) {
   if(typeof e.path!=='string') throw new Error(`invalid-project-folder: ${slug}`);
   const folder=await realpath(resolve(root,e.path));
   if(slugs.has(slug) && slugs.get(slug)!==folder) throw new Error(`ambiguous-project-slug: ${slug}`);
   if(folders.has(folder) && folders.get(folder)!==slug) throw new Error(`ambiguous-project-identity: ${folder}`);
   slugs.set(slug,folder); folders.set(folder,slug);
  }
 }
}
/** Preview is backup-first and returns canonical conversations/provenance sequence ranges.
 * It does not write logs, checkpoints, registries, or a routing commit. */
export async function previewGlobalConversations(options: CohortOptions, hooks: CohortHooks) {
 const held=await lock(options,hooks);
 try {
  if(!options.sources.length) throw new Error('explicit-nonempty-cohort-required');
  if(!Number.isSafeInteger(options.idleMs)||options.idleMs<1) throw new Error('positive-idle-ms-required');
  const backups=await realpath(options.backupsRoot);
  for(const root of [options.home,...options.sources.map(s=>s.root)]) if(backups===root||backups.startsWith(root+'/')||root.startsWith(backups+'/')) throw new Error('backup-root-must-be-outside-vault');
  if(backups.split('/').includes('.vault-chat')) throw new Error('backup-root-must-be-outside-vault');
  for(const dir of held.dirs) await externalBackupRoot(backups,dir);
  // Reuse ordinary maintenance's external-root checks before any candidate.
  await validateRegistry([options.home,...options.sources.map(s=>s.root)]);
  for(const root of [options.home,...options.sources.map(s=>s.root)]) {
   const legacy=join(root,'.vault-chat/conversations'),monolithic=join(root,'.vault-chat/conversations.jsonl');
   if((!await absent(legacy)&&(await readdir(legacy)).some(n=>n.endsWith('.jsonl')))||(!await absent(monolithic)&&(await lstat(monolithic)).size>0)) throw new Error(`legacy-conversations-require-reviewed-import: ${root}`);
  }
  const commitDestination=join(held.dirs[0],GLOBAL_CUTOVER);
  if(!await absent(commitDestination)) throw new Error('cohort-already-committed');
  const artifact=join(backups,`global-cohort-${randomUUID()}`); await mkdir(artifact,{mode:0o700}); await syncDir(backups);
  const kept: Kept[]=[], absentPaths: string[]=[], homeFiles=await files(held.dirs[0]);
  for(const dir of held.dirs) for(const p of await files(dir)) await keep(p,artifact,kept);
  for(const root of [options.home,...options.sources.map(s=>s.root)]) {
   const registry=join(root,'.vault-chat/local/project-folders.json'); if(!await absent(registry)) await keep(registry,artifact,kept);else absentPaths.push(registry);
  }
  const mainSources: Parameters<typeof materializeMain>[0]=[];
  const checkedNative=new Set<string>();
  const nativeKeep=async(path:string)=>{await keep(path,artifact,kept);if(!checkedNative.has(path)){await verifyNativeIds(path);checkedNative.add(path);}};
  const used=new Set<string>(); let floor=0;
  for(const p of homeFiles) {
   if(dirname(p)===held.dirs[0]&&p.endsWith('.jsonl')&&!p.split('/').at(-1)!.startsWith('_')) {
    const checkpoint=p.replace(/\.jsonl$/,'.ckpt.json');let reference:Reference|undefined;
    if(!await absent(checkpoint)) {reference=JSON.parse(await readFile(checkpoint,'utf8'));if(reference!.v===2)throw new Error(`checkpoint-only-required-before-global-apply: ${p}`);validatePosition(p,(reference as any).position,reference!.seq);}
    const folded=await foldFile(p,held.dirs[0],reference);assertIdle(folded.picture,p);
    for(const native of folded.nativeFiles) {if(!native.identity)throw new Error('native-pointer-missing');await nativeKeep(native.path);}
    const thread=folded.picture.meta.threadId;
    if(typeof thread==='string'&&thread) {
     if(!options.targetNative)throw new Error(`native-runtime-locations-required: ${p}/${thread}`);
     const meta=join(options.targetNative.instrDir,thread+'.json');await keep(meta,artifact,kept);
     const data=JSON.parse(await readFile(meta,'utf8'));if(typeof data.instr!=='string'||dirname(data.instr)!==options.targetNative.instrDir)throw new Error(`native-instruction-identity-mismatch: ${thread}`);
     await keep(data.instr,artifact,kept);
     const session=folded.picture.meta.threadPath;if(typeof session!=='string')throw new Error('native-session-identity-mismatch');await nativeKeep(resolve(held.dirs[0],session));
    }
    used.add(folded.picture.id); floor=Math.max(floor,folded.picture.seq);
    if(folded.picture.id==='main') {
     const prepared=await prepareLocked({mode:'dry-run',source:p,eventsDir:held.dirs[0],backupsRoot:backups,idleMs:options.idleMs,strictNative:true},hooks);
     mainSources.push({path:p,events:held.dirs[0],prepared,picture:folded.picture,reference});
    }
   }
  }
  for(const k of kept) if(k.original.path.endsWith('/_seq')) { const n=Number(await readFile(k.backup.path,'utf8')); if(!Number.isSafeInteger(n)||n<0) throw new Error('invalid-source-clock'); floor=Math.max(floor,n); }
  const members: Member[]=[], nativeCopies: NativeCopy[]=[], replacements: Replacement[]=[];
  const relocations=new Map<string,string>();
  for(const [i,source] of [...options.sources].sort((a,b)=>a.root.localeCompare(b.root)).entries()) {
   if(!/^[A-Za-z0-9_-]{6,80}$/.test(source.mainAlias)||source.mainAlias==='main'||source.mainAlias.startsWith('project-')) throw new Error(`explicit-valid-main-alias-required: ${source.root}`);
   if(used.has(source.mainAlias)||options.sources.filter(s=>s.mainAlias===source.mainAlias).length!==1)throw new Error(`retired-main-id-collision: ${source.mainAlias}`);
   const events=join(source.root,'.vault-chat/events');
   for(const name of (await readdir(events)).filter(n=>n.endsWith('.jsonl')&&!n.startsWith('_')).sort()) {
    const path=join(events,name);
    const prepared=await prepareLocked({mode:'dry-run',source:path,eventsDir:events,backupsRoot:backups,idleMs:options.idleMs,strictNative:true},hooks);
    let reference: Reference|undefined;
    const checkpoint=path.replace(/\.jsonl$/,'.ckpt.json');
    if(!await absent(checkpoint)) {
     const ck=JSON.parse(await readFile(checkpoint,'utf8')); reference=ck;
     if(ck.v===2) throw new Error(`checkpoint-only-required-before-global-apply: ${path}`);
     validatePosition(path,ck.position,ck.seq);
    }
    const original=await foldFile(prepared.backup.path,events,reference), originalId=original.picture.id;
    if(fileStem(originalId)+'.jsonl'!==name) throw new Error(`conversation-filename-identity-collision: ${path}`);
    assertIdle(original.picture,path);
    if(originalId==='main') {
     for(const native of original.nativeFiles) {if(!native.identity)throw new Error('native-pointer-missing');await nativeKeep(native.path);}
     // Old Main is NOT a resumable alternate thread. Preserve its original
     // instruction metadata, but never copy/spawn those instructions as Main.
     const thread=original.picture.meta.threadId;
     if(typeof thread==='string'&&thread) {
      if(!source.native)throw new Error('native-runtime-locations-required');
      const meta=join(source.native.instrDir,thread+'.json');await keep(meta,artifact,kept);
      const data=JSON.parse(await readFile(meta,'utf8'));if(typeof data.instr!=='string'||dirname(data.instr)!==source.native.instrDir)throw new Error('native-instruction-identity-mismatch');
      await keep(data.instr,artifact,kept);
      const session=original.picture.meta.threadPath;
      if(typeof session!=='string'||dirname(resolve(events,session))!==source.native.sessionsDir||!basename(session).endsWith(`_${thread}.jsonl`))throw new Error('native-session-identity-mismatch');
      await nativeKeep(resolve(events,session));
      const fd=await open(resolve(events,session),'r');let header;
      try {for await(const line of lines(fd,(await fd.stat()).size,digest(),bufferConstants.MAX_STRING_LENGTH)){header=parseRecord(line);break;}}finally{await fd.close();}
      if(header?.type!=='session'||header.id!==thread||header.cwd!==data.cwd)throw new Error(`native-header-identity-mismatch: ${thread}`);
     }
     mainSources.push({path,events,prepared,picture:original.picture,reference});
     continue;
    }
    const id=originalId;
    if(used.has(id)) throw new Error(`ambiguous-conversation-identity: ${id} (${path})`); used.add(id);
    const destination=join(held.dirs[0],fileStem(id)+'.jsonl'), checkpointDestination=destination.replace(/\.jsonl$/,'.ckpt.json');
    if(!await absent(destination)||!await absent(checkpointDestination)) throw new Error(`destination-collision: ${id}`);
    for(const native of original.nativeFiles) { if(!native.identity) throw new Error('native-pointer-missing'); await nativeKeep(native.path); }
    const thread=original.picture.meta.threadId;
    if(typeof thread==='string' && thread) {
     const from=source.native,to=options.targetNative;
     if(!from||!to) throw new Error(`native-runtime-locations-required: ${path}/${thread}`);
     for(const dir of [from.sessionsDir,from.instrDir,to.sessionsDir,to.instrDir]) if(resolve(dir)!==dir||await realpath(dir)!==dir) throw new Error(`native-runtime-directory-alias: ${dir}`);
     const pointer=original.picture.meta.threadPath,session=typeof pointer==='string'?resolve(events,pointer):'';
     if(!session||dirname(session)!==from.sessionsDir||!basename(session).endsWith(`_${thread}.jsonl`)) throw new Error(`native-session-identity-mismatch: ${thread}`);
     const metaPath=join(from.instrDir,thread+'.json'); await keep(metaPath,artifact,kept);
     const meta=JSON.parse(await readFile(metaPath,'utf8'));
     if(typeof meta.instr!=='string'||dirname(meta.instr)!==from.instrDir||typeof meta.cwd!=='string') throw new Error(`native-instruction-identity-mismatch: ${thread}`);
     await keep(meta.instr,artifact,kept);
     // Header only: bounded native stream APIs still validate every pointed body.
     const nativeFd=await open(session,'r');let header;
     try {for await(const line of lines(nativeFd,(await nativeFd.stat()).size,digest(),bufferConstants.MAX_STRING_LENGTH)){header=parseRecord(line);break;}}finally{await nativeFd.close();}
     if(header?.type!=='session'||header.id!==thread||header.cwd!==meta.cwd) throw new Error(`native-header-identity-mismatch: ${thread}`);
     await nativeKeep(session);
     const copy=async(src:string,destination:string,data?:string)=>{
      await keep(src,artifact,kept);
      // A native file already owned by the target runtime needs no duplicate.
      if(src===destination)return;
      if(!await absent(destination)||nativeCopies.some(c=>c.destination===destination)) throw new Error(`native-destination-collision: ${destination}`);
      const k=await keep(src,artifact,kept),candidatePath=join(artifact,`native-${nativeCopies.length}`);
      if(data===undefined) await copyNew(k.backup,candidatePath); else await writeNew(candidatePath,data);
      const candidate=await evidence(candidatePath),staged={...candidate,path:join(dirname(destination),`.global-${randomUUID()}.pending`)};
      nativeCopies.push({source:src,candidate,staged,destination});
     };
     const targetSession=join(to.sessionsDir,basename(session)),targetInstr=join(to.instrDir,basename(meta.instr));
     await copy(session,targetSession);await copy(meta.instr,targetInstr);
     await copy(metaPath,join(to.instrDir,thread+'.json'),JSON.stringify({...meta,instr:targetInstr})+'\n');
     relocations.set(session,targetSession);
    }
    const nativePaths=new Map([...relocations].map(([a,b])=>[b,a]));
    const seqOffset=floor+1;
    if(!Number.isSafeInteger(seqOffset+original.picture.seq+1)) throw new Error('sequence-range-exhausted');
    const logPath=join(held.dirs[0],`.global-${randomUUID()}.pending`);
    // Preview candidates stay OUTSIDE the vault. Apply stages them only after
    // the caller reviews this intent and every original CAS check succeeds.
    const outPath=join(artifact,`candidate-${i}-${members.length}.jsonl`), out=await open(outPath,'wx',0o600), input=await open(prepared.backup.path,'r');
    const sourceFold=new OfflineFold(events,true,reference), candidateFold=new OfflineFold(held.dirs[0],true,undefined,nativePaths);
    let picture=emptyPicture(id);
    const itemOwners=new Map<string,string>();
    try {
     for await(const line of lines(input,prepared.backup.bytes,digest(),bufferConstants.MAX_STRING_LENGTH)) {
      const stored=parseRecord(line) as StoredRecord, {logical}=sourceFold.add(stored);
      if(logical.type==='entry') {
       const resolved=sourceFold.resolve(logical), entry=resolved.type==='entry'?resolved.entry:null;
       if(entry?.message && ['user','assistant'].includes(entry.message.role)) {
        const own=JSON.stringify([resolve(events,logical.file),(logical as unknown as {id:string}).id]);
        for(const item of reduce(emptyPicture(originalId),resolved).items) {
         const previous=itemOwners.get(item.id);
         if(previous && previous!==own) throw new Error(`ambiguous-item-identity: ${originalId}/${item.id}`);
         itemOwners.set(item.id,own);
        }
       }
      }
      const qualified=qualify(logical,events,relocations);
      const transformed={...qualified,conv:id,seq:logical.seq+seqOffset} as LogRecord;
      const encoded=Buffer.from(JSON.stringify(compactSubagents(picture,transformed))+'\n');
      if(encoded.length-1>MAX_RECORD_BYTES) throw new Error(`candidate-record-exceeds-runtime-limit: ${path}`);
      await writeAll(out,encoded); candidateFold.add(JSON.parse(encoded.toString('utf8')));
      picture=candidateFold.picture!;
     }
     sourceFold.verify();
     const sourcePicture=sourceFold.verify();
     const qualifiedMeta=qualify({type:'meta',conv:originalId,seq:sourcePicture.seq,at:0,patch:sourcePicture.meta},events,relocations) as Extract<LogRecord,{type:'meta'}>;
     const expectedPicture={...sourcePicture,id,seq:sourcePicture.seq+seqOffset,meta:qualifiedMeta.patch};
     const expected=canonical(expectedPicture), candidate=candidateFold.verify();
     if(!isDeepStrictEqual(expected,canonical(candidate))) throw new Error('canonical-candidate-fold-mismatch');
     const ids=new Set<string>(); for(const item of [...candidate.items,...candidate.inflight]) { if(ids.has(item.id)) throw new Error(`ambiguous-item-identity: ${id}/${item.id}`); ids.add(item.id); }
     await out.sync();
     floor=picture.seq;
    } finally {sourceFold.close(); candidateFold.close(); await out.close(); await input.close();}
    const log=await evidence(outPath);
    members.push({source:path,originalId,id,seqOffset,prepared,candidate:log,log:{...log,path:logPath},checkpoint:null,destination,checkpointDestination,foldSha256:hashPicture(picture)});
    // Store candidate origin path separately as backup evidence, not a mutable mirror.
    await keep(outPath,artifact,kept);
   }
  }
  if(mainSources.some(x=>x.events!==held.dirs[0])) {
   const homeMain=mainSources.find(x=>x.events===held.dirs[0]);
   if(!homeMain)throw new Error('continuing-home-main-required');
   const native=await importMainNative(mainSources,homeMain,options,artifact);
   if(native) {
    const original=(await keep(native.destination,artifact,kept)).original;
    replacements.push({original,parked:join(dirname(native.destination),`.global-${randomUUID()}.retained`)});
    nativeCopies.push({source:native.destination,candidate:await evidence(native.candidate),staged:{...await evidence(native.candidate),path:join(dirname(native.destination),`.global-${randomUUID()}.pending`)},destination:native.destination});
   }
   const result=await materializeMain(mainSources,homeMain,artifact,floor);
   const destination=homeMain.path, checkpointDestination=destination.replace(/\.jsonl$/,'.ckpt.json');
   for(const path of [destination,checkpointDestination]) if(!await absent(path)) replacements.push({original:(await keep(path,artifact,kept)).original,parked:join(held.dirs[0],`.global-${randomUUID()}.retained`)});
   const candidate=await evidence(result.path);
   members.unshift({source:destination,originalId:'main',id:'main',seqOffset:0,prepared:homeMain.prepared,candidate,log:{...candidate,path:join(held.dirs[0],`.global-${randomUUID()}.pending`)},checkpoint:null,destination,checkpointDestination,foldSha256:hashPicture(result.picture)});
   await keep(result.path,artifact,kept);
  }
  if(!members.length) throw new Error('empty-source-cohort');
  const m: Intent={replacements,format:'global-conversation-cohort-v1',options,artifact,dirs:held.dirs,absentPaths,kept,homeFiles,members,nativeCopies,commit:null,commitDestination};
  const intentPath=join(artifact,'preview.json'); await writeNew(intentPath,JSON.stringify(m)+'\n');
  await validateKept(m); await hooks.stage?.('prepared',intentPath);
  return {intentPath,conversations:members.map(m=>({source:m.source,id:m.id,originalId:m.originalId,seqOffset:m.seqOffset,sourceLastSeq:m.prepared.compact.lastSeq,title:m.originalId==='main'?'Main':undefined})),installed:false};
 } finally {held.release();}
}
async function loadIntent(path: string) {
 await evidence(path);
 const m=JSON.parse(await readFile(path,'utf8')) as Intent;
 if(m.format!=='global-conversation-cohort-v1'||m.artifact!==dirname(path)||m.options.home!==resolve(m.options.home)||m.commitDestination!==join(m.options.home,'.vault-chat/events',GLOBAL_CUTOVER)||!Array.isArray(m.members)||!m.members.length) throw new Error('invalid-global-cohort-intent');
 if(!Array.isArray(m.absentPaths)||m.absentPaths.some(p=>![m.options.home,...m.options.sources.map(s=>s.root)].map(r=>join(r,'.vault-chat/local/project-folders.json')).includes(p))) throw new Error('invalid-cohort-absent-registry');
 if(m.commit && (dirname(m.commit.path)!==m.dirs[0]||!m.commit.path.endsWith('.pending'))) throw new Error('invalid-routing-commit');
 if(!Array.isArray(m.nativeCopies)||!Array.isArray(m.replacements)) throw new Error('invalid-native-cohort');
 for(const r of m.replacements)if(!m.kept.some(k=>isDeepStrictEqual(k.original,r.original))||dirname(r.parked)!==dirname(r.original.path)||!basename(r.parked).startsWith('.global-')||!r.parked.endsWith('.retained'))throw new Error('invalid-cohort-replacement');
 const dirs=[m.options.home,...m.options.sources.map(s=>s.root)].map(p=>join(p,'.vault-chat/events'));
 if(!isDeepStrictEqual(dirs,m.dirs)) throw new Error('invalid-cohort-directories');
 for(const member of m.members) {
  if(dirname(member.destination)!==dirs[0]||fileStem(member.id)+'.jsonl'!==member.destination.split('/').at(-1)||member.checkpointDestination!==member.destination.replace(/\.jsonl$/,'.ckpt.json')||dirname(member.log.path)!==dirs[0]||!member.log.path.endsWith('.pending')||dirname(member.candidate.path)!==m.artifact||!dirs.includes(dirname(member.source))) throw new Error('invalid-cohort-member');
  if(member.checkpoint && (dirname(member.checkpoint.path)!==dirs[0]||!member.checkpoint.path.endsWith('.pending'))) throw new Error('invalid-cohort-checkpoint');
 }
 for(const r of m.replacements)if(!m.members.some(x=>x.id==='main'&&[x.destination,x.checkpointDestination].includes(r.original.path))&&!m.nativeCopies.some(x=>x.source===x.destination&&x.destination===r.original.path))throw new Error('replacement-not-continuing-main');
 const nativeDirs=[m.options.targetNative?.sessionsDir,m.options.targetNative?.instrDir].filter(Boolean);
 for(const copy of m.nativeCopies) if(!nativeDirs.includes(dirname(copy.destination))||dirname(copy.staged.path)!==dirname(copy.destination)||!copy.staged.path.endsWith('.pending')||dirname(copy.candidate.path)!==m.artifact) throw new Error('invalid-native-cohort-member');
 return m;
}
async function copyNew(source: Evidence, destination: string) {
 await requireMatch(source);
 const input=await open(source.path,'r'),out=await open(destination,'wx',0o600);
 try { if(await hashFile(input,source.bytes,out)!==source.sha256) throw new Error('candidate-copy-mismatch'); await out.sync(); }
 finally {await input.close(); await out.close();}
 const staged=await evidence(destination); if(staged.sha256!==source.sha256) throw new Error('candidate-readback-mismatch'); return staged;
}
async function verifyCandidates(m: Intent, installed: boolean) {
 const mapping=new Map<string,string>();
 for(const copy of m.nativeCopies) {
  const path=installed?copy.destination:await matches(copy.staged,copy.destination,true)?copy.destination:copy.staged.path;
  await requireMatch(copy.staged,path,path===copy.destination);mapping.set(copy.destination,path);
 }
 for(const member of m.members) {
  if(!member.checkpoint) throw new Error('cohort-not-staged');
  const log=installed?member.destination:await matches(member.log,member.destination,true)?member.destination:member.log.path;
  const checkpoint=installed?member.checkpointDestination:await matches(member.checkpoint,member.checkpointDestination,true)?member.checkpointDestination:member.checkpoint.path;
  await requireMatch(member.log,log,log===member.destination);
  await requireMatch(member.checkpoint,checkpoint,checkpoint===member.checkpointDestination);
  const ck=JSON.parse(await readFile(checkpoint,'utf8'));
  validatePosition(log,ck.position,ck.seq);
  const cold=await foldFile(log,m.dirs[0],undefined,mapping);
  if(hashPicture(cold.picture)!==member.foldSha256||!isDeepStrictEqual(canonical(cold.picture),ck.picture)||!isDeepStrictEqual(canonical(cold.pointed),ck.pointed)) throw new Error('cohort-canonical-readback-mismatch');
 }
}
async function expectedHomeFiles(m: Intent, allowControls: boolean, allowPartial: boolean) {
 const expected=new Set(m.homeFiles), actual=await files(m.dirs[0]);
 for(const r of m.replacements)expected.add(r.parked);
 expected.add(join(m.dirs[0],'_global-maintenance.json'));
 expected.add(m.commitDestination);
 if(m.commit) {expected.add(m.commit.path);if(allowPartial) expected.add(m.commit.path+'.rollback');}
 for(const copy of m.nativeCopies) {expected.add(copy.staged.path);expected.add(copy.destination);if(allowPartial)expected.add(copy.staged.path+'.rollback');}
 for(const member of m.members) {
  expected.add(member.log.path); expected.add(member.destination);
  if(member.checkpoint) expected.add(member.checkpoint.path);
  expected.add(member.checkpointDestination);
  if(allowPartial) {expected.add(member.log.path+'.rollback'); if(member.checkpoint) expected.add(member.checkpoint.path+'.rollback');}
 }
 if(allowControls) {expected.add(join(m.dirs[0],'_seq'));expected.add(join(m.dirs[0],'_epoch'));expected.add(join(m.dirs[0],'_signals.jsonl'));}
 for(const path of actual) if(!expected.has(path)) throw new Error(`cohort-new-writes-refuse-rollback: ${path}`);
 // A newly created nonempty signal file is a post-cutover write too.
 const signals=join(m.dirs[0],'_signals.jsonl');
 if(!m.homeFiles.includes(signals)&&!await absent(signals)&&(await lstat(signals)).size) throw new Error('cohort-new-signals-refuse-rollback');
}
async function maintenance(m: Intent, intentPath: string) {
 const guard=join(m.dirs[0],'_global-maintenance.json'), bytes=JSON.stringify({intent:intentPath})+'\n';
 if(await absent(guard)) await writeNew(guard,bytes);
 else if(await readFile(guard,'utf8')!==bytes) throw new Error('other-global-maintenance-in-progress');
 return guard;
}
/** Apply a reviewed preview; revalidate every source/backup under all directory
 * locks BEFORE staging. No writes to original source or registry. */
export async function applyGlobalConversations(previewPath: string, hooks: CohortHooks) {
 await hooks.assertStopped(); const m=await loadIntent(previewPath), held=await lock(m.options,hooks);
 try {
  if(m.commit||m.members.some(x=>x.checkpoint)) throw new Error('apply-requires-preview');
  await validateKept(m); await expectedHomeFiles(m,false,false);
  if(!await absent(m.commitDestination)) throw new Error('cohort-already-committed');
  for(const copy of m.nativeCopies) {if(!await absent(copy.destination)&&!m.replacements.some(r=>r.original.path===copy.destination)) throw new Error('native-destination-collision');copy.staged=await copyNew(copy.candidate,copy.staged.path);}
  const nativePaths=new Map(m.nativeCopies.map(c=>[c.destination,c.staged.path]));
  for(const member of m.members) {
   if([member.destination,member.checkpointDestination].some(p=>!m.replacements.some(r=>r.original.path===p)) && (!await absent(member.destination)||!await absent(member.checkpointDestination))) throw new Error('destination-collision');
   member.log=await copyNew(member.candidate,member.log.path);
   const candidate=await foldFile(member.log.path,m.dirs[0],undefined,nativePaths);
   if(hashPicture(candidate.picture)!==member.foldSha256) throw new Error('candidate-changed-after-preview');
   const ck=checkpointFor(member.log.path,candidate.picture,member.log.bytes,candidate.pointed);
   const path=join(m.dirs[0],`.global-${randomUUID()}-checkpoint.pending`);
   const bytes=JSON.stringify(ck)+'\n';if(Buffer.byteLength(bytes)>bufferConstants.MAX_STRING_LENGTH)throw new Error('checkpoint-exceeds-node-string-ceiling');
   await writeNew(path,bytes); member.checkpoint=await evidence(path);
  }
  const preview=await evidence(previewPath);
  const commit: GlobalCutover={format:'global-conversation-cutover-v1',home:m.options.home,retiredMainIds:m.options.sources.map(s=>s.mainAlias),legacyRoots:m.options.sources.map(s=>s.root),intent:previewPath,intentSha256:preview.sha256};
  const commitPath=join(m.artifact,'commit.pending'); await writeNew(commitPath,JSON.stringify(commit)+'\n');
  // Same-FS staging for the commit itself; durable journal before ANY rename.
  const stagedCommit=join(m.dirs[0],`.global-${randomUUID()}-commit.pending`);
  m.commit=await copyNew(await evidence(commitPath),stagedCommit);
  const intentPath=join(m.artifact,'apply.json'); await writeNew(intentPath,JSON.stringify(m)+'\n');
  await maintenance(m,intentPath);
  await completeGlobalLocked(m,intentPath,hooks);
  return {intentPath,installed:true};
 } finally {held.release();}
}
async function completeGlobalLocked(m: Intent, intentPath: string, hooks: CohortHooks) {
 if(!m.commit) throw new Error('cohort-not-staged');
 await validateKept(m); await expectedHomeFiles(m,false,false);
 await verifyCandidates(m,false);
 const committed=await matches(m.commit,m.commitDestination,true);
 if(!committed) {await requireMatch(m.commit); if(!await absent(m.commitDestination)) throw new Error('routing-commit-CAS-refused');}
 const guard=await maintenance(m,intentPath);
 for(const r of m.replacements) {
  if(await absent(r.parked)) {await requireMatch(r.original);await rename(r.original.path,r.parked);await syncDir(dirname(r.parked));await hooks.stage?.('original-retained',intentPath);}
  else await requireMatch(r.original,r.parked,true);
 }
 for(const copy of m.nativeCopies) {
  if(await absent(copy.destination)) {await requireMatch(copy.staged);await rename(copy.staged.path,copy.destination);await syncDir(dirname(copy.destination));}
 }
 for(const member of m.members) {
  // Both renames are recoverable, NOT atomic. Runtime refuses the guard.
  if(await absent(member.destination)) {await requireMatch(member.log); await rename(member.log.path,member.destination);await syncDir(m.dirs[0]);}
  if(await absent(member.checkpointDestination)) {await requireMatch(member.checkpoint!);await rename(member.checkpoint!.path,member.checkpointDestination);await syncDir(m.dirs[0]);}
  await hooks.stage?.('member-installed',intentPath);
 }
 await validateKept(m); await verifyCandidates(m,true);
 await hooks.assertStopped(); await hooks.stage?.('before-commit',intentPath);
 await validateKept(m); await verifyCandidates(m,true);
 if(!committed) {await requireMatch(m.commit);await rename(m.commit.path,m.commitDestination);await syncDir(m.dirs[0]);}
 await hooks.stage?.('committed',intentPath);
 await unlink(guard); await syncDir(m.dirs[0]);
}
/** Ordinary forward recovery reuses exactly the prepared inodes and verified
 * backups. Unknown current files, source/native edits or forged checkpoints fail. */
export async function recoverGlobalConversations(intentPath: string, hooks: CohortHooks) {
 await hooks.assertStopped(); const m=await loadIntent(intentPath),held=await lock(m.options,hooks);
 try {await completeGlobalLocked(m,intentPath,hooks);return {installed:true};} finally {held.release();}
}
/** Guarded rollback never copies an old backup over post-cutover writes.
 * Original sources were retained; roll back routing then park ONLY the exact
 * installed imported inodes. Keep clocks advanced, preventing sequence reuse. */
export async function rollbackGlobalConversations(intentPath: string, hooks: CohortHooks) {
 await hooks.assertStopped();const m=await loadIntent(intentPath),held=await lock(m.options,hooks);
 try {
  if(!m.commit) throw new Error('cohort-not-staged');
  const rollbackPath=join(m.artifact,'rollback.json'), continuing=!await absent(rollbackPath);
  await validateKept(m,true); await expectedHomeFiles(m,true,continuing);
  for(const member of m.members) {
   await requireMatch(member.log,await matches(member.log,member.destination,true)?member.destination:member.log.path+'.rollback',true);
   if(!member.checkpoint) throw new Error('cohort-not-staged');
   await requireMatch(member.checkpoint,await matches(member.checkpoint,member.checkpointDestination,true)?member.checkpointDestination:member.checkpoint.path+'.rollback',true);
  }
  for(const copy of m.nativeCopies) await requireMatch(copy.staged,await matches(copy.staged,copy.destination,true)?copy.destination:copy.staged.path+'.rollback',true);
  const parkedCommit=m.commit.path+'.rollback';
  await requireMatch(m.commit,await absent(m.commitDestination)?parkedCommit:m.commitDestination,true);
  // Full checks finish before changing routing. If interrupted, the same
  // rollback journal/guard resumes recognized parked states only.
  if(!continuing) await writeNew(rollbackPath,JSON.stringify({intent:intentPath})+'\n');
  else if(await readFile(rollbackPath,'utf8')!==JSON.stringify({intent:intentPath})+'\n') throw new Error('rollback-journal-changed');
  const guard=await maintenance(m,intentPath);await hooks.stage?.('rollback-started',intentPath);
  await validateKept(m,true);
  for(const member of m.members) {
   await requireMatch(member.log,await matches(member.log,member.destination,true)?member.destination:member.log.path+'.rollback',true);
   await requireMatch(member.checkpoint!,await matches(member.checkpoint!,member.checkpointDestination,true)?member.checkpointDestination:member.checkpoint!.path+'.rollback',true);
  }
  for(const copy of m.nativeCopies) await requireMatch(copy.staged,await matches(copy.staged,copy.destination,true)?copy.destination:copy.staged.path+'.rollback',true);
  if(!await absent(m.commitDestination)) {await requireMatch(m.commit,m.commitDestination,true);await rename(m.commitDestination,parkedCommit);await syncDir(m.dirs[0]);}
  for(const member of m.members) {
   if(await matches(member.log,member.destination,true)) {await requireMatch(member.log,member.destination,true);await rename(member.destination,member.log.path+'.rollback');await syncDir(m.dirs[0]);}
   if(await matches(member.checkpoint!,member.checkpointDestination,true)) {await requireMatch(member.checkpoint!,member.checkpointDestination,true);await rename(member.checkpointDestination,member.checkpoint!.path+'.rollback');await syncDir(m.dirs[0]);}
   await hooks.stage?.('rollback-member',intentPath);
  }
  for(const copy of m.nativeCopies) if(await matches(copy.staged,copy.destination,true)){await requireMatch(copy.staged,copy.destination,true);await rename(copy.destination,copy.staged.path+'.rollback');await syncDir(dirname(copy.destination));}
  for(const r of m.replacements) {
   if(!await absent(r.original.path)) {
    // A recovery after restoration recognizes ONLY the original inode.
    await requireMatch(r.original,r.original.path,true);
   } else {await requireMatch(r.original,r.parked,true);await rename(r.parked,r.original.path);await syncDir(dirname(r.original.path));await hooks.stage?.('original-restored',intentPath);}
  }
  await unlink(guard);await syncDir(m.dirs[0]);return {rolledBack:true};
 } finally {held.release();}
}
