// Serves a tree's real phone page (src-tauri/assets/phone.html) at /phone with
// serve-time substitutions only — the page's own code and markup are not
// edited, following scripts/make-phone-demo.mjs:
//   • mock mode forced on, and the built-in MockDB replaced by one built from
//     the scenario (window.__VC_PREVIEW_DB__, scenarios/phone.ts);
//   • the CDN pieces made local so the preview never touches the network:
//     KaTeX from node_modules, the Tailwind Play CDN replaced by the same
//     config compiled with the tree's tailwindcss, and the in-browser Babel
//     TypeScript strip replaced by esbuild at serve time;
//   • a network wall and error reporting, like the desktop boot.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const cssCache = new Map();
const fileUrl = (p) => "file:///" + p.replace(/\\/g, "/");

async function compileTailwind(tree, html, configSrc) {
  const key = createHash("sha1").update(tree + html).digest("hex");
  if (cssCache.has(key)) return cssCache.get(key);
  const req = createRequire(resolve(tree, "package.json"));
  const postcss = (await import(fileUrl(req.resolve("postcss")))).default;
  const tw = (await import(fileUrl(req.resolve("tailwindcss")))).default;
  // The page sets `tailwind.config = {...}` — evaluate that object literal.
  const m = /tailwind\.config\s*=\s*(\{[\s\S]*?\});\s*<\/script>/.exec(configSrc);
  const config = m ? new Function(`return (${m[1]})`)() : {};
  const out = await postcss([tw({ ...config, content: [{ raw: html, extension: "html" }] })]).process("@tailwind components;\n@tailwind utilities;", { from: undefined });
  cssCache.set(key, out.css);
  return out.css;
}

function guardScript(scenario, side) {
  return `<script>
(function(){
  var report=function(kind,text){try{parent.postMessage({source:"vc-preview",type:"report",kind:kind,text:text,href:location.href},"*")}catch(e){}};
  window.__previewPhone={scenario:${JSON.stringify(scenario)},side:${JSON.stringify(side)},refused:[]};
  var same=function(u){try{var x=new URL(String(u),location.href);return x.origin===location.origin||x.protocol==="data:"||x.protocol==="blob:"}catch(e){return true}};
  var f=window.fetch.bind(window);
  window.fetch=function(i,o){var u=i&&i.url?i.url:String(i);if(!same(u)){window.__previewPhone.refused.push(u);console.error("[preview] outbound fetch refused: "+u);report("refused","phone fetch "+u);return Promise.reject(new TypeError("preview: outbound refused"))}return f(i,o)};
  window.WebSocket=function(u){report("refused","phone websocket "+u);throw new TypeError("preview: websocket refused")};
  if(navigator.serviceWorker){try{navigator.serviceWorker.register=function(){return Promise.reject(new Error("preview: no service worker"))}}catch(e){}}
  window.addEventListener("error",function(e){report("error",String(e.message))});
})();
</script>`;
}

export async function renderPhone({ tree, server, scenario, side, scenariosEntry, phoneVariant }) {
  const mod = await server.ssrLoadModule(scenariosEntry);
  const phoneMod = await server.ssrLoadModule(scenariosEntry.replace(/index\.ts$/, "phone.ts"));
  const sc = mod.scenarios.find((s) => s.id === scenario) ?? mod.scenarios[0];
  const db = phoneMod.phoneDB(sc, Date.now());

  // 5. Wall + DB + page selection.
  const clicks = [...(sc.phone?.page ? [`.mrow[data-page="${sc.phone.page}"]`] : []), ...(sc.phone?.clicks ?? [])];
  const head = guardScript(sc.id, side) + `<script>window.__VC_PREVIEW_DB__ = ${JSON.stringify(db).replace(/</g, "\\u003c")};</script>`;
  // Drive the page to the scenario's screen with real clicks ("text:Foo" =
  // the innermost visible element whose text is Foo).
  const driver = `<script>(function(){var cl=${JSON.stringify(clicks)};
  function find(s){if(s.indexOf("text:")===0){var t=s.slice(5);var all=[].slice.call(document.querySelectorAll("body *")).filter(function(e){return e.offsetParent});var ex=all.filter(function(e){return e.textContent.trim()===t});if(ex.length)return ex[ex.length-1];var pre=all.filter(function(e){return e.textContent.trim().indexOf(t)===0});return pre[pre.length-1]||null}return document.querySelector(s)}
  var i=0;function step(n){if(i>=cl.length){window.__previewPhone.ready=true;return}var e=find(cl[i]);if(e){e.click();i++;setTimeout(function(){step(0)},450)}else if(n<40)setTimeout(function(){step(n+1)},150);else{window.__previewPhone.ready=true;window.__previewPhone.stepError="not found: "+cl[i]}}
  setTimeout(function(){step(0)},700)})();</script>`;
  // A tree with the bundled phone app (phone/) renders it through its own hook;
  // ?phone=classic keeps the old page.
  const hook = join(tree, "phone", "preview.mjs");
  if (existsSync(hook) && phoneVariant !== "classic") return (await import(fileUrl(hook))).renderPhoneApp({ head, tail: driver });
  let html = readFileSync(join(tree, "src-tauri", "assets", "phone.html"), "utf8");

  const must = (cond, what) => {
    if (!cond) throw new Error(`preview: phone.html changed shape — ${what} not found (update preview/phone.mjs)`);
  };

  // 1. Mock on, scenario DB in.
  const MOCK = 'const MOCK = qs.get("mock") === "1";';
  must(html.includes(MOCK), "the MOCK line");
  html = html.replace(MOCK, "const MOCK = true; // preview: mock forced on");
  const DBLINE = "const DB: MockDB = {";
  must(html.includes(DBLINE), "`const DB: MockDB = {`");
  html = html.replace(DBLINE, "const DB: MockDB = (window as any).__VC_PREVIEW_DB__ || {");

  // 2. KaTeX from node_modules.
  html = html.replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/katex@[\d.]+\/dist\//g, "/__vendor/katex/").replace(/ crossorigin="anonymous"/g, "");

  // 3. Tailwind Play CDN → compiled CSS with the page's own config.
  const twTag = '<script src="https://cdn.tailwindcss.com"></script>';
  const twStart = html.indexOf(twTag);
  must(twStart >= 0, "the Tailwind CDN script");
  const cfgEnd = html.indexOf("</script>", html.indexOf("tailwind.config", twStart)) + "</script>".length;
  const css = await compileTailwind(tree, html, html.slice(twStart, cfgEnd));
  html = html.slice(0, twStart) + `<style id="vc-preview-tailwind">\n${css}\n</style>` + html.slice(cfgEnd);

  // 4. TypeScript: strip with esbuild here instead of Babel-from-CDN in the page.
  const tsOpen = '<script id="phone-ts" type="text/typescript">';
  const tsStart = html.indexOf(tsOpen);
  must(tsStart >= 0, "the phone-ts block");
  const tsEnd = html.indexOf("</script>", tsStart);
  const ts = html.slice(tsStart + tsOpen.length, tsEnd);
  const req = createRequire(resolve(tree, "package.json"));
  const esbuild = await import(fileUrl(req.resolve("esbuild")));
  const js = (await esbuild.transform(ts, { loader: "ts", target: "es2022", sourcefile: "phone.ts" })).code;
  const bootIdx = html.indexOf("/* TypeScript bootstrap.");
  must(bootIdx >= 0, "the TypeScript bootstrap");
  const bootOpen = html.lastIndexOf("<script>", bootIdx);
  const bootClose = html.indexOf("</script>", bootIdx) + "</script>".length;
  html = html.slice(0, bootOpen) + `<script>\n${js.replace(/<\/script/gi, "<\\/script")}\n//# sourceURL=phone.ts\n</script>` + html.slice(bootClose);

  html = html.replace(/<head>/i, `<head>\n${head}`);
  html = html.replace(/<\/body>/i, `${driver}</body>`);
  return html;
}
