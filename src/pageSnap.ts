// A live page draws itself for the Screen tool. The viewer's HTML pages run in a sandboxed frame with an opaque origin
// (src/HtmlView.tsx: sandbox="allow-scripts", no same-origin), so the window's own drawing (src/screenCapture.ts)
// cannot read inside them and drew a grey labelled box instead. Now the page answers a request on the bridge it
// already has (PAGE_SNAP_BRIDGE, injected into every viewer page's head): it clones its own document as shown (form
// values, canvases, images as pixels, its scroll), draws it the same SVG-foreignObject way and posts back a PNG.
// screenCapture.ts asks each viewer frame on screen (snapFrame) and puts that picture where the frame is; a frame that
// does not answer in time stays a labelled box, and the note says how many.

/** The page's side, injected into a viewer page's head (src/HtmlView.tsx injectHeadScripts). Plain ES5, no imports. */
export const PAGE_SNAP_BRIDGE = `<script>(function(){
  function done(id, r){ r.id = id; try { parent.postMessage({ __vc_snap_result: r }, '*'); } catch(_) {} }
  function clone(n){
    if (n.nodeType === 3) return document.createTextNode(n.nodeValue || '');
    if (n.nodeType !== 1) return null;
    var t = n.tagName;
    if (t === 'SCRIPT' || t === 'STYLE' || t === 'LINK' || t === 'NOSCRIPT' || t === 'TEMPLATE' || t === 'META' || t === 'TITLE' || t === 'BASE') return null;
    if (t === 'CANVAS' || t === 'IMG') {
      var cs = getComputedStyle(n), im = document.createElement('img'), url = '';
      try {
        if (t === 'CANVAS') url = n.toDataURL('image/png');
        else if (n.naturalWidth) { var c = document.createElement('canvas'); c.width = n.naturalWidth; c.height = n.naturalHeight; c.getContext('2d').drawImage(n, 0, 0); url = c.toDataURL('image/png'); }
      } catch(_) {}
      if (n.getAttribute('class')) im.setAttribute('class', n.getAttribute('class'));
      im.setAttribute('style', (n.getAttribute('style') || '') + ';width:' + cs.width + ';height:' + cs.height);
      if (url) im.setAttribute('src', url);
      return im;
    }
    if (t === 'IFRAME' || t === 'VIDEO' || t === 'EMBED' || t === 'OBJECT') {
      var b = document.createElement('div'), s = getComputedStyle(n);
      b.setAttribute('style', 'width:' + s.width + ';height:' + s.height + ';background:#888');
      return b;
    }
    var o = n.cloneNode(false);
    if (t === 'INPUT') {
      if (n.type === 'checkbox' || n.type === 'radio') { if (n.checked) o.setAttribute('checked', ''); else o.removeAttribute('checked'); }
      else if (n.type !== 'file' && n.type !== 'password') o.setAttribute('value', n.value);
    }
    if (t === 'TEXTAREA') { o.textContent = n.value; return o; }
    for (var k = n.firstChild; k; k = k.nextSibling) { var x = clone(k); if (x) o.appendChild(x); }
    if (t === 'SELECT') for (var q = 0; q < o.children.length; q++) { if (o.children[q].value === n.value) o.children[q].setAttribute('selected', ''); }
    if (n !== document.body && (n.scrollTop || n.scrollLeft)) {
      for (var m = 0; m < o.children.length; m++) o.children[m].style.transform = 'translate(' + (-n.scrollLeft) + 'px,' + (-n.scrollTop) + 'px)';
      o.style.overflow = 'hidden';
    }
    return o;
  }
  function snap(id){
    var W = innerWidth, H = innerHeight;
    try {
      var css = '';
      for (var i = 0; i < document.styleSheets.length; i++) {
        try { var rs = document.styleSheets[i].cssRules; for (var j = 0; j < rs.length; j++) css += rs[j].cssText + '\\n'; } catch(_) {}
      }
      var html = document.documentElement.cloneNode(false);
      var st = document.createElement('style');
      st.textContent = css;
      html.appendChild(st);
      var body = document.body ? clone(document.body) : null;
      if (body) {
        body.style.transform = 'translate(' + (-scrollX) + 'px,' + (-scrollY) + 'px)';
        html.appendChild(body);
      }
      html.style.width = W + 'px';
      html.style.height = H + 'px';
      html.style.overflow = 'hidden';
      var bg = getComputedStyle(document.documentElement).backgroundColor;
      if (!bg || bg === 'rgba(0, 0, 0, 0)') bg = document.body ? getComputedStyle(document.body).backgroundColor : '';
      if (!bg || bg === 'rgba(0, 0, 0, 0)') bg = '#ffffff';
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '"><foreignObject x="0" y="0" width="100%" height="100%">' + new XMLSerializer().serializeToString(html) + '</foreignObject></svg>';
      var img = new Image();
      img.onload = function(){
        try {
          var s = Math.min(2, Math.max(1, devicePixelRatio || 1)), c = document.createElement('canvas');
          c.width = Math.round(W * s); c.height = Math.round(H * s);
          var g = c.getContext('2d');
          g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
          g.drawImage(img, 0, 0, c.width, c.height);
          done(id, { dataUrl: c.toDataURL('image/png'), width: W, height: H });
        } catch (err) { done(id, { error: 'the page could not read its own drawing back (' + (err && err.name || 'error') + ')' }); }
      };
      img.onerror = function(){ done(id, { error: 'the page could not draw itself as an image' }); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    } catch (err) { done(id, { error: String(err && err.message || err) }); }
  }
  addEventListener('message', function(e){
    var d = e.data;
    if (d && d.__vc_snap && e.source === parent) snap(d.__vc_snap);
    if (d && d.__vc_text && e.source === parent) { try { parent.postMessage({ __vc_text_result: { id: d.__vc_text, text: (document.body && document.body.innerText) || '' } }, '*'); } catch(_) {} }
  });
})();</script>`;

/** The frames the window's drawing asks to draw themselves: the viewer's HTML pages and the box's dev servers in a pane
 *  (both carry PAGE_SNAP_BRIDGE: src/HtmlView.tsx, server/devProxy.ts). */
export const SNAP_FRAME_SELECTOR = "iframe[data-look-frame], iframe[data-el=\"web-pane-frame\"]";

type FrameLike = { contentWindow: { postMessage: (m: unknown, origin: string) => void } | null };
type WinLike = { addEventListener: (t: "message", f: (e: MessageEvent) => void) => void; removeEventListener: (t: "message", f: (e: MessageEvent) => void) => void };

let seq = 0;

/**
 * Ask a page frame to draw itself (PAGE_SNAP_BRIDGE). Its PNG as a data URL, or null when it does not answer within
 * `ms`, answers with an error, or answers with something that is not a PNG. Only that frame's own answer counts.
 */
export function snapFrame(frame: FrameLike, ms = 3000, win: WinLike = window as unknown as WinLike): Promise<string | null> {
  const target = frame.contentWindow;
  if (!target) return Promise.resolve(null);
  const id = `snap-${Date.now().toString(36)}-${++seq}`;
  return new Promise((resolve) => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const finish = (v: string | null) => {
      if (t) clearTimeout(t);
      win.removeEventListener("message", onMsg);
      resolve(v);
    };
    const onMsg = (e: MessageEvent) => {
      const r = (e.data as { __vc_snap_result?: { id?: string; dataUrl?: unknown } } | null)?.__vc_snap_result;
      if (!r || r.id !== id || e.source !== (target as unknown)) return;
      finish(typeof r.dataUrl === "string" && r.dataUrl.startsWith("data:image/png;base64,") && r.dataUrl.length < 12_000_000 ? r.dataUrl : null);
    };
    win.addEventListener("message", onMsg);
    t = setTimeout(() => finish(null), ms);
    try {
      target.postMessage({ __vc_snap: id }, "*");
    } catch {
      finish(null);
    }
  });
}

/** Ask a page frame for the text it shows (PAGE_SNAP_BRIDGE's __vc_text): app/viewer's pageText. Null: no answer. */
export function textOfFrame(frame: FrameLike, ms = 3000, win: WinLike = window as unknown as WinLike): Promise<string | null> {
  const target = frame.contentWindow;
  if (!target) return Promise.resolve(null);
  const id = `text-${Date.now().toString(36)}-${++seq}`;
  return new Promise((resolve) => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const finish = (v: string | null) => {
      if (t) clearTimeout(t);
      win.removeEventListener("message", onMsg);
      resolve(v);
    };
    const onMsg = (e: MessageEvent) => {
      const r = (e.data as { __vc_text_result?: { id?: string; text?: unknown } } | null)?.__vc_text_result;
      if (!r || r.id !== id || e.source !== (target as unknown)) return;
      finish(typeof r.text === "string" ? r.text.slice(0, 200_000) : null);
    };
    win.addEventListener("message", onMsg);
    t = setTimeout(() => finish(null), ms);
    try {
      target.postMessage({ __vc_text: id }, "*");
    } catch {
      finish(null);
    }
  });
}
