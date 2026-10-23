// BoardLook (Carl, 2026-10-22, on a laptop call: "look at just my whiteboard" got "I see the lecture PDF on your
// screen, not the Physics whiteboard. Switch back to the whiteboard and I'll look at it."): the agent sees any board
// as its files have it — named, or his most recent — whether or not it is on a screen, with the part he had in view
// on the iPad (view.png) and the whole board (overview.png) attached as images all the way to the model.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault } from "./helpers";
import { findBoard, lookBoard } from "../boards";
import { sideToolSpecs, toolAnswer, voiceSideToolSpecs } from "../engine/engine";
import { hostToolContent } from "../engine/pi/ext/policy.mjs";
import { ENGINE_ROLE_PROMPT } from "../engine/prompt";
import { buildVoicePrompt } from "../../src/voicePrompt";

// Two different 1×1 PNGs (the view and the overview).
const PNG_A = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
const PNG_B = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

function board(vault: string, slug: string, name: string, updated: number, pics: { view?: Buffer; overview?: Buffer } = {}) {
  const dir = join(vault, "boards", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "board.json"), JSON.stringify({ v: 2, name, created: updated, updated, rev: 3, grid: "grid", strokes: [{ id: "s1", tool: "pen", w: 2, color: "#000", xy: [0, 0, 10, 10] }], items: [] }));
  if (pics.view) writeFileSync(join(dir, "view.png"), pics.view);
  if (pics.overview) writeFileSync(join(dir, "overview.png"), pics.overview);
}

describe("BoardLook", () => {
  let home: string;
  let vault: string;
  beforeAll(() => {
    home = tmp();
    vault = makeVault(join(home, "vault"));
    board(vault, "physics", "Physics", 2_000, { view: PNG_A, overview: PNG_B });
    board(vault, "board-oct-21", "Board Oct 21", 3_000, { overview: PNG_B });
    board(vault, "lecture-3-fourier", "Lecture 3 Fourier", 1_000);
  });
  afterAll(() => cleanup(home));

  it("finds the board he names, in his words, or his most recent", () => {
    const boards = [
      { slug: "board-oct-21", name: "Board Oct 21", updated: 3, strokes: 1, items: 0 },
      { slug: "physics", name: "Physics", updated: 2, strokes: 1, items: 0 },
      { slug: "lecture-3-fourier", name: "Lecture 3 Fourier", updated: 1, strokes: 0, items: 0 },
    ];
    expect(findBoard(boards, "the Physics whiteboard")?.slug).toBe("physics");
    expect(findBoard(boards, "physics")?.slug).toBe("physics");
    expect(findBoard(boards, "fourier")?.slug).toBe("lecture-3-fourier");
    expect(findBoard(boards, "")?.slug).toBe("board-oct-21");
    expect(findBoard(boards, "my whiteboard")?.slug).toBe("board-oct-21", "only filler words: his latest");
    expect(findBoard(boards, undefined)?.slug).toBe("board-oct-21");
    expect(findBoard(boards, "chemistry")).toBeNull();
  });

  it("a named board, off every screen: its view and its whole board attached as images", () => {
    const r = lookBoard(vault, "Physics whiteboard");
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Board "Physics", boards\/physics\//);
    expect(r.text).toMatch(/whether or not the board is on a screen now/);
    expect(r.text).toMatch(/the part he had in view on the iPad \(boards\/physics\/view\.png\); the whole board \(boards\/physics\/overview\.png\)/);
    expect(r.images.map((i) => [i.mimeType, Buffer.from(i.data, "base64").equals(PNG_A)])).toEqual([["image/png", true], ["image/png", false]]);
    expect(Buffer.from(r.images[1]!.data, "base64").equals(PNG_B)).toBe(true);
  });

  it("no name: his most recently changed board; none matching: says which boards there are; none saved: says so", () => {
    const latest = lookBoard(vault);
    expect(latest.text).toMatch(/^Board "Board Oct 21" \(his most recently changed board\)/);
    expect(latest.images).toHaveLength(1);
    const none = lookBoard(vault, "chemistry");
    expect(none.ok).toBe(false);
    expect(none.text).toMatch(/No board matches "chemistry"\. His boards, newest first: "Board Oct 21", "Physics", "Lecture 3 Fourier"\./);
    const bare = lookBoard(vault, "fourier");
    expect(bare.images).toEqual([]);
    expect(bare.text).toMatch(/no saved picture yet/);
  });

  it("the agent has it in every turn, in Ctrl+K / Ctrl+L and in voice's Ask (a question too); its images reach pi as image blocks", () => {
    expect(sideToolSpecs().some((t) => t.name === "BoardLook")).toBe(true);
    expect(voiceSideToolSpecs(false).some((t) => t.name === "BoardLook")).toBe(true);
    expect(voiceSideToolSpecs(true).some((t) => t.name === "BoardLook")).toBe(true);
    const ans = toolAnswer({ success: true, contentItems: [{ type: "inputText", text: "Board" }, { type: "inputImage", data: PNG_A.toString("base64"), mimeType: "image/png" }] });
    expect(ans).toEqual({ ok: true, text: "Board", images: [{ data: PNG_A.toString("base64"), mimeType: "image/png" }] });
    expect(toolAnswer({ success: true, contentItems: [{ type: "inputText", text: "plain" }] })).toEqual({ ok: true, text: "plain" });
    expect(hostToolContent({ text: "Board", images: ans.images })).toEqual([
      { type: "text", text: "Board" },
      { type: "image", data: PNG_A.toString("base64"), mimeType: "image/png" },
    ]);
    expect(hostToolContent({ text: "x" })).toEqual([{ type: "text", text: "x" }]);
    expect(ENGINE_ROLE_PROMPT).toMatch(/BoardLook \{board\?\} shows a board as last saved/);
  });

  it("the voice off the board (laptop, phone) hands 'look at my whiteboard' to the agent instead of reading its own screen", () => {
    for (const device of ["laptop", "phone"] as const) expect(buildVoicePrompt({ device })).toMatch(/Ask the agent to look at that board .* Never answer from this screen instead/);
    expect(buildVoicePrompt({ device: "board" })).not.toMatch(/His iPad whiteboard is not on this screen/);
  });
});
