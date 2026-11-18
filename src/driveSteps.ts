// Scripted steps run against a document: the in-app half of the agent's Drive tool (server/driveTool.ts), the way
// RecordUI drives a page, but inside the real laptop app (its Drive window, src/driveRunner.ts). Pure DOM: the events
// it dispatches are synthetic (isTrusted false), so the app's own perf probe never counts them and Carl's input
// detector (src/userActivity.ts) never mistakes them for him.
//
// Steps (one action each):
//   {click: "css"} | {click: {text: "Save"}} | {click: {role: "button", name?: "Save"}}
//                                                  pointer + mouse events and a click at the element's centre; focuses it
//   {hover: ...same}                               pointerover/enter/move
//   {type: "hello", into?: "css" | {text}}        text into the focused (or given) field, as typing would insert it
//   {rightClick: ...same}                          a right-button press and a contextmenu event (the app's own menus)
//   {press: "Control+K"}                           keydown/keyup (Enter, Escape, Tab, Backspace, Arrow*, F1-F12, a, ...);
//                                                  "Mod+K" is the platform's mod key: Cmd on a Mac, Ctrl elsewhere
//   {drag: target, to: target, start?: {x, y}, at?: {x, y}}
//                                                  a pointer drag (pointer + mouse events, a move per frame) from the
//                                                  first element to the second; start / at are the points in each
//                                                  element's box as fractions (default the centre, 0.5/0.5)
//   {select: target, text?: "words"}              select those words (else all the text) in the element, as a drag
//                                                  over them would; an editor in it takes the selection as its own
//   {wait: 500}                                    ms (at most 10 s)
//   {waitFor: "css" | {text}, timeout?: ms}        until it is on screen (default 5 s, at most 30 s); fails otherwise
//   {scroll: 600, in?: "css"}                      scroll the given (or the focused element's nearest) scroller
//   {shot: "name"}                                 a picture of the window (the caller's `shot`)
export type Target = string | { text: string } | { role: string; name?: string };
import { IS_MAC } from "./shortcuts";

/** A point inside an element's box, as fractions of its width and height. */
export type BoxPoint = { x: number; y: number };
export type Step =
  | { click: Target }
  | { hover: Target }
  | { rightClick: Target }
  | { drag: Target; to: Target; start?: BoxPoint; at?: BoxPoint }
  | { select: Target; text?: string }
  | { type: string; into?: Target }
  | { press: string }
  | { wait: number }
  | { waitFor: Target; timeout?: number }
  | { scroll: number; in?: Target }
  | { shot: string };
export type StepOutcome = { i: number; action: string; ok: boolean; ms: number; note?: string; error?: string };
export type Shot = { name: string; data: string; mimeType: string; width: number; height: number };
export type StepsResult = { ok: boolean; aborted?: string; steps: StepOutcome[]; errors: string[]; text: string; shots: Shot[]; ms: number };

export const STEP_ACTIONS = ["click", "hover", "rightClick", "type", "press", "wait", "waitFor", "scroll", "shot", "drag", "select"] as const;
export const MAX_STEPS = 40;
export const MAX_SHOTS = 4;

const describe = (t: Target) => (typeof t === "string" ? t : "role" in t ? `role ${t.role}${t.name ? ` "${t.name}"` : ""}` : `text "${t.text}"`);
export function stepAction(s: Step): string {
  return STEP_ACTIONS.find((a) => a in (s as object)) ?? "?";
}

/** The steps, checked: a list of objects with exactly one known action and sane values. A string is why not. */
export function checkSteps(raw: unknown): Step[] | string {
  if (!Array.isArray(raw) || !raw.length) return "steps must be a non-empty list";
  if (raw.length > MAX_STEPS) return `at most ${MAX_STEPS} steps`;
  let shots = 0;
  const target = (v: unknown) => {
    if (typeof v === "string") return !!v.trim();
    if (!v || typeof v !== "object") return false;
    const o = v as { text?: unknown; role?: unknown; name?: unknown };
    if (typeof o.role === "string") return !!o.role.trim() && (o.name === undefined || typeof o.name === "string");
    return typeof o.text === "string" && !!o.text.trim();
  };
  for (const [i, s] of raw.entries()) {
    if (!s || typeof s !== "object") return `step ${i + 1} is not an object`;
    const acts = STEP_ACTIONS.filter((a) => a in s);
    if (acts.length !== 1) return `step ${i + 1} needs exactly one of: ${STEP_ACTIONS.join(", ")}`;
    const o = s as Record<string, unknown>;
    const a = acts[0]!;
    if ((a === "click" || a === "hover" || a === "rightClick" || a === "waitFor" || a === "drag" || a === "select") && !target(o[a])) return `step ${i + 1}: ${a} needs a CSS selector, {text} or {role, name?}`;
    if (a === "drag" && !target(o.to)) return `step ${i + 1}: drag needs to: a CSS selector, {text} or {role, name?}`;
    const frac = (v: unknown) => v === undefined || (!!v && typeof v === "object" && [(v as BoxPoint).x, (v as BoxPoint).y].every((n) => typeof n === "number" && n >= 0 && n <= 1));
    if (a === "drag" && !(frac(o.start) && frac(o.at))) return `step ${i + 1}: start and at are {x, y} fractions of the element's box (0-1)`;
    if (a === "select" && o.text !== undefined && !(typeof o.text === "string" && o.text.trim())) return `step ${i + 1}: select's text needs words`;
    if (a === "type" && (typeof o.type !== "string" || o.type.length > 2000)) return `step ${i + 1}: type needs text (at most 2000 characters)`;
    if (a === "type" && o.into !== undefined && !target(o.into)) return `step ${i + 1}: into needs a CSS selector, {text} or {role, name?}`;
    if (a === "press" && (typeof o.press !== "string" || !parseKey(o.press))) return `step ${i + 1}: press needs a key like "Enter" or "Control+K"`;
    if (a === "wait" && !(typeof o.wait === "number" && o.wait >= 0 && o.wait <= 10_000)) return `step ${i + 1}: wait is 0-10000 ms`;
    if (a === "waitFor" && o.timeout !== undefined && !(typeof o.timeout === "number" && o.timeout > 0 && o.timeout <= 30_000)) return `step ${i + 1}: timeout is at most 30000 ms`;
    if (a === "scroll" && !(typeof o.scroll === "number" && Number.isFinite(o.scroll))) return `step ${i + 1}: scroll needs a number of pixels`;
    if (a === "scroll" && o.in !== undefined && !target(o.in)) return `step ${i + 1}: in needs a CSS selector, {text} or {role, name?}`;
    if (a === "shot" && ++shots > MAX_SHOTS) return `at most ${MAX_SHOTS} shots`;
  }
  return raw as Step[];
}

// ---------------------------------------------------------------- keys

const NAMED: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
export type Key = { key: string; code: string; keyCode: number; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean };

/** "Control+Shift+F" → the KeyboardEvent fields; null when it isn't a key. */
export function parseKey(spec: string): Key | null {
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  if (spec.endsWith("++")) parts.push("+");
  const name = parts.pop();
  if (!name) return null;
  const mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
  for (const m of parts.map((p) => p.toLowerCase())) {
    if (m === "control" || m === "ctrl") mods.ctrlKey = true;
    else if (m === "shift") mods.shiftKey = true;
    else if (m === "alt" || m === "option") mods.altKey = true;
    else if (m === "meta" || m === "cmd" || m === "command" || m === "super") mods.metaKey = true;
    else if (m === "mod") mods[IS_MAC ? "metaKey" : "ctrlKey"] = true; // the platform's mod key (src/shortcuts.ts isMod)
    else return null;
  }
  const named = NAMED[name.toLowerCase()];
  if (named) return { ...named, ...mods };
  const f = /^f([1-9]|1[0-2])$/i.exec(name);
  if (f) return { key: `F${f[1]}`, code: `F${f[1]}`, keyCode: 111 + Number(f[1]), ...mods };
  if ([...name].length !== 1) return null;
  const ch = name;
  const upper = ch.toUpperCase();
  const code = /[a-z]/i.test(ch) ? `Key${upper}` : /[0-9]/.test(ch) ? `Digit${ch}` : "";
  return { key: mods.shiftKey && /[a-z]/i.test(ch) ? upper : /[a-z]/i.test(ch) ? ch.toLowerCase() : ch, code, keyCode: upper.charCodeAt(0), ...mods };
}

// ---------------------------------------------------------------- finding things

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const view = el.ownerDocument.defaultView;
  const cs = view?.getComputedStyle(el);
  return !cs || (cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0");
}

const CLICKABLE = "button, a, [role=button], [role=menuitem], [role=tab], [role=option], [role=treeitem], label, summary, input, textarea, select, [title], [aria-label], [tabindex]";

const IMPLICIT_ROLES: [string, string][] = [
  ["button", "button, input[type=button], input[type=submit], input[type=reset], summary"],
  ["link", "a[href]"],
  ["checkbox", "input[type=checkbox]"],
  ["radio", "input[type=radio]"],
  ["slider", "input[type=range]"],
  ["combobox", "select"],
  ["textbox", "textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=password], [contenteditable=true], [contenteditable='']"],
  ["heading", "h1, h2, h3, h4, h5, h6"],
  ["list", "ul, ol"],
  ["listitem", "li"],
  ["dialog", "dialog"],
  ["img", "img[alt]"],
  ["navigation", "nav"],
  ["main", "main"],
];

/** An element's ARIA role: its role attribute's first word, else the implicit role of its tag ("" when none). */
export function roleOf(el: Element): string {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit.toLowerCase();
  for (const [role, sel] of IMPLICIT_ROLES) if (el.matches(sel)) return role;
  return "";
}

/** An element's accessible name, roughly as a screen reader would say it: aria-label, the text of aria-labelledby, an
 *  input's label / placeholder, its text, its title or alt. */
export function nameOf(el: Element): string {
  const doc = el.ownerDocument;
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const t = by.split(/\s+/).map((id) => doc.getElementById(id)?.textContent?.trim() ?? "").filter(Boolean).join(" ");
    if (t) return t;
  }
  const id = el.getAttribute("id");
  if (id && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
    const lab = [...doc.querySelectorAll("label")].find((l) => l.getAttribute("for") === id);
    if (lab?.textContent?.trim()) return lab.textContent.trim();
  }
  const text = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  return text || el.getAttribute("placeholder")?.trim() || el.getAttribute("title")?.trim() || el.getAttribute("alt")?.trim() || "";
}

/** Every element with the role whose name contains `name` (all of that role without a name), in document order. */
export function byRole(doc: Document, role: string, name?: string): Element[] {
  const want = role.trim().toLowerCase();
  const n = name?.trim().toLowerCase();
  return [...doc.body.querySelectorAll("*")].filter((el) => roleOf(el) === want && (!n || nameOf(el).toLowerCase().includes(n)));
}

/** The element a target names, on screen: a CSS selector's first visible match; for {role, name?} the visible element
 *  of that role whose accessible name contains the name (an exact name first, then the shortest); or the smallest
 *  visible element whose text (or aria-label / title) contains the text, clickable things first. */
export function find(doc: Document, t: Target): Element | null {
  if (typeof t === "object" && "role" in t) {
    const hits = byRole(doc, t.role, t.name).filter(visible);
    const n = t.name?.trim().toLowerCase();
    if (n) hits.sort((a, b) => Number(nameOf(b).toLowerCase() === n) - Number(nameOf(a).toLowerCase() === n) || nameOf(a).length - nameOf(b).length);
    return hits[0] ?? null;
  }
  if (typeof t === "string") {
    let all: Element[];
    try {
      all = [...doc.querySelectorAll(t)];
    } catch {
      throw new Error(`"${t}" is not a CSS selector`);
    }
    return all.find(visible) ?? null;
  }
  const want = t.text.trim().toLowerCase();
  const label = (el: Element) => `${(el as HTMLElement).innerText ?? el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`.toLowerCase();
  const pick = (els: Element[]) => {
    const hits = els.filter((el) => label(el).includes(want) && visible(el));
    hits.sort((a, b) => label(a).length - label(b).length);
    return hits[0] ?? null;
  };
  return pick([...doc.querySelectorAll(CLICKABLE)]) ?? pick([...doc.body.querySelectorAll("*")].filter((el) => !el.children.length || [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim())));
}

// ---------------------------------------------------------------- doing things

function centre(el: Element, at: BoxPoint = { x: 0.5, y: 0.5 }) {
  const r = el.getBoundingClientRect();
  return { clientX: r.left + r.width * at.x, clientY: r.top + r.height * at.y };
}

function pointer(el: Element, type: string, extra: Record<string, unknown> = {}) {
  const view = el.ownerDocument.defaultView!;
  const init = { bubbles: true, cancelable: true, composed: true, view, button: 0, buttons: type.endsWith("down") || type.endsWith("move") ? 1 : 0, ...centre(el), ...extra };
  const Ctor = type.startsWith("pointer") && typeof view.PointerEvent === "function" ? view.PointerEvent : type === "click" || type.startsWith("mouse") ? view.MouseEvent : view.MouseEvent;
  el.dispatchEvent(new Ctor(type, type.startsWith("pointer") ? { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true } : init));
}

function click(el: Element) {
  pointer(el, "pointerover");
  pointer(el, "pointerenter");
  pointer(el, "mouseover");
  pointer(el, "pointerdown");
  pointer(el, "mousedown");
  const f = el as HTMLElement;
  if (typeof f.focus === "function") f.focus({ preventScroll: true });
  pointer(el, "pointerup");
  pointer(el, "mouseup");
  pointer(el, "click", { detail: 1 });
}

function rightClick(el: Element) {
  const right = { button: 2, buttons: 2 };
  pointer(el, "pointerdown", right);
  pointer(el, "mousedown", right);
  pointer(el, "pointerup", { button: 2 });
  pointer(el, "mouseup", { button: 2 });
  pointer(el, "contextmenu", { button: 2 });
}

/** A pointer drag from `from` to `to`, one move per frame, each move sent to what is under the pointer then (a drag's
 *  shield, a drop zone) as a real one is. */
async function drag(doc: Document, from: Element, to: Element, start?: BoxPoint, at?: BoxPoint, signal?: AbortSignal): Promise<string> {
  const a = centre(from, start);
  const b = centre(to, at);
  const under = (p: { clientX: number; clientY: number }) => doc.elementFromPoint(p.clientX, p.clientY) ?? doc.body;
  pointer(from, "pointerover", a);
  pointer(from, "pointerdown", a);
  pointer(from, "mousedown", a);
  const moves = 16;
  for (let i = 1; i <= moves && !signal?.aborted; i++) {
    const p = { clientX: a.clientX + ((b.clientX - a.clientX) * i) / moves, clientY: a.clientY + ((b.clientY - a.clientY) * i) / moves };
    const el = under(p);
    pointer(el, "pointermove", p);
    pointer(el, "mousemove", p);
    await sleep(30, signal);
  }
  const end = under(b);
  pointer(end, "pointerup", b);
  pointer(end, "mouseup", b);
  await sleep(30, signal);
  return `(${Math.round(a.clientX)},${Math.round(a.clientY)}) → (${Math.round(b.clientX)},${Math.round(b.clientY)}) on <${end.tagName.toLowerCase()}>`;
}

/** Select `text` (the first place it occurs; all the text when left out) inside the element. */
function select(el: Element, text?: string): string {
  const doc = el.ownerDocument;
  const view = doc.defaultView!;
  if (isField(el)) {
    const i = text ? el.value.indexOf(text) : 0;
    if (i < 0) throw new Error(`"${text}" is not in the field`);
    el.focus({ preventScroll: true });
    el.setSelectionRange(i, text ? i + text.length : el.value.length);
    return el.value.slice(i, text ? i + text.length : undefined).slice(0, 60);
  }
  const range = doc.createRange();
  if (!text) range.selectNodeContents(el);
  else {
    // The text nodes in order, so words that cross an element (bold, a link) are found too.
    const walker = doc.createTreeWalker(el, view.NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    const whole = nodes.map((n) => n.data).join("");
    const i = whole.indexOf(text);
    if (i < 0) throw new Error(`"${text}" is not in that element's text`);
    const at = (pos: number, end: boolean): [Text, number] => {
      let off = 0;
      for (const n of nodes) {
        if (pos < off + n.data.length || (end && pos === off + n.data.length)) return [n, pos - off];
        off += n.data.length;
      }
      const last = nodes[nodes.length - 1]!;
      return [last, last.data.length];
    };
    range.setStart(...at(i, false));
    range.setEnd(...at(i + text.length, true));
  }
  const editable = (el as HTMLElement).isContentEditable ? (el as HTMLElement) : el.closest<HTMLElement>("[contenteditable=true]");
  editable?.focus({ preventScroll: true });
  const sel = view.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  doc.dispatchEvent(new view.Event("selectionchange"));
  return (sel?.toString() ?? "").replace(/\s+/g, " ").slice(0, 60);
}

function hover(el: Element) {
  pointer(el, "pointerover");
  pointer(el, "pointerenter");
  pointer(el, "mouseover");
  pointer(el, "mouseenter");
  pointer(el, "pointermove");
  pointer(el, "mousemove");
}

function keyEvent(target: Element | Document, type: "keydown" | "keyup", k: Key): boolean {
  const view = (target instanceof Element ? target.ownerDocument : target).defaultView!;
  return target.dispatchEvent(new view.KeyboardEvent(type, { key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, ctrlKey: k.ctrlKey, shiftKey: k.shiftKey, altKey: k.altKey, metaKey: k.metaKey, bubbles: true, cancelable: true, composed: true } as KeyboardEventInit));
}

function focused(doc: Document): Element {
  let el: Element | null = doc.activeElement;
  // A focused same-origin frame's own focus.
  while (el instanceof HTMLIFrameElement) {
    try {
      const inner = el.contentDocument?.activeElement;
      if (!inner) break;
      el = inner;
    } catch {
      break;
    }
  }
  return el ?? doc.body;
}

const isField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement => el instanceof (el.ownerDocument.defaultView?.HTMLTextAreaElement ?? HTMLTextAreaElement) || el instanceof (el.ownerDocument.defaultView?.HTMLInputElement ?? HTMLInputElement);

/** Insert text into a field the way typing does (the browser's own insertText, so React and CodeMirror see real input
 *  events); a field that refuses it gets its value set through the native setter and an input event. */
export function insertText(el: Element, text: string): void {
  const doc = el.ownerDocument;
  const view = doc.defaultView!;
  for (const ch of [...text]) {
    const k = ch === "\n" ? parseKey("Enter")! : { key: ch, code: "", keyCode: ch.toUpperCase().charCodeAt(0), ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    const go = keyEvent(el, "keydown", k);
    if (go) {
      let done = false;
      try {
        done = doc.execCommand("insertText", false, ch);
      } catch {
        done = false;
      }
      if (!done && isField(el)) {
        const proto = el instanceof view.HTMLTextAreaElement ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        const next = el.value.slice(0, start) + ch + el.value.slice(end);
        if (setter) setter.call(el, next);
        else el.value = next;
        el.setSelectionRange?.(start + 1, start + 1);
        el.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
      }
    }
    keyEvent(el, "keyup", k);
  }
}

/** A key press: keydown on the focused element; Backspace/Delete edit as the key would; then keyup. */
export function press(doc: Document, k: Key): void {
  const el = focused(doc);
  const go = keyEvent(el, "keydown", k);
  if (go && !k.ctrlKey && !k.altKey && !k.metaKey) {
    if (k.key === "Backspace" || k.key === "Delete") {
      try {
        doc.execCommand(k.key === "Backspace" ? "delete" : "forwardDelete");
      } catch { /* not editable */ }
    } else if (k.key.length === 1 && (isField(el) || (el as HTMLElement).isContentEditable)) {
      try {
        doc.execCommand("insertText", false, k.key);
      } catch { /* not editable */ }
    }
  }
  keyEvent(el, "keyup", k);
}

function scroller(el: Element | null): Element | null {
  for (let e = el; e; e = e.parentElement) {
    const cs = e.ownerDocument.defaultView?.getComputedStyle(e);
    if (cs && /(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight) return e;
  }
  return el?.ownerDocument.scrollingElement ?? null;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** The page's visible text, compacted, at most `max` characters. */
export function visibleText(doc: Document, max = 4000): string {
  const t = ((doc.body as HTMLElement | null)?.innerText ?? doc.body?.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export type RunOptions = {
  signal?: AbortSignal;
  /** Draw the window for a shot step. */
  shot?: (name: string) => Promise<Shot>;
  /** Called after every step (the caller's own watchdog, tests). */
  onStep?: (o: StepOutcome) => void;
};

/** Run the steps in order; the first failing step stops the run. Collects the page's errors while it runs. */
export async function runSteps(doc: Document, steps: Step[], o: RunOptions = {}): Promise<StepsResult> {
  const view = doc.defaultView!;
  const errors: string[] = [];
  const onError = (e: ErrorEvent) => errors.push(String(e.message || e.error || "error").slice(0, 400));
  const onRejection = (e: PromiseRejectionEvent) => errors.push(`unhandled rejection: ${String((e.reason as Error)?.message ?? e.reason).slice(0, 400)}`);
  view.addEventListener("error", onError);
  view.addEventListener("unhandledrejection", onRejection);
  const origError = view.console.error;
  view.console.error = (...a: unknown[]) => {
    errors.push(a.map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ").slice(0, 400));
    origError.apply(view.console, a);
  };
  const out: StepOutcome[] = [];
  const shots: Shot[] = [];
  const began = performance.now();
  let aborted: string | undefined;
  try {
    for (const [i, s] of steps.entries()) {
      if (o.signal?.aborted) {
        aborted = String(o.signal.reason ?? "aborted");
        break;
      }
      const action = stepAction(s);
      const t0 = performance.now();
      const done = (ok: boolean, more: { note?: string; error?: string } = {}) => {
        const r: StepOutcome = { i: i + 1, action, ok, ms: Math.round(performance.now() - t0), ...more };
        out.push(r);
        o.onStep?.(r);
        return r;
      };
      try {
        const st = s as Record<string, unknown>;
        if (action === "click" || action === "hover" || action === "rightClick") {
          const el = find(doc, st[action] as Target);
          if (!el) throw new Error(`nothing on screen matches ${describe(st[action] as Target)}`);
          if (action === "click") click(el);
          else if (action === "rightClick") rightClick(el);
          else hover(el);
          done(true, { note: `<${el.tagName.toLowerCase()}>${((el as HTMLElement).innerText ?? "").trim().slice(0, 60)}` });
        } else if (action === "drag") {
          const from = find(doc, st.drag as Target);
          if (!from) throw new Error(`nothing on screen matches ${describe(st.drag as Target)}`);
          const to = find(doc, st.to as Target);
          if (!to) throw new Error(`nothing on screen matches ${describe(st.to as Target)}`);
          done(true, { note: await drag(doc, from, to, st.start as BoxPoint | undefined, st.at as BoxPoint | undefined, o.signal) });
        } else if (action === "select") {
          const el = find(doc, st.select as Target);
          if (!el) throw new Error(`nothing on screen matches ${describe(st.select as Target)}`);
          done(true, { note: `"${select(el, st.text as string | undefined)}"` });
        } else if (action === "type") {
          const el = st.into !== undefined ? find(doc, st.into as Target) : focused(doc);
          if (!el) throw new Error(`nothing on screen matches ${describe(st.into as Target)}`);
          if (st.into !== undefined && typeof (el as HTMLElement).focus === "function") (el as HTMLElement).focus({ preventScroll: true });
          const target = st.into !== undefined ? focused(doc) : el;
          if (!isField(target) && !(target as HTMLElement).isContentEditable) throw new Error(`the focused element <${target.tagName.toLowerCase()}> is not a text field`);
          insertText(target, String(st.type));
          done(true);
        } else if (action === "press") {
          press(doc, parseKey(String(st.press))!);
          done(true);
        } else if (action === "wait") {
          await sleep(Number(st.wait), o.signal);
          done(true);
        } else if (action === "waitFor") {
          const limit = typeof st.timeout === "number" ? st.timeout : 5000;
          const end = performance.now() + limit;
          let el = find(doc, st.waitFor as Target);
          while (!el && performance.now() < end && !o.signal?.aborted) {
            await sleep(50, o.signal);
            el = find(doc, st.waitFor as Target);
          }
          if (!el) throw new Error(o.signal?.aborted ? "aborted while waiting" : `${describe(st.waitFor as Target)} did not appear within ${limit} ms`);
          done(true);
        } else if (action === "scroll") {
          const base = st.in !== undefined ? find(doc, st.in as Target) : focused(doc);
          const sc = scroller(base);
          if (!sc) throw new Error("nothing to scroll");
          sc.scrollBy({ top: Number(st.scroll) });
          done(true, { note: `scrollTop ${Math.round(sc.scrollTop)}` });
        } else if (action === "shot") {
          if (!o.shot) throw new Error("no screen to draw here");
          const pic = await o.shot(String(st.shot));
          shots.push(pic);
          done(true, { note: `${pic.width}x${pic.height}` });
        } else throw new Error("unknown step");
        // Let the app react (React commits, effects) before the next step.
        await sleep(60, o.signal);
      } catch (e) {
        done(false, { error: String((e as Error)?.message ?? e) });
        break;
      }
    }
  } finally {
    view.removeEventListener("error", onError);
    view.removeEventListener("unhandledrejection", onRejection);
    view.console.error = origError;
  }
  if (o.signal?.aborted && !aborted) aborted = String(o.signal.reason ?? "aborted");
  return { ok: !aborted && out.length === steps.length && out.every((r) => r.ok), ...(aborted ? { aborted } : {}), steps: out, errors: errors.slice(0, 30), text: visibleText(doc), shots, ms: Math.round(performance.now() - began) };
}
