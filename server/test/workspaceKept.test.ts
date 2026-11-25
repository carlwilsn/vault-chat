// The laptop's layout kept on the box per vault (server/layoutTool.ts): it outlives a box restart, the laptop's start
// reads its tiles back (GET /api/v2/layout), and the first tiles after an older split write a backup of it first.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = mkdtempSync(join(tmpdir(), "vc-workspace-"));
process.env.VC_STATE_DIR = state;
afterAll(() => rmSync(state, { recursive: true, force: true }));

const { flushStored, keepLaptopLayout, keptLayout, keptWindowNumbers, keptWindows, resetKeptLayout, storedLayout } = await import("../layoutTool");

const legacy = { split: true, direction: "side-by-side", panes: [{ side: "left", file: "a.md", active: true }, { side: "right", file: "b.md", active: false }], rightPanelOpen: true };
const tiled = { ...legacy, tiles: [{ tile: "t1", spot: "left", file: "a.md" }, { tile: "t2", spot: "right", chat: "main", focused: true }], tileSplit: { x: 0.4, xb: 0.4, left: 0.5, right: 0.5 } };

describe("the workspace's layout, kept on the box", () => {
  it("per vault, on disk: a restart (the module's memory gone) reads it back", async () => {
    keepLaptopLayout(legacy, "school2");
    await new Promise((r) => setTimeout(r, 5));
    keepLaptopLayout({ ...legacy, panes: [] }, "other");
    flushStored();
    expect(existsSync(join(state, "workspace.json"))).toBe(true);
    resetKeptLayout();
    expect(storedLayout("school2")?.layout).toEqual(legacy);
    expect(storedLayout("nope")).toBeNull();
    // The newest vault's layout is the read-back until the laptop says more.
    expect(keptLayout()?.layout).toEqual({ ...legacy, panes: [] });
  });

  it("the first tiles after an older split: the older layout is backed up first, never lost", () => {
    keepLaptopLayout(tiled, "school2", { coreSwap: { panes: ["a.md", "b.md"] } });
    flushStored();
    const dir = join(state, "backups", "workspace");
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const b = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
    expect(b.vault).toBe("school2");
    expect(b.before.layout).toEqual(legacy);
    expect(b.migratedFrom).toEqual({ coreSwap: { panes: ["a.md", "b.md"] } });
    resetKeptLayout();
    expect(storedLayout("school2")?.layout).toEqual(tiled);
    // Tiles after tiles: no more backups.
    keepLaptopLayout({ ...tiled, tileSplit: { x: 0.6, xb: 0.6, left: 0.5, right: 0.5 } }, "school2");
    flushStored();
    expect(readdirSync(dir).length).toBe(1);
  });

  it("a bad file is not fatal: it starts empty and is replaced on the next write", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(state, "workspace.json"), "{not json");
    resetKeptLayout();
    expect(storedLayout("school2")).toBeNull();
    keepLaptopLayout(tiled, "school2");
    flushStored();
    resetKeptLayout();
    expect(storedLayout("school2")?.layout).toEqual(tiled);
  });

  it("a New window's tiles are its own, kept by window: across a restart, and dropped when it is closed", () => {
    resetKeptLayout();
    keepLaptopLayout(tiled, "school2");
    const second = { ...tiled, leftPanelOpen: false, tiles: [{ tile: "w1", spot: "full", chat: "c-2" }] };
    keepLaptopLayout(second, "school2", undefined, 2);
    flushStored();
    resetKeptLayout();
    // The main window's stays the main window's; window 2's comes back by itself.
    expect(storedLayout("school2")?.layout).toEqual(tiled);
    expect(storedLayout("school2", 2)?.layout).toEqual({ ...second, window: 2 });
    expect(keptWindowNumbers("school2")).toEqual([2]);
    expect(keptWindows().map((w) => w.window)).toEqual([1, 2]);
    // A layout that says its own window is kept there too.
    keepLaptopLayout({ ...second, window: 2, tileSplit: { x: 0.3, xb: 0.3, left: 0.5, right: 0.5 } }, "school2");
    expect((storedLayout("school2", 2)?.layout as { tileSplit: { x: number } }).tileSplit.x).toBe(0.3);
    expect(storedLayout("school2")?.layout).toEqual(tiled);
    // Closed: gone, on disk too.
    keepLaptopLayout(undefined, "school2", undefined, 2, true);
    flushStored();
    resetKeptLayout();
    expect(storedLayout("school2", 2)).toBeNull();
    expect(keptWindowNumbers("school2")).toEqual([]);
    expect(storedLayout("school2")?.layout).toEqual(tiled);
  });
});
