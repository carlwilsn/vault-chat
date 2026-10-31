// Vite source runner, matching server build/test aliases. Does not listen or build.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { build } from 'esbuild';
import { appProof } from './native-shipment-browser.mjs';
import { previewPlugin } from '../plugin.mjs';
globalThis.__nativeProofModules={createServer,react,build,appProof,previewPlugin};
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inlinedKatexCss } from '../../server/katexCssGen.mjs';
const shim = name => fileURLToPath(new URL('../../server/shims/'+name,import.meta.url));
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:process.env.VC_APP_PROOF_OUT+'/ssr-cache',optimizeDeps:{noDiscovery:true,entries:[]},server:{middlewareMode:true},resolve:{alias:{
 '@tauri-apps/api/core':shim('core.ts'),'@tauri-apps/api/event':shim('event.ts'),'@tauri-apps/api/app':shim('app.ts'),
 '@tauri-apps/api/window':shim('window.ts'),'@tauri-apps/api/webviewWindow':shim('window.ts'),
 '@tauri-apps/plugin-dialog':shim('plugins.ts'),'@tauri-apps/plugin-opener':shim('plugins.ts'),
 '@tauri-apps/plugin-process':shim('plugins.ts'),'@tauri-apps/plugin-updater':shim('plugins.ts'),'@tauri-apps/plugin-autostart':shim('plugins.ts'),
 'pdfjs-dist':shim('pdfjs.ts'),
}},plugins:[{name:'source-http-assets',enforce:'pre',resolveId(id){
 if(id==='vc:phone-app'||id==='vc:board-app'||id==='vc:katex-css')return '\0'+id;
},load(id){
 if(id==='\0vc:phone-app'||id==='\0vc:board-app')return 'export default {};';
 if(id==='\0vc:katex-css')return 'export default '+JSON.stringify(inlinedKatexCss(process.cwd()))+';';
 if(/\/src-tauri\/assets\/.*\.(html|png)$/.test(id))return 'export default '+JSON.stringify(readFileSync(id,id.endsWith('.png')?'base64':'utf8'))+';';
}}]});
try{await server.ssrLoadModule('/preview/tools/native-shipment-app.ts');}finally{await server.close();}
