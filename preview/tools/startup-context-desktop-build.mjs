// Plain Node build child only: no tsx/provider/recorder/native SDK import graph.
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {previewPlugin} from '../plugin.mjs';
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,readdirSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {getHeapStatistics} from 'node:v8';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const out=process.env.VC_UI_OUT,pin=process.env.VC_REV;
if(!out?.startsWith('/tmp/')||execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==pin)throw Error('build pins');
mkdirSync(out,{recursive:true});
const stages=join(out,'desktop-build-stages.jsonl');
const receipt=(stage,extra={})=>{const r={at:new Date().toISOString(),pid:process.pid,stage,memory:process.memoryUsage(),heapLimit:getHeapStatistics().heap_size_limit,...extra};appendFileSync(stages,JSON.stringify(r)+'\n');console.log(JSON.stringify(r));};
let transformed=0,parsed=0;const large=[];
// Vite starts ?worker and new-URL bundles concurrently, including duplicate entries.
// Bound build lifecycle only: preserve every real worker and its normal transforms.
let workerTail=Promise.resolve();
const serialize=process.env.VC_PROOF_SERIAL_WORKERS==='1';
receipt('plain-node-imports-ready',{root,pin,execArgv:process.execArgv});
const timer=setInterval(()=>receipt('build-heartbeat',{transformed,parsed}),3000);timer.unref();
try{
 await build({root,configFile:false,base:'/',logLevel:'info',cacheDir:join(out,'vite-cache'),
 plugins:[react(),previewPlugin({side:'before',tree:root,label:'Queue 1 — private actual server / native pi',base:'/'}),{
 name:'proof-build-stage-receipts',
 configResolved(c){receipt('config-resolved',{sourcemap:c.build.sourcemap,minify:c.build.minify,target:c.build.target,preserveSymlinks:c.resolve.preserveSymlinks});},
 buildStart(){receipt('rollup-build-start');},
 transform(code,id){transformed++;if(code.length>500000){large.push({id,bytes:code.length});receipt('large-module',{id,bytes:code.length});}if(transformed%200===0)receipt('transform-progress',{transformed,parsed,id});return null;},
 moduleParsed(m){parsed++;if(parsed%400===0)receipt('parse-progress',{transformed,parsed,id:m.id});},
 buildEnd(error){receipt('rollup-build-end',{transformed,parsed,error:error?String(error):null,large});},
 renderStart(){receipt('render-start',{transformed,parsed});},
 generateBundle(_,bundle){receipt('generate-bundle',{outputs:Object.keys(bundle).length});},
 closeBundle(){receipt('close-bundle');}
 }],define:{__APP_REVISION__:JSON.stringify(pin),__APP_VERSION__:JSON.stringify(JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version)},
 worker:{plugins:()=>{let entry,modules=0,release;return [{name:'proof-worker-stages',async buildStart(options){entry=options.input;receipt('worker-build-requested',{entry,serialize});if(serialize){const previous=workerTail;workerTail=new Promise(done=>{release=done;});await previous;}receipt('worker-build-start',{entry,serialize});},transform(code,id){modules++;if(code.length>500000)receipt('worker-large-module',{entry,id,bytes:code.length});return null;},buildEnd(error){receipt('worker-build-end',{entry,modules,error:error?String(error):null});},renderStart(){receipt('worker-render-start',{entry,modules});},closeBundle(){receipt('worker-close-bundle',{entry,modules});release?.();}}];}},
 build:{outDir:join(out,'desktop-production'),emptyOutDir:true,chunkSizeWarningLimit:1800}});
 const files={};const desktop=join(out,'desktop-production');function walk(dir,prefix=''){for(const name of readdirSync(dir)){const rel=prefix+name,path=join(dir,name);if(statSync(path).isDirectory())walk(path,rel+'/');else files[rel]=createHash('sha256').update(readFileSync(path)).digest('hex');}}walk(desktop);
 writeFileSync(join(out,'desktop-build-receipt.json'),JSON.stringify({pin,root,pid:process.pid,ok:true,serialize,files,at:new Date().toISOString()},null,2));receipt('build-success');
}catch(e){receipt('build-failure',{error:String(e)});throw e;}finally{clearInterval(timer);}
