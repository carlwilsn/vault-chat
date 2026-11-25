// Driving a public web page in a viewer pane (the native view, src-tauri/src/web_embed.rs): what the agent and Carl's
// Select use to see and act on any site. The app reaches into the page (web_embed_eval runs a script there and hands
// back its result); the page never gets a way to call the app.
//
// One script (PAGE_JS) does it all inside the page: read (the visible text, and the interactive elements, each with a
// short ref that stays the same for that element while the page lives), click, type, scroll, and the element picker
// (Select). Its answers are the page's word, so they are bounded again here (driven()), and a password field's value is
// never read: the script only says whether one is filled.
import type { WebPageSeen } from "./layoutTypes";

/** What the pane's view can be asked: one step of the drive script. */
export type DriveOp =
  | { op: "read" }
  | { op: "click"; ref?: string; text?: string }
  | { op: "type"; ref?: string; text?: string; value: string; enter?: boolean }
  | { op: "scroll"; ref?: string; by?: number | "top" | "bottom" }
  | { op: "describe"; ref: string }
  /** The agent's cursor glides to the element (and rings it) before a click / type / scroll acts on it. */
  | { op: "point"; ref?: string; text?: string }
  | { op: "pickStart" }
  | { op: "pickPoll" }
  | { op: "pickStop" };

/** An element Carl picked with Select (or the agent named by ref): it goes to the composer as a chip. */
export type WebPick = { url: string; ref: string; tag: string; label: string; text: string; html: string };

/** Caps: what one read may carry (token-cheap). */
export const TEXT_MAX = 6000;
export const ELEMENTS_MAX = 120;

// The script in the page. Plain ES2017 in a string (not a bundled function: a minifier's helpers would not exist there).
// It keeps its refs on window.__vcDrive (a page reload starts them over) and returns JSON text.
const PAGE_JS = String.raw`
var TEXT_MAX = __TEXT_MAX__, ELEMENTS_MAX = __ELEMENTS_MAX__;
var w = window, d = document;
var st = w.__vcDrive || (w.__vcDrive = { n: 0, byRef: new Map(), refOf: new WeakMap(), pick: null, stop: null });
function sq(s, n) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function ref(el) { var r = st.refOf.get(el); if (!r) { r = "e" + (++st.n); st.refOf.set(el, r); } st.byRef.set(r, el); return r; }
var SEL = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[role=combobox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick]';
function shown(el) {
  var r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  var cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
}
function secret(el) {
  var t = (el.getAttribute("type") || "").toLowerCase(), ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  return t === "password" || /cc-number|cc-csc|one-time-code|current-password|new-password/.test(ac);
}
function role(el) {
  var r = el.getAttribute("role"); if (r) return r;
  var tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "input") {
    var t = (el.getAttribute("type") || "text").toLowerCase();
    if (t === "password") return "password";
    if (t === "checkbox" || t === "radio") return t;
    if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
    return t === "text" ? "textbox" : t;
  }
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "select";
  if (el.isContentEditable) return "textbox";
  return tag === "summary" ? "button" : tag;
}
function label(el) {
  var a = el.getAttribute("aria-label"); if (a && a.trim()) return sq(a, 80);
  var lb = el.getAttribute("aria-labelledby");
  if (lb) { var t = lb.split(/\s+/).map(function (i) { var x = d.getElementById(i); return x ? x.innerText || x.textContent : ""; }).join(" "); if (t.trim()) return sq(t, 80); }
  if (el.labels && el.labels.length) { var l = el.labels[0].innerText || el.labels[0].textContent; if (l && l.trim()) return sq(l, 80); }
  var tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea" && tag !== "select") { var it = el.innerText || el.textContent; if (it && it.trim()) return sq(it, 80); }
  var img = el.querySelector && el.querySelector("img[alt]"); if (img && img.alt.trim()) return sq(img.alt, 80);
  var p = el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || el.getAttribute("alt");
  if (p) return sq(p, 80);
  if (tag === "input" && /^(submit|button|reset)$/i.test(el.type || "")) return sq(el.value, 80);
  return "";
}
function line(el) {
  var r = role(el), s = ref(el) + " " + r, n = label(el);
  if (n) s += ' "' + n.replace(/"/g, "'") + '"';
  var tag = el.tagName.toLowerCase();
  if (r === "link") { var h = el.getAttribute("href") || ""; try { var u = new URL(h, location.href); h = u.origin === location.origin ? u.pathname + u.search + u.hash : u.href; } catch (e) {} if (h && h !== "#") s += " -> " + sq(h, 80); }
  if (tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable) {
    if (r === "checkbox" || r === "radio") s += el.checked ? " [x]" : " [ ]";
    else if (secret(el)) s += el.value ? " (filled)" : " (empty)";
    else { var v = tag === "select" ? (el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : "") : el.isContentEditable ? el.innerText : el.value; if (v) s += ' = "' + sq(v, 60).replace(/"/g, "'") + '"'; }
  }
  if (el.disabled || el.getAttribute("aria-disabled") === "true") s += " (disabled)";
  return s;
}
function read() {
  var all = Array.prototype.slice.call(d.querySelectorAll(SEL)).filter(shown);
  var vh = innerHeight, inView = [], below = [];
  all.forEach(function (el) { var r = el.getBoundingClientRect(); (r.bottom > 0 && r.top < vh ? inView : below).push(el); });
  var els = inView.concat(below);
  var text = d.body ? String(d.body.innerText || "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim() : "";
  return { url: location.href, title: d.title, text: text.slice(0, TEXT_MAX), textLength: text.length,
    elements: els.slice(0, ELEMENTS_MAX).map(line), elementCount: els.length,
    scroll: { y: Math.round(scrollY), max: Math.max(0, Math.round(d.documentElement.scrollHeight - innerHeight)) } };
}
function find(o) {
  if (o.ref) { var el = st.byRef.get(String(o.ref)); if (el && el.isConnected) return el; throw new Error("no element " + o.ref + " on the page now (read it again)"); }
  var want = sq(o.text, 200).toLowerCase(); if (!want) throw new Error("say which element: ref, or its visible text");
  var all = Array.prototype.slice.call(d.querySelectorAll(SEL)).filter(shown), part = null;
  for (var i = 0; i < all.length; i++) { var n = label(all[i]).toLowerCase(); if (n === want) return all[i]; if (!part && n.indexOf(want) >= 0) part = all[i]; }
  if (part) return part;
  var walk = d.createTreeWalker(d.body, NodeFilter.SHOW_ELEMENT), best = null;
  while (walk.nextNode()) { var e = walk.currentNode; if (shown(e) && sq(e.innerText, 200).toLowerCase() === want) best = e; }
  if (best) return best;
  throw new Error('nothing on the page reads "' + o.text + '"');
}
function said(el) { return line(el); }
function click(o) {
  var el = find(o);
  el.scrollIntoView({ block: "center", inline: "nearest" });
  var r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, at = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: w };
  el.dispatchEvent(new PointerEvent("pointerdown", at)); el.dispatchEvent(new MouseEvent("mousedown", at));
  if (el.focus) el.focus();
  el.dispatchEvent(new PointerEvent("pointerup", at)); el.dispatchEvent(new MouseEvent("mouseup", at));
  el.click();
  return { did: "clicked " + said(el) };
}
function type(o) {
  var el = find(o), v = String(o.value == null ? "" : o.value);
  el.scrollIntoView({ block: "center", inline: "nearest" });
  el.focus();
  var tag = el.tagName.toLowerCase();
  if (tag === "select") {
    var opt = Array.prototype.slice.call(el.options).find(function (x) { return x.value === v || x.text.trim() === v; });
    if (!opt) throw new Error("no option " + v);
    el.value = opt.value; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    d.execCommand("selectAll", false); d.execCommand("insertText", false, v);
  } else {
    if (el.select) el.select();
    if (!d.execCommand("insertText", false, v) || el.value !== v) {
      var proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  var did = "typed into " + said(el);
  if (o.enter) {
    var k = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    var go = el.dispatchEvent(new KeyboardEvent("keydown", k));
    el.dispatchEvent(new KeyboardEvent("keypress", k)); el.dispatchEvent(new KeyboardEvent("keyup", k));
    if (go && el.form && tag !== "textarea") { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); did += ", submitted its form"; }
    else did += ", pressed Enter";
  }
  return { did: did };
}
function scroll(o) {
  if (o.ref) { var el = find(o); el.scrollIntoView({ block: "center" }); return { did: "scrolled to " + said(el) }; }
  if (o.by === "top") scrollTo(0, 0); else if (o.by === "bottom") scrollTo(0, d.documentElement.scrollHeight);
  else scrollBy(0, typeof o.by === "number" ? o.by : Math.round(innerHeight * 0.8));
  return { did: "scrolled to " + Math.round(scrollY) };
}
function describe(el) {
  var c = el.cloneNode(true);
  if (c.querySelectorAll) Array.prototype.forEach.call(c.querySelectorAll("input"), function (i) { if (secret(i)) i.removeAttribute("value"); });
  if (c.tagName === "INPUT" && secret(c)) c.removeAttribute("value");
  var text = secret(el) ? "" : sq(el.innerText || el.textContent || (el.value != null ? el.value : ""), 300);
  return { url: location.href, ref: ref(el), tag: el.tagName.toLowerCase(), label: label(el) || el.tagName.toLowerCase(), text: text, html: sq(c.outerHTML, 400) };
}
// The agent's cursor, so Carl watches it act: a dot in the app's accent that glides to the element and rings it, then
// fades when idle. Outside <body> (not in the page's text), pointer-events none (never in the way of his mouse).
function point(o) {
  var el = find(o);
  el.scrollIntoView({ block: "center", inline: "nearest" });
  var r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  var c = st.cursor;
  if (!c || !c.dot.isConnected) {
    var dot = d.createElement("div"), ring = d.createElement("div");
    dot.setAttribute("aria-hidden", "true"); ring.setAttribute("aria-hidden", "true");
    dot.style.cssText = "position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:#d97757;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:none;z-index:2147483647;transition:transform .15s ease-out,opacity .3s;opacity:0;transform:translate(" + Math.round(innerWidth / 2) + "px," + Math.round(innerHeight / 2) + "px)";
    ring.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #d97757;border-radius:4px;box-shadow:0 0 0 4px rgba(217,119,87,.25);opacity:0;transition:opacity .3s";
    d.documentElement.appendChild(ring); d.documentElement.appendChild(dot);
    c = st.cursor = { dot: dot, ring: ring, t: 0 };
    void dot.offsetWidth;
  }
  c.dot.style.opacity = "1";
  c.dot.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
  c.ring.style.left = (r.left - 3) + "px"; c.ring.style.top = (r.top - 3) + "px"; c.ring.style.width = (r.width + 2) + "px"; c.ring.style.height = (r.height + 2) + "px";
  c.ring.style.opacity = "1";
  clearTimeout(c.t);
  c.t = setTimeout(function () { c.dot.style.opacity = "0"; c.ring.style.opacity = "0"; }, 1500);
  return { pointed: ref(el) };
}
function pickStop() { if (st.stop) st.stop(); st.stop = null; }
function pickStart() {
  pickStop(); st.pick = null;
  var box = d.createElement("div");
  box.setAttribute("data-vc-pick", "");
  box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #d97757;background:rgba(217,119,87,.12);border-radius:3px;display:none";
  var tip = d.createElement("div");
  tip.style.cssText = "position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;font:12px system-ui,sans-serif;background:#d97757;color:#fff;padding:2px 8px;border-radius:4px";
  tip.textContent = "Click an element to select it · Esc to stop";
  d.documentElement.appendChild(box); d.documentElement.appendChild(tip);
  var at = null;
  function move(ev) {
    var e = ev.target; if (!e || !e.tagName || e === box || e.tagName === "HTML" || e.tagName === "BODY") return;
    at = e; var r = e.getBoundingClientRect();
    box.style.display = "block"; box.style.left = (r.left - 2) + "px"; box.style.top = (r.top - 2) + "px"; box.style.width = (r.width + 4) + "px"; box.style.height = (r.height + 4) + "px";
  }
  function block(ev) { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); }
  function clk(ev) { block(ev); if (at) st.pick = describe(at); pickStop(); }
  function key(ev) { if (ev.key === "Escape") { block(ev); st.pick = { cancelled: true }; pickStop(); } }
  var evs = [["mousemove", move], ["click", clk], ["mousedown", block], ["mouseup", block], ["pointerdown", block], ["pointerup", block], ["keydown", key]];
  evs.forEach(function (x) { w.addEventListener(x[0], x[1], true); });
  st.stop = function () { evs.forEach(function (x) { w.removeEventListener(x[0], x[1], true); }); box.remove(); tip.remove(); };
  return { picking: true };
}
function pickPoll() { var p = st.pick; if (!p) return st.stop ? { picking: true } : { picking: false }; st.pick = null; return p.cancelled ? { cancelled: true } : { picked: p }; }
var o = __OP__, out;
try {
  if (o.op === "read") out = read();
  else if (o.op === "click") out = click(o);
  else if (o.op === "type") out = type(o);
  else if (o.op === "scroll") out = scroll(o);
  else if (o.op === "describe") out = { picked: describe(find(o)) };
  else if (o.op === "point") out = point(o);
  else if (o.op === "pickStart") out = pickStart();
  else if (o.op === "pickPoll") out = pickPoll();
  else if (o.op === "pickStop") { pickStop(); out = { picking: false }; }
  else out = { error: "unknown op " + o.op };
} catch (e) { out = { error: String(e && e.message || e) }; }
return JSON.stringify(out);
`;

/** The script for one step, ready for web_embed_eval: an expression whose value is the step's answer as JSON text. */
export function driveScript(op: DriveOp): string {
  // Replaced by functions: a "$" in the op (typed text) is never a replacement pattern.
  const body = PAGE_JS.replace("__TEXT_MAX__", () => String(TEXT_MAX)).replace("__ELEMENTS_MAX__", () => String(ELEMENTS_MAX)).replace("__OP__", () => JSON.stringify(op));
  return `(function(){${body}})()`;
}

/** The browser's answer as a value: WebView2 hands back the JSON of the script's value (a JSON string here, so JSON
 *  twice), WKWebView the string itself. null: no answer (the page was between documents, or threw outside the try). */
export function answerOf(raw: unknown): Record<string, unknown> | null {
  let v: unknown = raw;
  for (let i = 0; i < 3 && typeof v === "string"; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const str = (x: unknown, n: number) => String(x ?? "").slice(0, n);

/** A read as the workspace noun shows it (panes[].page), bounded again: the page is not trusted to keep the caps. */
export function seenOf(a: Record<string, unknown>): WebPageSeen {
  const text = str(a.text, TEXT_MAX);
  const elements = Array.isArray(a.elements) ? a.elements.slice(0, ELEMENTS_MAX).map((e) => str(e, 240)) : [];
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.round(x)) : 0);
  const sc = (a.scroll ?? {}) as { y?: unknown; max?: unknown };
  return {
    text,
    textLength: Math.max(n(a.textLength), text.length),
    elements,
    ...(n(a.elementCount) > elements.length ? { elementCount: n(a.elementCount) } : {}),
    scroll: { y: n(sc.y), max: n(sc.max) },
    at: new Date().toISOString(),
  };
}

/** A picked element, bounded. `pane`: the pane's address, when the page's own is not an http(s) one. */
export function pickOf(p: unknown, pane: string): WebPick | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const own = str(o.url, 2000);
  const url = /^https?:\/\//i.test(own) ? own : pane;
  return { url, ref: str(o.ref, 16), tag: str(o.tag, 32), label: str(o.label, 80), text: str(o.text, 300), html: str(o.html, 400) };
}

/** A step's arguments checked before anything reaches the page (the agent's and the UI's alike). */
export function driveOpFor(what: "click" | "type" | "scroll", a: { ref?: unknown; text?: unknown; value?: unknown; enter?: unknown; by?: unknown }): DriveOp | string {
  const ref = typeof a.ref === "string" && /^e\d{1,6}$/.test(a.ref) ? a.ref : undefined;
  if (a.ref !== undefined && !ref) return 'ref is one the page read gave, like "e12"';
  const text = typeof a.text === "string" && a.text.trim() ? a.text.trim().slice(0, 200) : undefined;
  if (what === "click") return ref || text ? { op: "click", ...(ref ? { ref } : { text }) } : "click needs ref (from the page's elements) or text (what it reads)";
  if (what === "type") {
    if (typeof a.value !== "string") return "type needs value (the text to put in)";
    if (!ref && !text) return "type needs ref (from the page's elements) or text (the field's label)";
    return { op: "type", ...(ref ? { ref } : { text }), value: a.value.slice(0, 5000), ...(a.enter === true ? { enter: true } : {}) };
  }
  const by = a.by === "top" || a.by === "bottom" ? a.by : typeof a.by === "number" && Number.isFinite(a.by) ? Math.round(a.by) : undefined;
  if (a.by !== undefined && by === undefined) return 'scroll\'s by is pixels (down; negative: up), "top" or "bottom"';
  return { op: "scroll", ...(ref ? { ref } : {}), ...(by !== undefined ? { by } : {}) };
}

/** What a pick says to the agent when Carl sends the message (the chip's content). */
export function pickContext(picks: WebPick[]): string {
  if (!picks.length) return "";
  return [
    "Carl selected these elements on web pages in his viewer (Select). The ref works with box:workspace webPage {do: click | type | scroll | select, ref} on that page while it stays loaded:",
    ...picks.map((p) => `- ${p.url} ${p.ref} <${p.tag}> "${p.label}"${p.text && p.text !== p.label ? `\n  text: ${p.text}` : ""}\n  html: ${p.html}`),
  ].join("\n");
}
