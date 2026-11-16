// Scripted steps run against a document: the in-app half of the agent's Drive tool (server/driveTool.ts), the way
// RecordUI drives a page, but inside the real laptop app (its Drive window, src/driveRunner.ts). Pure DOM: the events
// it dispatches are synthetic (isTrusted false), so the app's own perf probe never counts them and Carl's input
// detector (src/userActivity.ts) never mistakes them for him.
//
// Steps (one action each):
//   {click: "css"} | {click: {text: "Save"}}      pointer + mouse events and a click at the element's centre; focuses it
//   {hover: ...same}                               pointerover/enter/move
//   {type: "hello", into?: "css" | {text}}        text into the focused (or given) field, as typing would insert it
//   {press: "Control+K"}                           keydown/keyup (Enter, Escape, Tab, Backspace, Arrow*, F1-F12, a, ...)
//   {wait: 500}                                    ms (at most 10 s)
//   {waitFor: "css" | {text}, timeout?: ms}        until it is on screen (default 5 s, at most 30 s); fails otherwise
//   {scroll: 600, in?: "css"}                      scroll the given (or the focused element's nearest) scroller
//   {shot: "name"}                                 a picture of the window (the caller's `shot`)
export type Target = string | { text: string };
export type Step =
  | { click: Target }
  | { hover: Target }
  | { type: string; into?: Target }
  | { press: string }
  | { wait: number }
  | { waitFor: Target; timeout?: number }
  | { scroll: number; in?: Target }
  | { shot: string };
export type StepOutcome = { i: number; action: string; ok: boolean; ms: number; note?: string; error?: string };
export type Shot = { name: string; data: string; mimeType: string; width: number; height: number };
export type StepsResult = { ok: boolean; aborted?: string; steps: StepOutcome[]; errors: string[]; text: string; shots: Shot[]; ms: number };

export const STEP_ACTIONS = ["click", "hover", "type", "press", "wait", "waitFor", "scroll", "shot"] as const;
export const MAX_STEPS = 40;
export const MAX_SHOTS = 4;

const describe = (t: Target) => (typeof t === "string" ? t : `text "${t.text}"`);
export function stepAction(s: Step): string {
  return STEP_ACTIONS.find((a) => a in (s as object)) ?? "?";
}

/** The steps, checked: a list of objects with exactly one known action and sane values. A string is why not. */
export function checkSteps(raw: unknown): Step[] | string {
  if (!Array.isArray(raw) || !raw.length) return "steps must be a non-empty list";
  if (raw.length > MAX_STEPS) return `at most ${MAX_STEPS} steps`;
  let shots = 0;
  const target = (v: unknown) => (typeof v === "string" && v.trim()) || (v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string" && (v as { text: string }).text.trim());
  for (const [i, s] of raw.entries()) {
    if (!s || typeof s !== "object") return `step ${i + 1} is not an object`;
    const acts = STEP_ACTIONS.filter((a) => a in s);
    if (acts.length !== 1) return `step ${i + 1} needs exactly one of: ${STEP_ACTIONS.join(", ")}`;
    const o = s as Record<string, unknown>;
    const a = acts[0]!;
    if ((a === "click" || a === "hover" || a === "waitFor") && !target(o[a])) return `step ${i + 1}: ${a} needs a CSS selector or {text}`;
    if (a === "type" && (typeof o.type !== "string" || o.type.length > 2000)) return `step ${i + 1}: type needs text (at most 2000 characters)`;
    if (a === "type" && o.into !== undefined && !target(o.into)) return `step ${i + 1}: into needs a CSS selector or {text}`;
    if (a === "press" && (typeof o.press !== "string" || !parseKey(o.press))) return `step ${i + 1}: press needs a key like "Enter" or "Control+K"`;
    if (a === "wait" && !(typeof o.wait === "number" && o.wait >= 0 && o.wait <= 10_000)) return `step ${i + 1}: wait is 0-10000 ms`;
    if (a === "waitFor" && o.timeout !== undefined && !(typeof o.timeout === "number" && o.timeout > 0 && o.timeout <= 30_000)) return `step ${i + 1}: timeout is at most 30000 ms`;
    if (a === "scroll" && !(typeof o.scroll === "number" && Number.isFinite(o.scroll))) return `step ${i + 1}: scroll needs a number of pixels`;
    if (a === "scroll" && o.in !== undefined && !target(o.in)) return `step ${i + 1}: in needs a CSS selector or {text}`;
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
    else if (m === "mod") mods.ctrlKey = true; // the laptop is Windows: Mod is Control
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

/** The element a target names, on screen: a CSS selector's first visible match, or the smallest visible element whose
 *  text (or aria-label / title) contains the text, clickable things first. */
export function find(doc: Document, t: Target): Element | null {
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

function centre(el: Element) {
  const r = el.getBoundingClientRect();
  return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
}

function pointer(el: Element, type: string, extra: Record<string, unknown> = {}) {
  const view = el.ownerDocument.defaultView!;
  const init = { bubbles: true, cancelable: true, composed: true, view, button: 0, buttons: type.endsWith("down") ? 1 : 0, ...centre(el), ...extra };
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
        if (action === "click" || action === "hover") {
          const el = find(doc, st[action] as Target);
          if (!el) throw new Error(`nothing on screen matches ${describe(st[action] as Target)}`);
          if (action === "click") click(el);
          else hover(el);
          done(true, { note: `<${el.tagName.toLowerCase()}>${((el as HTMLElement).innerText ?? "").trim().slice(0, 60)}` });
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
