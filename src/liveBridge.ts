// Live pages: a vault .html page (viewer, inline in a chat, phone) is a sandboxed iframe (scripts, no same-origin,
// no network) that can still be an app. It DECLARES what it needs, Carl grants it once, and it then talks to the box
// through the host app by postMessage, with a short-lived scoped token the box checks on every call.
//
//   page:  <meta name="vc-capabilities" content="ask, mic">       (also: tool:<name or glob>, step 2)
//          vc.fetch(path, init)   → Promise<Response>   the box's own routes, through the host; the box allows only
//                                   what the granted capabilities cover (token scope), nothing else
//          vc.ask(prompt, {system?}) → { [Symbol.asyncIterator] (text deltas), text(), cancel() }
//                                   sugar over vc.fetch + the box's /api/v1/side protocol: an EPHEMERAL read-only
//                                   side session (like Ctrl+L): no chat, no conversation, no writes
//          vc.mic({mimeType?})    → Promise<{ stop(): Promise<Blob>, cancel(), ondata, mimeType }>   (cap: mic)
//          vc.play(blobOrUrl), vc.caps (granted), vc.theme {mode, vars}, vc.size {w,h}, vc.ready, vc.path
//   host:  installLiveBridge(host) once; an iframe takes part by `data-vc-live="<vault path>"`. The host asks the box for
//          the page's manifest + content hash, asks Carl once (remembered per path + hash; a changed page asks again),
//          has the box mint the token, and answers only that iframe's window (event.source, origin "null").

/** Every message either way carries this marker. */
export const LIVE = "vc-live";
export const LIVE_ATTR = "data-vc-live";
export const LIVE_LIMITS = {
  asksPerMinute: 20,
  concurrentFetch: 6,
  promptChars: 20_000,
  systemChars: 8_000,
  /** The most reply text one ask streams to the page. */
  replyChars: 100_000,
  requestBytes: 8 * 1024 * 1024,
  responseBytes: 32 * 1024 * 1024,
  micSeconds: 120,
  micChunkBytes: 1024 * 1024,
  tokenSeconds: 900,
} as const;

/** The CSS variables the app defines (src/App.css): a page's `vc.theme.vars` (HSL triples) and `--name` on its root. */
export const LIVE_THEME_VARS = [
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground",
  "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "destructive",
  "destructive-foreground", "border", "input", "ring", "radius",
] as const;

/** A capability a manifest may name: ask, mic, persist (not yet granted by any box), tool:<name or glob>. */
const CAP_RE = /^(?:ask|mic|persist|tool:[A-Za-z0-9_.*-]{1,80})$/;

/** The capabilities a page declares (`<meta name="vc-capabilities" content="ask, mic">`): normalised, deduped, sorted; none = not a live page. */
export function parseLiveManifest(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\bname\s*=\s*["']?vc-capabilities["']?(?=[\s>/"'])/i.test(tag)) continue;
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    for (const raw of (c?.[1] ?? c?.[2] ?? "").split(/[\s,]+/)) {
      const cap = raw.trim().toLowerCase();
      if (CAP_RE.test(cap)) out.add(cap);
      if (out.size >= 20) break;
    }
  }
  return [...out].sort();
}

/** Whether a tool name is covered by a granted `tool:` capability (exact, or a glob with `*`). */
export function toolAllowed(caps: readonly string[], name: string): boolean {
  return caps.some((c) => {
    if (!c.startsWith("tool:")) return false;
    const g = c.slice(5);
    return g === name || (g.includes("*") && new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(name));
  });
}

/** One line per capability, for the grant prompt. */
export function describeCap(cap: string): string {
  if (cap === "ask") return "Ask the AI questions (read-only; nothing in your vault or chats changes)";
  if (cap === "mic") return "Use your microphone while you press its record button";
  if (cap === "persist") return "Start real conversations in your chat list";
  return `Use the tool ${cap.slice(5)}`;
}

export const LIVE_REQUEST_HEADERS = ["content-type", "accept"];

/** Whether a viewer file is inside the vault (a relative path, or an absolute one under it, no `..`): only those pages get window.vc. */
export function insideVault(path: string | null | undefined, vault: string | null | undefined): boolean {
  if (!path) return false;
  const p = path.replace(/\\/g, "/");
  if (p.split("/").includes("..")) return false;
  if (!/^([a-zA-Z]:)?\//.test(p)) return true;
  const v = (vault ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return !!v && p.toLowerCase().startsWith(v.toLowerCase() + "/");
}

/** A viewer path as the box names it: relative to the vault (an absolute path under it loses the vault's prefix). */
export function vaultRelative(path: string, vault: string | null | undefined): string {
  const p = path.replace(/\\/g, "/");
  const v = (vault ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return v && p.toLowerCase().startsWith(v.toLowerCase() + "/") ? p.slice(v.length + 1) : p;
}

/** The text a page's ask becomes on the box: who is asking (the page), what it wants of the reply, then the prompt. */
export function liveAskText(page: string, system: string, prompt: string): string {
  return (
    `<live-page path=${JSON.stringify(page)}>An interactive page in Carl's vault asks you something through its own UI; your reply goes to that page, not to Carl's chat. ` +
    `You can read but not change anything. Answer the prompt directly.${system.trim() ? `\nThe page's instructions: ${system.trim()}` : ""}</live-page>\n\n${prompt}`
  );
}

/** The host app's only need: a JSON POST to the box (authenticated as the app). */
export type LiveHost = { post(path: string, body: unknown): Promise<{ status: number; json: any }> };

// ---------------------------------------------------------------------------------------------------------------
// The page side: window.vc. Plain script (no build step), injected first in <head> of a page that declares capabilities.

const PAGE_SCRIPT = String.raw`(function(){
if(window.vc)return;
var M=${JSON.stringify(LIVE)},seq=0,wait={},themeFns=[],sizeFns=[],readyFn,helloTimer,tries=0;
var ready=new Promise(function(r){readyFn=r;});
var vc={path:"",caps:[],theme:{mode:"dark",vars:{}},size:{w:innerWidth,h:innerHeight},ready:ready,live:false};
function post(m,tr){m[M]=1;parent.postMessage(m,"*",tr||[]);}
function call(m,tr,on){var id=++seq;m.id=id;wait[id]=on;post(m,tr);return id;}
function apply(m){
  vc.live=true;vc.path=m.path||vc.path;vc.caps=m.caps||[];
  if(m.mode){vc.theme.mode=m.mode;}
  if(m.vars){vc.theme.vars=m.vars;var s=document.documentElement.style;for(var k in m.vars)s.setProperty("--"+k,m.vars[k]);}
  if(m.w){vc.size.w=m.w;vc.size.h=m.h;}
  clearInterval(helloTimer);readyFn(vc);
  for(var i=0;i<themeFns.length;i++)try{themeFns[i](vc.theme);}catch(e){}
  for(var j=0;j<sizeFns.length;j++)try{sizeFns[j](vc.size);}catch(e){}
}
addEventListener("message",function(e){
  var m=e.data;if(e.source!==parent||!m||m[M]!==1)return;
  if(m.ev==="env"){apply(m);return;}
  var f=wait[m.id];if(f)f(m);
});
function hello(){post({op:"hello"});if(++tries>40)clearInterval(helloTimer);}
helloTimer=setInterval(hello,500);hello();
vc.onTheme=function(f){themeFns.push(f);if(vc.live)f(vc.theme);};
vc.onResize=function(f){sizeFns.push(f);};
vc.fetch=async function(path,init){
  init=init||{};var body=init.body,tr=[],bytes=null;
  if(body!=null){
    if(typeof body==="string")bytes=new TextEncoder().encode(body).buffer;
    else if(body instanceof Blob)bytes=await body.arrayBuffer();
    else if(body instanceof URLSearchParams)bytes=new TextEncoder().encode(body.toString()).buffer;
    else if(ArrayBuffer.isView(body))bytes=body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength);
    else if(body instanceof ArrayBuffer)bytes=body.slice(0);
    else throw new TypeError("vc.fetch: body must be a string, Blob, ArrayBuffer, typed array or URLSearchParams");
    tr=[bytes];
  }
  var h={};if(init.headers){new Headers(init.headers).forEach(function(v,k){h[k]=v;});}
  await ready;
  return new Promise(function(res,rej){
    var id=call({op:"fetch",path:String(path),method:String(init.method||"GET").toUpperCase(),headers:h,body:bytes},tr,function(m){
      delete wait[id];
      if(m.ev==="error")rej(new Error(m.error||"vc.fetch failed"));
      else{var nb=m.status===204||m.status===205||m.status===304;res(new Response(nb?null:m.body,{status:m.status,headers:m.headers}));}
    });
  });
};
vc.ask=function(prompt,o){
  o=o||{};var cancelled=false,sid=null,full="";
  var json={"content-type":"application/json"};
  async function* run(){
    var r=await vc.fetch("/api/v1/side",{method:"POST",headers:json,body:JSON.stringify({text:String(prompt),system:o.system==null?"":String(o.system),persist:!!o.persist})});
    var j=await r.json().catch(function(){return {};});
    if(!r.ok||!j.id)throw new Error(j.error||("ask failed ("+r.status+")"));
    sid=j.id;var v=Number(j.v||0),last="";
    while(!cancelled){
      var g=await vc.fetch("/api/v1/side/"+encodeURIComponent(sid)+"?after="+v+"&wait=20000");
      var s=await g.json().catch(function(){return {};});
      if(!g.ok)throw new Error(s.error||("ask failed ("+g.status+")"));
      v=Number(s.v==null?v:s.v);var t=String(s.text||"");
      if(t!==last){yield (t.indexOf(last)===0?t.slice(last.length):t);last=t;full=t;}
      if(s.done){if(s.error)throw new Error(String(s.error));return;}
    }
  }
  var gen=run();
  function cancel(){if(cancelled)return;cancelled=true;if(sid)vc.fetch("/api/v1/side/"+encodeURIComponent(sid)+"/stop",{method:"POST",headers:json,body:"{}"}).catch(function(){});}
  var out={cancel:cancel,text:async function(){for await(var c of out);return full;}};
  out[Symbol.asyncIterator]=function(){return {next:function(){return gen.next();},return:function(){cancel();return Promise.resolve({value:undefined,done:true});}};};
  return out;
};
vc.mic=async function(o){
  o=o||{};await ready;
  return new Promise(function(res,rej){
    var chunks=[],stopFn=null,rec,id;
    id=call({op:"mic-start",mimeType:o.mimeType?String(o.mimeType):""},[],function(m){
      if(m.ev==="error"){delete wait[id];if(stopFn)stopFn.rej(new Error(m.error));else rej(new Error(m.error||"microphone unavailable"));}
      else if(m.ev==="started"){
        rec={mimeType:m.mimeType,ondata:null,
          stop:function(){return new Promise(function(r2,j2){stopFn={res:r2,rej:j2};post({op:"mic-stop",id:id});});},
          cancel:function(){post({op:"mic-stop",id:id});delete wait[id];}};
        res(rec);
      }
      else if(m.ev==="chunk"){var b=new Blob([m.data],{type:m.mimeType});chunks.push(b);if(rec&&rec.ondata)try{rec.ondata(b);}catch(e){}}
      else if(m.ev==="done"){delete wait[id];if(stopFn)stopFn.res(new Blob(chunks,{type:m.mimeType||(rec&&rec.mimeType)||""}));}
    });
  });
};
vc.play=function(src){
  return new Promise(function(res,rej){
    var url=typeof src==="string"?src:URL.createObjectURL(src),a=new Audio(url);
    a.onended=function(){if(typeof src!=="string")URL.revokeObjectURL(url);res();};
    a.onerror=function(){rej(new Error("audio could not play"));};
    a.play().catch(rej);
  });
};
window.vc=vc;
})();`;

/** The <script> a live page gets first in its <head>. */
export function liveScript(): string {
  return `<script data-vc-live-script>${PAGE_SCRIPT}</script>`;
}

// ---------------------------------------------------------------------------------------------------------------
// The host side.

export function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Sliding one-minute window: false when `n` events already happened in it. */
export function allowRate(times: number[], n: number, now = Date.now()): boolean {
  while (times.length && now - times[0]! > 60_000) times.shift();
  if (times.length >= n) return false;
  times.push(now);
  return true;
}

// ---- grants: Carl's yes, remembered per page path + content hash (a changed page asks again) ----

const GRANTS_KEY = "vc-live-grants";
const grantKey = (path: string, hash: string) => `${path}|${hash}`;
function readGrants(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(GRANTS_KEY) ?? "{}") as Record<string, string[]>;
  } catch {
    return {};
  }
}
const grantedFor = (path: string, hash: string, caps: string[]): boolean => {
  const g = readGrants()[grantKey(path, hash)];
  return !!g && caps.every((c) => g.includes(c));
};
function saveGrant(path: string, hash: string, caps: string[]): void {
  try {
    const all = readGrants();
    all[grantKey(path, hash)] = caps;
    localStorage.setItem(GRANTS_KEY, JSON.stringify(all));
  } catch {
    /* no storage: asked again next time */
  }
}
/** Take back Carl's yes for a page (every version of it); the box also drops its tokens. */
export function forgetLiveGrant(path: string): void {
  try {
    const all = readGrants();
    for (const k of Object.keys(all)) if (k.startsWith(`${path}|`)) delete all[k];
    localStorage.setItem(GRANTS_KEY, JSON.stringify(all));
  } catch {
    /* nothing stored */
  }
}

type Grant = { caps: string[]; token: string; exp: number } | null;
type PageState = {
  grant: Promise<Grant> | null;
  denied: boolean;
  askTimes: number[];
  active: number;
  mic: { id: number; stop: () => void } | null;
  ro: ResizeObserver | null;
};

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** The one-time prompt, over the frame: what the page wants, Allow / Not now. Resolves true on Allow. */
function askCarl(doc: Document, frame: HTMLIFrameElement, page: string, caps: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const r = frame.getBoundingClientRect();
    const box = doc.createElement("div");
    box.setAttribute("data-el", "live-grant");
    const w = Math.min(340, Math.max(220, r.width - 16));
    box.style.cssText = `position:fixed;left:${Math.max(8, r.left + (r.width - w) / 2)}px;top:${Math.max(8, Math.min(r.top + 12, window.innerHeight - 260))}px;width:${w}px;z-index:2147483000;padding:12px 14px;border-radius:10px;background:hsl(var(--card,0 0% 13%));color:hsl(var(--foreground,0 0% 92%));border:1px solid hsl(var(--border,0 0% 30%));box-shadow:0 6px 24px #0008;font:12.5px/1.45 system-ui,sans-serif`;
    const title = doc.createElement("div");
    title.style.cssText = "font-weight:600;margin-bottom:6px";
    title.textContent = `${page.split("/").pop() ?? page} wants to:`;
    const list = doc.createElement("ul");
    list.style.cssText = "margin:0 0 10px;padding-left:18px";
    for (const c of caps) {
      const li = doc.createElement("li");
      li.textContent = describeCap(c);
      list.append(li);
    }
    const row = doc.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
    const mk = (label: string, primary: boolean, ok: boolean) => {
      const b = doc.createElement("button");
      b.textContent = label;
      b.setAttribute("data-el", ok ? "live-grant-allow" : "live-grant-deny");
      b.style.cssText = `border:1px solid hsl(var(--border,0 0% 30%));border-radius:8px;padding:4px 12px;font:inherit;cursor:pointer;background:${primary ? "hsl(var(--primary,0 0% 85%))" : "transparent"};color:${primary ? "hsl(var(--primary-foreground,0 0% 10%))" : "inherit"}`;
      b.onclick = () => {
        box.remove();
        resolve(ok);
      };
      return b;
    };
    row.append(mk("Not now", false, false), mk("Allow", true, true));
    box.append(title, list, row);
    doc.body.append(box);
  });
}

export function installLiveBridge(host: LiveHost, doc: Document = document): () => void {
  const win = doc.defaultView!;
  const pages = new WeakMap<Window, PageState>();

  const frameOf = (w: MessageEventSource | null): HTMLIFrameElement | null => {
    if (!w) return null;
    for (const f of Array.from(doc.querySelectorAll<HTMLIFrameElement>(`iframe[${LIVE_ATTR}]`))) if (f.contentWindow === w) return f;
    return null;
  };
  const stateOf = (w: Window): PageState => {
    let s = pages.get(w);
    if (!s) pages.set(w, (s = { grant: null, denied: false, askTimes: [], active: 0, mic: null, ro: null }));
    return s;
  };
  const env = (f: HTMLIFrameElement, caps: string[]) => {
    const cs = win.getComputedStyle(doc.documentElement);
    const vars: Record<string, string> = {};
    for (const n of LIVE_THEME_VARS) {
      const v = cs.getPropertyValue(`--${n}`).trim();
      if (v) vars[n] = v;
    }
    const r = f.getBoundingClientRect();
    return { ev: "env", caps, mode: doc.documentElement.dataset.theme === "light" ? "light" : "dark", vars, w: Math.round(r.width), h: Math.round(r.height), path: f.getAttribute(LIVE_ATTR) ?? "" };
  };
  const reply = (f: HTMLIFrameElement, m: Record<string, unknown>, transfer: Transferable[] = []) => {
    try {
      f.contentWindow?.postMessage({ [LIVE]: 1, ...m }, "*", transfer);
    } catch {
      /* the frame is between documents */
    }
  };

  /** The box's current word on this page (capabilities + content hash), Carl's grant, then a token. null: not live / not granted. */
  const getGrant = async (f: HTMLIFrameElement, st: PageState, page: string, fresh = false): Promise<Grant> => {
    const m = await host.post("/api/v2/live/manifest", { path: page });
    const caps: string[] = Array.isArray(m.json?.caps) ? m.json.caps : [];
    const hash = String(m.json?.hash ?? "");
    if (m.status !== 200 || !caps.length || !hash) return null;
    if (!grantedFor(page, hash, caps)) {
      if (st.denied && !fresh) return null;
      if (!(await askCarl(doc, f, page, caps))) {
        st.denied = true;
        return null;
      }
      saveGrant(page, hash, caps);
    }
    const t = await host.post("/api/v2/live/token", { path: page, hash, caps });
    if (t.status !== 200 || !t.json?.token) return null;
    return { caps, token: String(t.json.token), exp: Number(t.json.exp) || Date.now() + LIVE_LIMITS.tokenSeconds * 1000 };
  };
  const grantOf = (f: HTMLIFrameElement, st: PageState, page: string, refresh = false): Promise<Grant> => {
    if (refresh || !st.grant) {
      const p = (st.grant = getGrant(f, st, page, refresh).catch(() => null));
      // A failure that is not Carl's "Not now" is tried again next time.
      void p.then((g) => {
        if (!g && !st.denied && st.grant === p) st.grant = null;
      });
    }
    return st.grant!.then((g) => (g && g.exp - Date.now() < 30_000 ? grantOf(f, st, page, true) : g));
  };

  const onMessage = (e: MessageEvent) => {
    const d = e.data as Record<string, unknown> | null;
    if (!d || typeof d !== "object" || d[LIVE] !== 1 || typeof d.op !== "string") return;
    // The page is a sandbox with an opaque origin: anything else is not a live page.
    if (e.origin !== "null") return;
    const f = frameOf(e.source);
    if (!f || !f.contentWindow) return;
    const page = f.getAttribute(LIVE_ATTR) ?? "";
    if (!page) return;
    const st = stateOf(f.contentWindow);
    const fail = (id: unknown, error: string) => isId(id) && reply(f, { id, ev: "error", error });

    switch (d.op) {
      case "hello": {
        if (st.grant) return void st.grant.then((g) => g && reply(f, env(f, g.caps)));
        void grantOf(f, st, page).then((g) => {
          if (!g) return;
          reply(f, env(f, g.caps));
          if (!st.ro && typeof ResizeObserver !== "undefined") {
            let t: ReturnType<typeof setTimeout> | null = null;
            st.ro = new ResizeObserver(() => {
              if (t) clearTimeout(t);
              t = setTimeout(() => reply(f, env(f, g.caps)), 120);
            });
            st.ro.observe(f);
          }
        });
        return;
      }
      case "fetch": {
        if (!isId(d.id)) return;
        const id = d.id;
        const path = typeof d.path === "string" && d.path.startsWith("/") && !d.path.startsWith("//") && d.path.length <= 2000 ? d.path : null;
        if (!path) return void fail(id, "vc.fetch: a path on the box, like /api/v1/side");
        const method = d.method === "GET" || d.method === "POST" ? d.method : null;
        if (!method) return void fail(id, "vc.fetch: GET or POST only");
        let body: Uint8Array | null = null;
        if (d.body != null) {
          if (!(d.body instanceof ArrayBuffer)) return void fail(id, "vc.fetch: bad body");
          if (d.body.byteLength > LIVE_LIMITS.requestBytes) return void fail(id, `vc.fetch: request body over ${LIVE_LIMITS.requestBytes} bytes`);
          if (method === "GET" && d.body.byteLength) return void fail(id, "vc.fetch: a GET has no body");
          body = new Uint8Array(d.body);
        }
        const headers: Record<string, string> = {};
        if (d.headers && typeof d.headers === "object") {
          for (const [k, v] of Object.entries(d.headers as Record<string, unknown>)) {
            if (LIVE_REQUEST_HEADERS.includes(k.toLowerCase()) && typeof v === "string" && v.length < 300) headers[k.toLowerCase()] = v;
          }
        }
        if (st.active >= LIVE_LIMITS.concurrentFetch) return void fail(id, "vc.fetch: too many requests at once");
        // A new ask is the rate-limited thing (the box counts them too).
        if (method === "POST" && path === "/api/v1/side" && !allowRate(st.askTimes, LIVE_LIMITS.asksPerMinute)) return void fail(id, `vc.ask: at most ${LIVE_LIMITS.asksPerMinute} asks a minute`);
        st.active++;
        void (async () => {
          try {
            let g = await grantOf(f, st, page);
            if (!g) return fail(id, "this page has not been allowed to do that");
            const go = (token: string) => host.post("/api/v2/live/fetch", { token, path, method, headers, bodyBase64: body && body.length ? bytesToBase64(body) : "" });
            let r = await go(g.token);
            if (r.status === 401) {
              // Expired, revoked, or the page changed since: ask the box again (and Carl, when the page changed).
              st.denied = false;
              g = await grantOf(f, st, page, true);
              if (!g) return fail(id, "this page has not been allowed to do that");
              r = await go(g.token);
            }
            if (r.status !== 200 || !r.json?.ok) return fail(id, String(r.json?.error ?? `the box refused (${r.status})`));
            const out = base64ToBytes(String(r.json.bodyBase64 ?? ""));
            if (out.byteLength > LIVE_LIMITS.responseBytes) return fail(id, `vc.fetch: response over ${LIVE_LIMITS.responseBytes} bytes`);
            const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
            reply(f, { id, ev: "res", status: Number(r.json.status) || 502, headers: r.json.headers ?? {}, body: buf }, [buf]);
          } catch (err) {
            fail(id, String((err as Error)?.message ?? err));
          } finally {
            st.active--;
          }
        })();
        return;
      }
      case "mic-start": {
        if (!isId(d.id)) return;
        const id = d.id;
        void grantOf(f, st, page).then((g) => {
          if (!g?.caps.includes("mic")) return fail(id, "this page has not been allowed to use the microphone");
          return startMic(f, st, id, typeof d.mimeType === "string" ? d.mimeType : "", page, reply, fail);
        });
        return;
      }
      case "mic-stop": {
        if (st.mic && st.mic.id === d.id) st.mic.stop();
        return;
      }
    }
  };

  const onTheme = () => {
    for (const f of Array.from(doc.querySelectorAll<HTMLIFrameElement>(`iframe[${LIVE_ATTR}]`))) {
      const st = f.contentWindow ? pages.get(f.contentWindow) : null;
      if (st?.grant) void st.grant.then((g) => g && reply(f, env(f, g.caps)));
    }
  };
  const mo = new win.MutationObserver(onTheme);
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
  win.addEventListener("message", onMessage);
  return () => {
    win.removeEventListener("message", onMessage);
    mo.disconnect();
  };
}

/** Host-side microphone for a page: one recording per page, a visible badge with a Stop, a time cap. Chunks go to the page as audio blobs. */
async function startMic(
  f: HTMLIFrameElement,
  st: PageState,
  id: number,
  want: string,
  page: string,
  reply: (f: HTMLIFrameElement, m: Record<string, unknown>, t?: Transferable[]) => void,
  fail: (id: unknown, error: string) => unknown,
): Promise<void> {
  if (st.mic) return void fail(id, "vc.mic: already recording");
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return void fail(id, "vc.mic: this device cannot record");
  st.mic = { id, stop: () => {} };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    st.mic = null;
    return void fail(id, `vc.mic: microphone refused (${(e as Error)?.name ?? "error"})`);
  }
  const mime = [want, "audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => m && MediaRecorder.isTypeSupported(m)) ?? "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const type = rec.mimeType || mime || "audio/webm";
  const badge = document.createElement("div");
  badge.setAttribute("data-el", "live-mic-badge");
  badge.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483000;display:flex;gap:8px;align-items:center;padding:6px 10px;border-radius:999px;background:#b3261e;color:#fff;font:12px system-ui,sans-serif;box-shadow:0 2px 8px #0006";
  badge.textContent = `● ${page.split("/").pop() ?? "page"} is recording `;
  const stopBtn = document.createElement("button");
  stopBtn.textContent = "Stop";
  stopBtn.style.cssText = "border:0;border-radius:999px;padding:2px 8px;background:#fff;color:#b3261e;font:inherit;cursor:pointer";
  badge.append(stopBtn);
  document.body.append(badge);
  let ended = false;
  const timer = setTimeout(() => stop(), LIVE_LIMITS.micSeconds * 1000);
  const stop = () => {
    if (rec.state !== "inactive") rec.stop();
    else finish();
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    badge.remove();
    st.mic = null;
    reply(f, { id, ev: "done", mimeType: type });
  };
  stopBtn.onclick = stop;
  st.mic = { id, stop };
  // Chunks go out in order, and "done" only after the last one.
  let chain: Promise<void> = Promise.resolve();
  rec.ondataavailable = (ev) => {
    if (!ev.data.size) return;
    chain = chain.then(async () => {
      const buf = await ev.data.arrayBuffer();
      if (buf.byteLength <= LIVE_LIMITS.micChunkBytes) reply(f, { id, ev: "chunk", data: buf, mimeType: type }, [buf]);
    });
  };
  rec.onstop = () => void chain.then(finish);
  rec.onerror = () => stop();
  rec.start(250);
  reply(f, { id, ev: "started", mimeType: type });
}
