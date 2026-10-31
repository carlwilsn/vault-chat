// Source HTTP dev entry: the same asset/shim resolutions as server/build.mjs.
// No route replacement. Phone/board builds are absent and are NOT proof targets.
import { readFile } from 'node:fs/promises';
const module = source => ({url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true});
const shims = {
 '@tauri-apps/api/core':'core.ts','@tauri-apps/api/event':'event.ts','@tauri-apps/api/app':'app.ts',
 '@tauri-apps/api/window':'window.ts','@tauri-apps/api/webviewWindow':'window.ts',
 '@tauri-apps/plugin-dialog':'plugins.ts','@tauri-apps/plugin-opener':'plugins.ts',
 '@tauri-apps/plugin-process':'plugins.ts','@tauri-apps/plugin-updater':'plugins.ts','@tauri-apps/plugin-autostart':'plugins.ts',
 'pdfjs-dist':'pdfjs.ts',
};
export async function resolve(specifier,context,next){
 if(specifier in shims)return next(new URL('../../server/shims/'+shims[specifier],import.meta.url).href,context);
 if(specifier==='vc:phone-app'||specifier==='vc:board-app')return module('export default {};');
 if(specifier==='vc:katex-css'){
  const {inlinedKatexCss}=await import('../../server/katexCssGen.mjs');
  return module('export default '+JSON.stringify(inlinedKatexCss(new URL('../..',import.meta.url).pathname))+';');
 }
 if(specifier.endsWith('?url'))return module("export default '';");
 if(specifier.endsWith('.css'))return module("export default '';");
 if(specifier.endsWith('.html')||specifier.endsWith('?raw')){
  const file=new URL(specifier.replace(/\?raw$/,''),context.parentURL);
  return module('export default '+JSON.stringify(await readFile(file,'utf8'))+';');
 }
 if(specifier.endsWith('.png'))return module('export default '+JSON.stringify((await readFile(new URL(specifier,context.parentURL))).toString('base64'))+';');
 return next(specifier,context);
}
export async function load(url,context,next){
 const out=await next(url,context);
 if(url.includes('/src/')&&!url.includes('/node_modules/')&&out.source!=null){
  const source=typeof out.source==='string'?out.source:new TextDecoder().decode(out.source);
  return {...out,source:'if (!import.meta.env) import.meta.env={DEV:false,PROD:true,MODE:"test"};\n'+source};
 }
 return out;
}
