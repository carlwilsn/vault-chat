import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,copyFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {recordingPlan,encodeRecording,combinedFailure} from './native-recording.mjs';
const frame=(i,t)=>({file:`frame-${String(i).padStart(6,'0')}.jpg`,timestamp:t});
const frames=[frame(0,100.2),frame(1,100),frame(2,100),frame(3,100.137)];
assert.throws(()=>frames.map((f,i)=>{if(i+1<frames.length)assert.ok(frames[i+1].timestamp-f.timestamp>0);}));
const plan=recordingPlan(frames);
assert.deepEqual(plan.groups.map(g=>g.members.map(m=>m.arrivalIndex)),[[1,2],[3],[0]]);
assert.deepEqual(plan.groups.map(g=>g.ptsUs),['0','137000','200000']);
assert.equal(plan.groups.at(-1).durationUs,null);
assert.throws(()=>recordingPlan([frame(0,NaN),frame(1,2)]));
assert.throws(()=>recordingPlan([frame(0,undefined),frame(1,2)]));
assert.throws(()=>recordingPlan([frame(0,1),frame(1,Infinity)]));
const primary=new Error('PRIMARY selector timeout'),teardown=new Error('SECONDARY recording timestamp');
const both=combinedFailure(primary,[teardown]);assert.ok(both instanceof AggregateError);assert.deepEqual(both.errors,[primary,teardown]);assert.match(both.message,/PRIMARY selector timeout/);assert.match(both.message,/SECONDARY recording timestamp/);assert.equal(combinedFailure(primary,[]),primary);
// Explicit codec control: borrowed JPG bytes, synthetic timing; NOT a UI recording.
// Planning controls above require no browser/ffmpeg.
if(process.env.VC_STARTUP_RECORDING) {
const out=mkdtempSync(join(process.env.TMPDIR??'/tmp','record-preflight.'));
for(let i=0;i<frames.length;i++)copyFileSync(join(process.env.VC_STARTUP_RECORDING,frames[i].file),join(out,frames[i].file));
writeFileSync(join(out,'frames.json'),JSON.stringify(frames));
const result=encodeRecording(out,join(out,'derived'),process.env.VC_TEST_FFMPEG);
assert.equal(result.rawFrames,4);assert.equal(result.presentationFrames,3);assert.equal(result.equalGroups,1);
assert.match(readFileSync(join(out,'derived/capture.ffconcat'),'utf8'),/duration 0.137000/);
console.log(JSON.stringify({ok:true,oldRecorderFails:true,stableInversionAndEqualGroup:true,allImagesRepresented:true,finiteActualTimestamps:true,aggregateKeepsBoth:true,result}));

} else console.log(JSON.stringify({ok:true,planningControls:true,encodingExecuted:false}));
