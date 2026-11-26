// Carl's input in a page, recorded by the page itself with no code of the page's own: one recorder, put in every kind
// of page the app shows. A vault .html page (src/liveBridge.ts PAGE_SCRIPT) saves it as its `_input` state; a dev
// server's page in a viewer pane (server/devProxy.ts frameScript) posts it to the app; a public page in the native view
// (src/webDrive.ts inputInstallScript) keeps it for the pane to collect. The app shows the last two under the workspace
// noun (box:workspace state `input`, src/layoutTypes.ts PageInput), so the agent reads and watches what Carl does there.
//
// What it records: the page's form fields now, and his last clicks, picks (change), typing (one entry per field per
// burst), key presses that are not typing (Enter, Escape, arrows, shortcuts; a repeat counts up), drags (pointer down,
// moves, up: from / to, how far, onto what) and drops, form submits and text he selected. Only real input
// (event.isTrusted): a page's own synthetic events are not his. The agent's own step in a public page
// (src/webDrive.ts sets window.__vcAgentStep while it runs) is recorded by: "agent". Never a password, hidden, one-time-code or card field, a
// field whose name says secret / token / key / pin, nor anything inside [data-vc-private]: not its value, not its keys.

/** Under this state key a vault page keeps it (PluginRead {plugin: <page>} reads it, `wait` follows it). */
export const PAGE_INPUT_KEY = "_input";
export const PAGE_INPUT_LIMITS = {
  /** The last interactions kept. */
  recent: 12,
  /** The most form fields in one record. */
  fields: 40,
  /** An element's text, at most. */
  text: 80,
  /** A field's value (or a text selection), at most. */
  value: 200,
} as const;

/**
 * The recorder, as a plain ES5 expression (no build step: it runs inside any page) that starts it and evaluates to
 * {flush, note}. `save` is an expression for a function given each record ({fields, recent, at, selection?}) after a
 * burst; `ready` one for a function saying whether saving may happen now (a record waits, dirty, until it may: flush()
 * saves it then). note(what, el, extra) adds an entry by hand (the agent's own step in a page: extra.by "agent").
 */
export function inputRecorderJs(save: string, ready = "function(){return true;}"): string {
  return String.raw`(function(save,ready){
var L=${JSON.stringify(PAGE_INPUT_LIMITS)},recent=[],dirty=false,timer=0,lastSel="",down=null,dragAt=0,dragEl=null;
var SECRET=/pass|secret|token|api.?key|otp|\bpin\b|cvv|cvc|ssn|card.?num|credit/i,FIELD={INPUT:1,SELECT:1,TEXTAREA:1},MODS={Shift:1,Control:1,Alt:1,Meta:1,AltGraph:1,CapsLock:1};
var CLICKABLE="a,button,input,select,textarea,label,summary,option,[role=button],[role=option],[role=tab],[role=radio],[role=checkbox],[role=menuitem],[role=link],[onclick],[data-value],[tabindex]";
function txt(v,n){v=String(v==null?"":v).replace(/\s+/g," ").trim();return v.length>n?v.slice(0,n)+"\u2026":v;}
function secret(el){
  if(!el||el.nodeType!==1)return true;
  if(el.closest&&el.closest("[data-vc-private]"))return true;
  var t=String(el.getAttribute("type")||"").toLowerCase();
  if(t==="password"||t==="hidden")return true;
  if(/password|one-time-code|cc-/i.test(el.getAttribute("autocomplete")||""))return true;
  return SECRET.test((el.getAttribute("name")||"")+" "+(el.id||""));
}
function labelOf(el){
  try{if(el.labels&&el.labels.length)return txt(el.labels[0].innerText||el.labels[0].textContent,L.text);}catch(e){}
  var a=el.getAttribute("aria-label")||el.getAttribute("title")||el.getAttribute("placeholder");
  return a?txt(a,L.text):"";
}
function valueOf(el){
  var t=String(el.type||"").toLowerCase();
  if(el.tagName==="SELECT"){var o=[].filter.call(el.selectedOptions||el.querySelectorAll("option"),function(x){return x.selected||x.hasAttribute("selected");}).map(function(x){var s=txt(x.text||x.textContent,L.text);return s&&s!==x.value?s+" ("+txt(x.value,L.text)+")":txt(x.value,L.value);});return el.multiple?o:(o.length?o[0]:"");}
  if(t==="checkbox")return !!el.checked;
  if(t==="radio")return el.checked?txt(el.value,L.value):undefined;
  if(t==="file")return [].slice.call(el.files||[]).map(function(f){return f.name;}).join(", ");
  if(t==="submit"||t==="button"||t==="reset"||t==="image")return undefined;
  if(el.tagName==="INPUT"||el.tagName==="TEXTAREA")return String(el.value).length>L.value?String(el.value).slice(0,L.value)+"\u2026":String(el.value);
  return undefined;
}
function fields(){
  var out={},n=0,els=document.querySelectorAll("input,select,textarea");
  for(var i=0;i<els.length&&n<L.fields;i++){
    var el=els[i];if(secret(el))continue;var v=valueOf(el);if(v===undefined)continue;
    var k=(String(el.type).toLowerCase()==="radio"&&el.getAttribute("name"))||el.id||el.getAttribute("name")||(el.tagName.toLowerCase()+(i+1));
    out[k]=v;n++;
  }
  return out;
}
function target(el){
  if(el&&el.nodeType!==1)el=el.parentElement;
  if(!el||!el.closest)return null;
  var c=el.closest(CLICKABLE);if(c)return c;
  var best=null,x=el;
  for(var i=0;x&&x!==document.body&&x!==document.documentElement&&i<8;i++,x=x.parentElement){try{if(getComputedStyle(x).cursor==="pointer")best=x;}catch(e){}}
  return best||el;
}
function describe(el){
  var d={el:el.tagName.toLowerCase()};
  if(el.id)d.id=el.id;
  var nm=el.getAttribute("name");if(nm)d.name=nm;
  var cls=typeof el.className==="string"?el.className.trim().split(/\s+/).slice(0,3).join(" "):"";if(cls)d.class=cls;
  var t=FIELD[el.tagName]||secret(el)?"":txt(el.innerText||el.textContent,L.text);if(t)d.text=t;
  var l=labelOf(el);if(l&&l!==t)d.label=l;
  var dv=el.getAttribute("data-value");if(dv)d.data=txt(dv,L.text);
  return d;
}
function named(el){var d=describe(el);return d.text||d.label||d.data||(d.id?"#"+d.id:d.el+(d.class?"."+d.class.split(" ")[0]:""));}
function flush(){
  if(!dirty||!ready())return;
  dirty=false;
  var rec={fields:fields(),recent:recent.slice(),at:new Date().toISOString()};if(lastSel)rec.selection=lastSel;
  try{save(rec);}catch(e){}
}
function agent(){return !!window.__vcAgentStep;}
function real(e){return e.isTrusted||agent();}
function same(a,b){return a&&a.what===b.what&&a.el===b.el&&a.id===b.id&&a.name===b.name&&a.by===b.by;}
function note(what,el,extra){
  if(!el||el.nodeType!==1)el=document.body||document.documentElement;
  var r=describe(el);r.what=what;r.by=agent()?"agent":"Carl";if(extra)for(var k in extra)r[k]=extra[k];r.at=new Date().toISOString();
  var last=recent[recent.length-1];
  // One entry per burst: typing into one field, and the same key pressed again.
  if(same(last,r)&&what==="input")recent[recent.length-1]=r;
  else if(same(last,r)&&what==="key"&&last.key===r.key){r.n=(last.n||1)+1;recent[recent.length-1]=r;}
  else recent.push(r);
  if(recent.length>L.recent)recent.splice(0,recent.length-L.recent);
  dirty=true;clearTimeout(timer);timer=setTimeout(flush,what==="input"?800:250);
}
addEventListener("click",function(e){
  if(!real(e)||Date.now()-dragAt<400)return;var el=target(e.target);
  // A field speaks through its change (its value); a click into it is only focus.
  if(!el||FIELD[el.tagName])return;
  note("click",el,null);
},true);
addEventListener("change",function(e){if(!real(e))return;var el=e.target;if(!el||el.nodeType!==1||secret(el))return;var v=valueOf(el);note("change",el,v===undefined?null:{value:v});},true);
addEventListener("input",function(e){
  if(!real(e))return;var el=e.target;if(!el||el.nodeType!==1||secret(el))return;
  var t=String(el.type||"").toLowerCase();if(el.tagName==="SELECT"||t==="checkbox"||t==="radio")return;
  var v=valueOf(el);note("input",el,v===undefined?null:{value:v});
},true);
addEventListener("submit",function(e){var el=e.target;if(real(e)&&el&&el.nodeType===1&&!secret(el))note("submit",el,null);},true);
// Keys that are not typing: typing into a field is its input entry; nothing from a secret field.
addEventListener("keydown",function(e){
  if(!real(e))return;var k=e.key;if(!k||MODS[k]||k==="Unidentified"||k==="Dead"||k==="Process")return;
  var el=e.target&&e.target.nodeType===1?e.target:document.activeElement,mod=e.ctrlKey||e.metaKey||e.altKey;
  var field=el&&(FIELD[el.tagName]||el.isContentEditable);
  if(field&&secret(el))return;
  if(field&&!mod&&(k.length===1||k==="Backspace"||k==="Delete"))return;
  note("key",el,{key:(e.ctrlKey?"Control+":"")+(e.metaKey?"Meta+":"")+(e.altKey?"Alt+":"")+(e.shiftKey&&(k.length>1||mod)?"Shift+":"")+(k===" "?"Space":k.length===1&&mod?k.toUpperCase():k)});
},true);
// A drag, summarised: where the pointer went down and came up, how far, how long, how many moves, and onto what.
function at(x,y){return [Math.round(x),Math.round(y)];}
addEventListener("pointerdown",function(e){if(!e.isTrusted||e.button>0)return;down={x:e.clientX,y:e.clientY,t:Date.now(),el:target(e.target),m:0};},true);
addEventListener("pointermove",function(e){if(down&&e.isTrusted)down.m++;},true);
addEventListener("pointerup",function(e){
  var d=down;down=null;if(!d||!e.isTrusted)return;
  var dx=e.clientX-d.x,dy=e.clientY-d.y;if(dx*dx+dy*dy<64)return;
  dragAt=Date.now();
  var x={from:at(d.x,d.y),to:at(e.clientX,e.clientY),ms:dragAt-d.t,moves:d.m},o=null;
  try{o=document.elementFromPoint&&target(document.elementFromPoint(e.clientX,e.clientY));}catch(err){}
  if(o&&o!==d.el)x.onto=named(o);
  note("drag",d.el,x);
},true);
addEventListener("pointercancel",function(){down=null;},true);
// The page's own drag and drop (draggable): the pointer is the browser's then, the drop says where it went.
addEventListener("dragstart",function(e){if(e.isTrusted)dragEl=target(e.target);},true);
addEventListener("drop",function(e){if(!e.isTrusted)return;var o=target(e.target);note("drop",o,dragEl&&dragEl!==o?{dragged:named(dragEl)}:null);dragEl=null;dragAt=Date.now();},true);
function selection(){
  var g=getSelection&&getSelection(),s=g?txt(String(g),L.value):"";
  if(!s||s===lastSel)return;lastSel=s;
  var n=g.anchorNode;if(n&&secret(n.nodeType===1?n:n.parentElement))return;note("selectText",n&&n.nodeType===1?n:(n&&n.parentElement)||document.body,{selected:s});
}
addEventListener("mouseup",function(){setTimeout(selection,0);},true);
addEventListener("keyup",function(e){if(e.shiftKey)selection();},true);
addEventListener("pagehide",function(){clearTimeout(timer);flush();},true);
return {flush:flush,note:note};
})(${save},${ready})`;
}

/** A record a page sent (its word, not trusted to keep the limits): bounded again, as the app keeps it. Null: not one. */
export function pageInputOf(x: unknown): { fields: Record<string, unknown>; recent: Record<string, unknown>[]; selection?: string; at: string } | null {
  if (!x || typeof x !== "object") return null;
  const r = x as { fields?: unknown; recent?: unknown; selection?: unknown; at?: unknown };
  const L = PAGE_INPUT_LIMITS;
  const str = (v: unknown, n: number) => String(v ?? "").slice(0, n + 1);
  const val = (v: unknown): unknown =>
    typeof v === "boolean" || typeof v === "number" ? v : Array.isArray(v) ? v.slice(0, L.fields).map((e) => str(e, L.value)) : str(v, L.value);
  const fields: Record<string, unknown> = {};
  if (r.fields && typeof r.fields === "object") for (const [k, v] of Object.entries(r.fields).slice(0, L.fields)) fields[str(k, L.text)] = val(v);
  const recent = (Array.isArray(r.recent) ? r.recent.slice(-L.recent) : [])
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e))
    .map((e) => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(e).slice(0, 16)) {
        if (k === "from" || k === "to") o[k] = Array.isArray(v) ? v.slice(0, 2).map((n) => Math.round(Number(n) || 0)) : undefined;
        else o[str(k, 20)] = typeof v === "number" || typeof v === "boolean" ? v : val(v);
      }
      return o;
    });
  const at = typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) ? r.at : new Date().toISOString();
  return { fields, recent, ...(typeof r.selection === "string" && r.selection ? { selection: str(r.selection, L.value) } : {}), at };
}
