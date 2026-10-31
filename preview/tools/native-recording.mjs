// Proof-helper only. Arrival evidence is immutable; presentation is a separately mapped view.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
export function combinedFailure(primary, others) {
 const failures=[...(primary?[primary]:[]),...others];
 return failures.length>1?new AggregateError(failures,failures.map((e,i)=>`${i===0&&primary?'scenario':'teardown'}: ${e.stack??e}`).join('\n\n')):failures[0];
}
const decimalUs=t=>{assert.equal(typeof t,'number');assert.ok(Number.isFinite(t),'finite actual CDP timestamp required');const s=t.toFixed(6);assert.equal(Number(s),t,'CDP timestamp must be representable in microseconds; never fabricate a fallback');return BigInt(s.replace('.',''));};
const seconds=us=>`${us/1000000n}.${String(us%1000000n).padStart(6,'0')}`;
export function recordingPlan(frames) {
 assert.ok(frames.length>1);
 const arrival=frames.map((f,i)=>{assert.match(f.file,/^frame-\d{6}\.jpg$/);return {...f,arrivalIndex:i,us:decimalUs(f.timestamp)};});
 const ordered=[...arrival].sort((a,b)=>a.us<b.us?-1:a.us>b.us?1:a.arrivalIndex-b.arrivalIndex);
 const groups=[];
 for(const f of ordered){let g=groups.at(-1);if(!g||g.us!==f.us){g={us:f.us,timestamp:f.timestamp,members:[]};groups.push(g);}g.members.push({file:f.file,arrivalIndex:f.arrivalIndex,timestamp:f.timestamp});}
 assert.ok(groups.length>1,'recording needs a measured positive time span');
 const origin=groups[0].us;
 return {nativeArrivalFrames:frames.length,arrivalInversions:arrival.flatMap((f,i)=>i&&f.us<arrival[i-1].us?[{previousIndex:i-1,index:i,previousTimestamp:arrival[i-1].timestamp,timestamp:f.timestamp}]:[]),groups:groups.map((g,i)=>({timestamp:g.timestamp,ptsUs:String(g.us-origin),durationUs:i+1<groups.length?String(groups[i+1].us-g.us):null,members:g.members})),policy:'Stable measured-timestamp order, arrival index breaks ties. Every equal-timestamp image is shown simultaneously left-to-right in an explicitly derived contact sheet; no frame omitted and no invented timing. No last-frame hold: recording ends at last measured presentation timestamp (codec terminal packet may be one microsecond). Raw arrival order and JPGs remain separate and unchanged.'};
}
export function encodeRecording(rawDir,outputDir,ffmpeg) {
 assert.notEqual(resolve(rawDir),resolve(outputDir),'derived output must never overwrite raw capture');
 mkdirSync(outputDir); // Refuse any pre-existing derived output; never overwrite a prior recording.
 const frames=JSON.parse(readFileSync(join(rawDir,'frames.json'),'utf8')),plan=recordingPlan(frames);
 const ffprobe=join(dirname(ffmpeg),'ffprobe');
 const first=JSON.parse(execFileSync(ffprobe,['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',join(rawDir,frames[0].file)],{encoding:'utf8'})).streams[0];
 const maxGroup=Math.max(...plan.groups.map(g=>g.members.length));
 const w=Math.ceil(first.width*maxGroup/2)*2,h=Math.ceil(first.height/2)*2;
 const manifest=['ffconcat version 1.0'];
 for(const [i,g] of plan.groups.entries()){
  let file=join(rawDir,g.members[0].file);
  if(g.members.length>1){
   file=join(outputDir,`equal-timestamp-${String(i).padStart(6,'0')}.jpg`);
   execFileSync(ffmpeg,['-nostdin','-hide_banner','-loglevel','error',...g.members.flatMap(m=>['-i',join(rawDir,m.file)]),'-filter_complex',`hstack=inputs=${g.members.length}`,'-frames:v','1','-update','1',file]);
  }
  assert.ok(!file.includes("'"));g.presentationFile=file;
  manifest.push(`file '${file}'`,'option framerate 1000000');
  if(g.durationUs!==null)manifest.push(`duration ${seconds(BigInt(g.durationUs))}`);
 }
 writeFileSync(join(outputDir,'presentation.json'),JSON.stringify(plan,null,2));
 const concat=join(outputDir,'capture.ffconcat');writeFileSync(concat,manifest.join('\n')+'\n');
 const video=join(outputDir,'proof.mp4');
 execFileSync(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',concat,'-an','-fps_mode','passthrough','-enc_time_base','1:1000000','-vf',`pad=${w}:${h}:0:0`,'-c:v','libx264','-bf','0','-threads','1','-pix_fmt','yuv420p','-video_track_timescale','1000000','-movflags','+faststart',video]);
 const decoded=JSON.parse(execFileSync(ffprobe,['-v','error','-select_streams','v:0','-show_entries','frame=pts','-of','json',video],{encoding:'utf8',maxBuffer:10*1024*1024})).frames;
 assert.equal(decoded.length,plan.groups.length,'every presentation group encoded');
 assert.deepEqual(decoded.map(f=>String(f.pts)),plan.groups.map(g=>g.ptsUs),'encoded presentation matches actual timestamps exactly, no muxer timing invention');
 const receipt={ok:true,rawDir,outputDir,rawFrames:frames.length,presentationFrames:decoded.length,equalGroups:plan.groups.filter(g=>g.members.length>1).length,arrivalInversions:plan.arrivalInversions.length,spanUs:plan.groups.at(-1).ptsUs,video,policy:plan.policy};
 writeFileSync(join(outputDir,'encoding-receipt.json'),JSON.stringify(receipt,null,2));return receipt;
}
