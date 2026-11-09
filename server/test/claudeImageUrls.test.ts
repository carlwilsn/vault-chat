// Pasted images reach the engine as saved file paths (.vault-chat/captures/…); the Claude backend must turn
// them into base64 image blocks, or the agent receives only the text ("(image)").
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./helpers";
import { imageUrls } from "../engine/claude/backend";

describe("imageUrls", () => {
  const dir = tmp("vciu-");
  mkdirSync(dir, { recursive: true });
  const png = join(dir, "a.png");
  writeFileSync(png, Buffer.from([1, 2, 3, 4]));
  it("reads a saved capture path into a data URL", () => {
    expect(imageUrls([png])).toEqual([`data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}`]);
  });
  it("passes data URLs through; skips missing and non-image files", () => {
    writeFileSync(join(dir, "n.txt"), "x");
    expect(imageUrls(["data:image/png;base64,AAAA", join(dir, "gone.png"), join(dir, "n.txt")])).toEqual(["data:image/png;base64,AAAA"]);
    expect(imageUrls(undefined)).toEqual([]);
  });
});
