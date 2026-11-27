// The board a voice call lectures on: one vault page (BOARD_PAGE) whose state is the board's content, so Carl and the
// agent see, change and watch the same thing (PluginRead / PluginAct setState / wait on its path).
//
// The agent draws by writing a fenced block in its spoken reply (server/speakable.ts takes it out of the speech):
//
//   ```board
//   eq #m m_t = \beta_1 m_{t-1} + (1-\beta_1) g_t
//   text the running average of the gradient
//   ```
//
// One command per line (BOARD_HELP). The box parses it (parseBoard), applies it to the board's items (applyBoard:
// clear and erase really remove) and writes the result as the page's `scene` state ({next, items}); the page (server/boardPage.html)
// draws what is new and removes what is gone. `cut` (a time) makes the page finish every stroke at once: he talked
// over the voice, so nothing keeps moving.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readPluginState, setPluginState } from "./pluginState";
import BOARD_HTML from "./boardPage.html?raw";
import KATEX from "vc:katex-inline";

export const BOARD_PAGE = ".vault-chat/local/pages/board.html";
/** Bumped when the page changes: an older copy in a vault is replaced on the next draw. */
export const BOARD_VERSION = "4";

export const COLORS = ["red", "blue", "green", "orange", "purple", "gray", "black"] as const;
type Color = (typeof COLORS)[number];

export type BoardItem =
  | { n: number; id?: string; kind: "eq"; tex: string; row: number; h: number; color?: Color }
  | { n: number; id?: string; kind: "text"; text: string; row: number; h: number; color?: Color }
  | { n: number; id?: string; kind: "axes"; x0: number; x1: number; y0: number; y1: number }
  | { n: number; id?: string; kind: "plot"; expr: string; color?: Color }
  | { n: number; id?: string; kind: "point"; x: number; y: number; label?: string; color?: Color }
  | { n: number; id?: string; kind: "line" | "arrow"; x1: number; y1: number; x2: number; y2: number; color?: Color }
  | { n: number; id?: string; kind: "mark"; style: "box" | "highlight"; target: number; color?: Color };

export type BoardCmd =
  | { op: "clear" }
  | { op: "erase"; id: string }
  | { op: "mark"; style: "box" | "highlight"; id: string; color?: Color }
  | { op: "add"; item: DistributiveOmit<BoardItem, "n" | "row" | "h"> };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, Extract<keyof T, K>> : never;

/** What the agent is told about the board (the call's rules). */
export const BOARD_HELP =
  "eq [#id] <LaTeX> (a line of math), text [#id] <words, $math$ inline> (a line of words), axes <xmin> <xmax> <ymin> <ymax> (a graph on the right half), plot [#id] <y as an expression in x, e.g. x^2 or 2*x-1> [color], point [#id] <x> <y> [label], line|arrow [#id] <x1> <y1> <x2> <y2> [color] (graph coordinates), box #id | highlight #id (circle or underline an item), erase #id, clear. Colors: red blue green orange purple gray.";

/** Rows of the text column (top to bottom); a tall line (a fraction, a sum) takes two. */
export const ROWS = 11;
const TALL = /\\(?:d?frac|tfrac|sum|int|prod|binom|begin|sqrt\{[^}]*\\frac|lim_)/;

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

/** An expression in x the page may evaluate: digits, x, operators, parentheses and the usual functions, nothing else. */
const EXPR_WORDS = new Set(["x", "sin", "cos", "tan", "exp", "log", "ln", "sqrt", "abs", "pi", "e"]);
export function safeExpr(expr: string): string | null {
  const e = expr.trim();
  if (!e || e.length > 120 || !/^[0-9a-z.+\-*/^()\s,]+$/i.test(e)) return null;
  for (const w of e.toLowerCase().match(/[a-z]+/g) ?? []) if (!EXPR_WORDS.has(w)) return null;
  return e;
}

/** One block's text → commands, in order; lines that are not a command are left out (and named in `bad`). */
export function parseBoard(src: string): { cmds: BoardCmd[]; bad: string[] } {
  const cmds: BoardCmd[] = [];
  const bad: string[] = [];
  for (const raw of src.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([a-z]+)\b\s*(.*)$/i.exec(line);
    if (!m) { bad.push(line); continue; }
    const op = m[1]!.toLowerCase();
    let rest = m[2]!.trim();
    let id: string | undefined;
    const tag = /^#([\w-]{1,24})\s*/.exec(rest);
    if (tag) { id = tag[1]; rest = rest.slice(tag[0].length); }
    const words = rest.split(/\s+/).filter(Boolean);
    let color: Color | undefined;
    if (words.length && (COLORS as readonly string[]).includes(words[words.length - 1]!.toLowerCase()) && op !== "eq" && op !== "text") {
      color = words.pop()!.toLowerCase() as Color;
    }
    const withId = <T extends object>(o: T) => ({ ...o, ...(id ? { id } : {}), ...(color ? { color } : {}) });
    if (op === "clear") cmds.push({ op: "clear" });
    else if (op === "erase" && id) cmds.push({ op: "erase", id });
    else if ((op === "box" || op === "highlight" || op === "circle" || op === "underline") && id) cmds.push({ op: "mark", style: op === "box" || op === "circle" ? "box" : "highlight", id, ...(color ? { color } : {}) });
    else if ((op === "eq" || op === "math") && rest) cmds.push({ op: "add", item: withId({ kind: "eq" as const, tex: rest.replace(/^\$+|\$+$/g, "").trim() }) });
    else if ((op === "text" || op === "write" || op === "say") && rest) cmds.push({ op: "add", item: withId({ kind: "text" as const, text: rest }) });
    else if (op === "axes") {
      const [x0, x1, y0, y1] = words.map((w) => num(w));
      const ok = [x0, x1, y0, y1].every((v) => v !== null) && x1! > x0! && y1! > y0!;
      cmds.push({ op: "add", item: withId({ kind: "axes" as const, ...(ok ? { x0: x0!, x1: x1!, y0: y0!, y1: y1! } : { x0: -3, x1: 3, y0: -2, y1: 9 }) }) });
    } else if (op === "plot") {
      const expr = safeExpr(words.join(" ").replace(/^(?:y|f\(x\))\s*=?\s*/i, ""));
      if (expr) cmds.push({ op: "add", item: withId({ kind: "plot" as const, expr }) });
      else bad.push(line);
    } else if (op === "point" || op === "dot") {
      const x = num(words[0]), y = num(words[1]);
      if (x === null || y === null) { bad.push(line); continue; }
      const label = words.slice(2).join(" ");
      cmds.push({ op: "add", item: withId({ kind: "point" as const, x, y, ...(label ? { label } : {}) }) });
    } else if (op === "line" || op === "arrow") {
      const v = words.slice(0, 4).map((w) => num(w));
      if (v.length < 4 || v.some((x) => x === null)) { bad.push(line); continue; }
      cmds.push({ op: "add", item: withId({ kind: op, x1: v[0]!, y1: v[1]!, x2: v[2]!, y2: v[3]! }) });
    } else bad.push(line);
  }
  return { cmds, bad };
}

const isLine = (i: BoardItem): i is Extract<BoardItem, { kind: "eq" | "text" }> => i.kind === "eq" || i.kind === "text";

/** The board after the commands: what is on it now, in drawing order. Clear empties it; erase removes the item (and
 *  any mark on it); a line of math or words takes the next row. `n` numbers every item ever drawn (never reused). */
export function applyBoard(items: BoardItem[], cmds: BoardCmd[], next: number): { items: BoardItem[]; next: number } {
  let out = [...items];
  let n = next;
  for (const c of cmds) {
    if (c.op === "clear") out = [];
    else if (c.op === "erase") {
      const gone = new Set(out.filter((i) => i.id === c.id).map((i) => i.n));
      out = out.filter((i) => !gone.has(i.n) && !(i.kind === "mark" && gone.has(i.target)));
    } else if (c.op === "mark") {
      const target = [...out].reverse().find((i) => i.id === c.id && i.kind !== "mark");
      if (target) out.push({ n: n++, kind: "mark", style: c.style, target: target.n, ...(c.color ? { color: c.color } : {}) });
    } else {
      const item = c.item;
      if (item.id) out = out.filter((i) => i.id !== item.id || i.kind === "mark"); // the same tag again replaces it
      if (item.kind === "eq" || item.kind === "text") {
        const h = item.kind === "eq" && TALL.test(item.tex) ? 2 : 1;
        let row = out.filter(isLine).reduce((m, i) => Math.max(m, i.row + i.h), 0);
        if (row + h > ROWS) {
          // A full column starts again at the top: what was written there goes (the board has no scroll).
          const gone = new Set(out.filter(isLine).map((i) => i.n));
          out = out.filter((i) => !gone.has(i.n) && !(i.kind === "mark" && gone.has(i.target)));
          row = 0;
        }
        out.push({ ...item, n: n++, row, h } as BoardItem);
      } else out.push({ ...item, n: n++ } as BoardItem);
    }
  }
  return { items: out, next: n };
}

/** The page's html, KaTeX inlined (pages load nothing from the network). */
export function boardHtml(): string {
  return BOARD_HTML.replace("/*__KATEX_CSS__*/", () => KATEX.css).replace("/*__KATEX_JS__*/", () => KATEX.js).replace("__BOARD_VERSION__", BOARD_VERSION);
}

/** The board page in the vault, written (or replaced, when older) before it is drawn on. */
export function ensureBoardPage(vault: string): string {
  const file = join(vault, BOARD_PAGE);
  let have = "";
  try { have = existsSync(file) ? readFileSync(file, "utf8").slice(0, 400) : ""; } catch { /* unreadable: written again */ }
  if (!have.includes(`<meta name="vc-board" content="${BOARD_VERSION}">`)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, boardHtml());
  }
  return BOARD_PAGE;
}

/** The page's state: `scene` is the board ({next, items}: one record per draw), `cut` the last time he talked over it. */
export const SCENE_KEY = "scene";
type Scene = { next: number; items: BoardItem[] };
export function readScene(vault: string): Scene {
  const v = (readPluginState(vault, BOARD_PAGE).state as Record<string, unknown>)[SCENE_KEY] as Partial<Scene> | undefined;
  const items = Array.isArray(v?.items) ? (v!.items as BoardItem[]) : [];
  const next = typeof v?.next === "number" ? v.next : items.reduce((m, i) => Math.max(m, i.n + 1), 1);
  return { next, items };
}

/** Draw: the commands applied to the board as the box keeps it, written as its state (one record). */
export function drawOnBoard(vault: string, cmds: BoardCmd[]): { ok: true; seq: number; items: BoardItem[] } | { ok: false; error: string } {
  if (!cmds.length) return { ok: false, error: "no commands" };
  const page = ensureBoardPage(vault);
  const sc = readScene(vault);
  const out = applyBoard(sc.items, cmds, sc.next);
  const w = setPluginState(vault, page, JSON.stringify({ key: SCENE_KEY, value: { next: out.next, items: out.items } }));
  return "seq" in w ? { ok: true, seq: w.seq, items: out.items } : { ok: false, error: w.error };
}

/** He talked over the voice: every stroke on the page finishes at once. */
export function haltBoard(vault: string): void {
  const page = ensureBoardPage(vault);
  setPluginState(vault, page, JSON.stringify({ key: "cut", value: Date.now() }));
}

/** A short reading of the board for the agent ("#m eq m_t = …"), newest last. */
export function describeBoard(items: BoardItem[]): string {
  return items
    .filter((i) => i.kind !== "mark")
    .map((i) => {
      const tag = i.id ? `#${i.id} ` : "";
      if (i.kind === "eq") return `${tag}eq ${i.tex}`;
      if (i.kind === "text") return `${tag}text ${i.text}`;
      if (i.kind === "axes") return `${tag}axes ${i.x0} ${i.x1} ${i.y0} ${i.y1}`;
      if (i.kind === "plot") return `${tag}plot ${i.expr}`;
      if (i.kind === "point") return `${tag}point ${i.x} ${i.y}${i.label ? ` ${i.label}` : ""}`;
      return `${tag}${i.kind} ${i.x1} ${i.y1} ${i.x2} ${i.y2}`;
    })
    .join("; ");
}
