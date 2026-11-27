// The voice call's board (server/board.ts): the agent's ```board lines parsed into commands, applied to what is on
// the board (clear and erase really remove), written as the board page's state, and the page itself written into the
// vault with KaTeX inline (pages load nothing).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";

const root = tmp("vcboard-");
const vault = join(root, "vault");
let board: typeof import("../board");
let st: typeof import("../pluginState");
let log: typeof import("../convlog/log");

beforeAll(async () => {
  for (const k of Object.keys(process.env)) if (k.startsWith("VC_")) delete process.env[k];
  process.env.VC_STATE_DIR = join(root, "state");
  process.env.VC_VAULT = vault;
  board = await import("../board");
  st = await import("../pluginState");
  log = await import("../convlog/log");
});
afterAll(() => {
  log._resetConvLogs();
  cleanup(root);
});

describe("board commands", () => {
  it("parses each line into a command, with tags and colors, and names the lines it can't read", () => {
    const { cmds, bad } = board.parseBoard([
      "clear",
      "eq #m m_t = \\beta_1 m_{t-1} + (1-\\beta_1) g_t",
      "text the running average of $g_t$",
      "axes -3 3 -1 9",
      "plot y = x^2",
      "plot y x^2 blue",
      "plot f(x) = sin(x) red",
      "point #p 1 1 tangent point",
      "line #tan 0 -1 2 3 red",
      "arrow 0 0 1 2",
      "highlight #m",
      "box #p green",
      "erase #tan",
      "plot require('fs')",
      "wobble the board",
    ].join("\n"));
    expect(bad).toEqual(["plot require('fs')", "wobble the board"]);
    expect(cmds.map((c) => (c.op === "add" ? c.item.kind : c.op))).toEqual(["clear", "eq", "text", "axes", "plot", "plot", "plot", "point", "line", "arrow", "mark", "mark", "erase"]);
    expect(cmds[1]).toEqual({ op: "add", item: { kind: "eq", id: "m", tex: "m_t = \\beta_1 m_{t-1} + (1-\\beta_1) g_t" } });
    expect(cmds[5]).toEqual({ op: "add", item: { kind: "plot", expr: "x^2", color: "blue" } });
    expect(cmds[6]).toEqual({ op: "add", item: { kind: "plot", expr: "sin(x)", color: "red" } });
    expect(cmds[7]).toEqual({ op: "add", item: { kind: "point", id: "p", x: 1, y: 1, label: "tangent point" } });
    expect(cmds[11]).toEqual({ op: "mark", style: "box", id: "p", color: "green" });
  });

  it("only plain math reaches the page as an expression", () => {
    expect(board.safeExpr("2*x - 1")).toBe("2*x - 1");
    expect(board.safeExpr("exp(-x^2)")).toBe("exp(-x^2)");
    expect(board.safeExpr("constructor")).toBeNull();
    expect(board.safeExpr("x; alert(1)")).toBeNull();
  });

  it("clear empties the board, erase removes an item and the marks on it, numbers are never reused", () => {
    const p = (s: string) => board.parseBoard(s).cmds;
    let b = board.applyBoard([], p("eq #a a=1\neq #b b=2\nhighlight #a"), 1);
    expect(b.items.map((i) => [i.n, i.kind, "row" in i ? i.row : null])).toEqual([[1, "eq", 0], [2, "eq", 1], [3, "mark", null]]);
    b = board.applyBoard(b.items, p("erase #a"), b.next);
    expect(b.items.map((i) => i.n)).toEqual([2]);
    b = board.applyBoard(b.items, p("clear\ntext again"), b.next);
    expect(b.items).toEqual([{ n: 4, kind: "text", text: "again", row: 0, h: 1 }]);
    expect(b.next).toBe(5);
    // A tall line takes two rows; a full column starts again at the top.
    b = board.applyBoard(b.items, p("eq \\frac{a}{b}"), b.next);
    expect(b.items.at(-1)).toMatchObject({ row: 1, h: 2 });
    for (let i = 0; i < board.ROWS; i++) b = board.applyBoard(b.items, p(`text line ${i}`), b.next);
    expect(b.items.filter((i) => i.kind === "text").every((i) => "row" in i && i.row + i.h <= board.ROWS)).toBe(true);
  });
});

describe("the board page", () => {
  it("is written into the vault with KaTeX inline, and drawing writes the board as its state (one record)", () => {
    const r = board.drawOnBoard(vault, board.parseBoard("eq #m m_t\naxes -2 2 0 4\nplot x^2").cmds);
    expect(r.ok).toBe(true);
    const html = readFileSync(join(vault, board.BOARD_PAGE), "utf8");
    expect(html).toContain(`<meta name="vc-board" content="${board.BOARD_VERSION}">`);
    expect(html).toContain("katex.render");
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    const state = st.readPluginState(vault, board.BOARD_PAGE).state as any;
    expect(state.scene.items.map((i: any) => i.kind)).toEqual(["eq", "axes", "plot"]);
    board.drawOnBoard(vault, board.parseBoard("clear").cmds);
    expect((st.readPluginState(vault, board.BOARD_PAGE).state as any).scene).toEqual({ next: 4, items: [] });
    board.haltBoard(vault);
    expect(typeof (st.readPluginState(vault, board.BOARD_PAGE).state as any).cut).toBe("number");
  });
});
