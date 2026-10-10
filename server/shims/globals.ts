// Browser globals the app modules touch at import time or at run time, made
// real enough for node. Must be imported before any src/ module (main.ts does
// it first, then dynamic-imports the rest).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { renameRetry } from "../atomic";
import { dirname } from "node:path";
import { loadConfig } from "../config";

/** localStorage backed by one JSON file ({key: string}), the same flat shape
 * the box's existing `mission-engine.localstorage` uses, so its VAPID keys and
 * settings carry over. Writes are atomic (temp + rename). */
export class FileLocalStorage {
  private data: Record<string, string> = {};
  constructor(private path: string) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) this.data[k] = String(v);
      }
    } catch {
      this.data = {};
    }
  }
  private flush(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameRetry(tmp, this.path);
    } catch (e) {
      console.warn("[localStorage] flush failed:", (e as Error).message);
    }
  }
  get length(): number {
    return Object.keys(this.data).length;
  }
  key(i: number): string | null {
    return Object.keys(this.data)[i] ?? null;
  }
  getItem(k: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k]! : null;
  }
  setItem(k: string, v: string): void {
    const s = String(v);
    if (this.data[k] === s) return;
    this.data[k] = s;
    this.flush();
  }
  removeItem(k: string): void {
    if (!(k in this.data)) return;
    delete this.data[k];
    this.flush();
  }
  clear(): void {
    this.data = {};
    this.flush();
  }
}

const g = globalThis as any;
const cfg = loadConfig();

g.localStorage = new FileLocalStorage(cfg.localStoragePath);
g.sessionStorage = new FileLocalStorage(`${cfg.stateDir}/session.tmp.json`);

// `window` = the global object, so window.setTimeout / window.localStorage work.
if (!g.window) g.window = g;
g.window.getSelection ??= () => ({ toString: () => "", rangeCount: 0, removeAllRanges() {} });
g.window.addEventListener ??= () => {};
g.window.removeEventListener ??= () => {};
g.window.dispatchEvent ??= () => true;
g.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
g.window.location ??= { search: "", href: "http://localhost/", origin: "http://localhost", hostname: "localhost" };
g.__VC_HEADLESS__ = true;

// Minimal document: enough for the few non-UI modules that create an element
// (e.g. html-to-text helpers) or set a dataset attribute.
function fakeElement(): any {
  return {
    style: {},
    dataset: {},
    children: [],
    appendChild() {},
    removeChild() {},
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    get textContent() {
      return this._text ?? "";
    },
    set textContent(v: string) {
      this._text = v;
    },
    innerHTML: "",
  };
}
if (!g.document) {
  g.document = {
    createElement: fakeElement,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    documentElement: fakeElement(),
    head: fakeElement(),
    body: fakeElement(),
    hasFocus: () => false,
    visibilityState: "hidden",
    hidden: true,
  };
}
