// The native Undo's choice (server/changeNotices.ts undoLast, src-tauri/src/safety.rs): the newest kept change switches
// back, and the box says which version is in effect after it, so the laptop's loader runs the box's choice of core rather
// than its own previous one (2026-11-28: the Undo ran the laptop's older 6816d9d7, then a second reload reached 4c1862ce).
import { describe, expect, it, vi } from "vitest";
import type { ChangeRecord } from "../../src/pluginDrafts";

vi.mock("../../src-tauri/assets/phone.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/voice.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/icon-apple-touch.png", () => ({ default: "" }));
vi.mock("vc:phone-app", () => ({ default: {} }));

const { undoLast } = await import("../changeNotices");

describe("undoLast", () => {
  it("names the core the switch went back to", () => {
    const now = 1_800_000_000_000;
    const recs: ChangeRecord[] = [
      { seq: 1, plugin: "app/core", change: "keep", version: "4c1862ce", from: "44a4f108", at: now - 7_200_000, by: "gate" } as ChangeRecord,
      { seq: 2, plugin: "app/core", change: "keep", version: "57cd5db3", from: "4c1862ce", at: now - 3_600_000, by: "gate" } as ChangeRecord,
    ];
    const r = undoLast(
      {
        plugins: () => ["app/core"],
        changes: () => recs,
        write: (b, by) => {
          // The supervisor's switch: back to what the newest keep replaced.
          recs.push({ seq: recs.length + 1, plugin: "app/core", change: "switch", version: "4c1862ce", from: "57cd5db3", at: now, by, reason: String(b.reason) } as ChangeRecord);
          return { ok: true, text: "switched" };
        },
        now: () => now,
      },
      { by: "auto", reason: "the app stopped responding" },
    );
    expect(r.ok).toBe(true);
    expect(r.undone).toHaveLength(1);
    expect(r.undone[0]).toMatchObject({ plugin: "app/core", version: "57cd5db3", to: "4c1862ce" });
  });
});
