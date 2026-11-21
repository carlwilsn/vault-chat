// Offer events in the event log, searchable with no 7-day limit and no device (server/offerLog.ts, box:history), and
// the daily backup of every vault's event log and the engine's transcripts (server/dailyBackup.ts). Before, offer
// events lived only in the app (20 per part) and the event log had no backup since a hand-made copy on 10-30.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConvLogs } from "../convlog/log";
import { offerEventsRoute, searchOfferEvents } from "../offerLog";
import { pluginOfferTool } from "../pluginOffersTool";
import { runDailyBackup, KEEP_DAYS } from "../dailyBackup";

const home = mkdtempSync(join(tmpdir(), "vc-offerlog-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("offer events in the event log", () => {
  it("the route keeps each as a record; box:history reads and searches them, credentials cut", async () => {
    const vault = join(home, "v");
    mkdirSync(join(vault, ".vault-chat"), { recursive: true });
    _resetConvLogs();
    const day = 86_400_000;
    const old = Date.now() - 30 * day;
    expect(offerEventsRoute(vault, { client: "laptop", events: [
      { plugin: "app/viewer", event: "opened", at: old, payload: '{"path":"hw/hw4.md","page":4}' },
      { plugin: "app/chats", event: "selected", at: Date.now(), payload: '{"id":"main","token":"abcdefghijkl"}' },
      { event: "no plugin" },
    ] }).body).toEqual({ ok: true, kept: 2 });
    expect(offerEventsRoute(vault, {}).status).toBe(400);
    // A month old is still there (no 7-day limit).
    expect(searchOfferEvents([vault], { query: "hw4" }).map((r) => r.event)).toEqual(["opened"]);
    expect(searchOfferEvents([vault], { days: 7 }).map((r) => r.plugin)).toEqual(["app/chats"]);
    const d = { vault, emit: () => {}, vaults: () => [{ name: "v", path: vault }] };
    const recent = await pluginOfferTool(d as any, "PluginRead", { plugin: "box:history" });
    expect(recent.text).toMatch(/laptop app\/viewer opened .*hw\/hw4\.md/);
    expect(recent.text).toContain("[secret]");
    expect(recent.text).not.toContain("abcdefghijkl");
    const search = await pluginOfferTool(d as any, "PluginAct", { plugin: "box:history", action: "search", args: { query: "page", plugin: "app/viewer" } });
    expect(search.ok).toBe(true);
    expect(search.text).toMatch(/app\/viewer opened/);
  });
});

describe("the daily backup", () => {
  it("copies on the first day, links what did not change after, copies what grew, skips a day it has, keeps 14 days", () => {
    const src = join(home, "events");
    mkdirSync(join(src, "sessions"), { recursive: true });
    writeFileSync(join(src, "main.jsonl"), "a\n");
    writeFileSync(join(src, "sessions", "s1.jsonl"), "s\n");
    const t = new Date("2026-11-01T00:00:00Z");
    for (const f of ["main.jsonl", "sessions/s1.jsonl"]) utimesSync(join(src, f), t, t);
    const root = join(home, "backups");
    const D = Date.parse("2026-11-21T12:00:00Z");
    const r1 = runDailyBackup(root, [{ label: "vault-v", dir: src }], D);
    expect(r1).toMatchObject({ day: "2026-11-21", files: 2, copied: 2, linked: 0 });
    expect(readFileSync(join(root, "2026-11-21", "vault-v", "sessions", "s1.jsonl"), "utf8")).toBe("s\n");
    expect(runDailyBackup(root, [{ label: "vault-v", dir: src }], D + 3600_000).skipped).toBe(true);
    writeFileSync(join(src, "main.jsonl"), "a\nb\n");
    const r2 = runDailyBackup(root, [{ label: "vault-v", dir: src }], D + 86_400_000);
    expect(r2).toMatchObject({ copied: 1, linked: 1 });
    // Yesterday's copy is its own: the append did not reach it.
    expect(readFileSync(join(root, "2026-11-21", "vault-v", "main.jsonl"), "utf8")).toBe("a\n");
    expect(statSync(join(root, "2026-11-22", "vault-v", "sessions", "s1.jsonl")).ino).toBe(statSync(join(root, "2026-11-21", "vault-v", "sessions", "s1.jsonl")).ino);
    for (let i = 2; i < KEEP_DAYS + 3; i++) runDailyBackup(root, [{ label: "vault-v", dir: src }], D + i * 86_400_000);
    expect(existsSync(join(root, "2026-11-21"))).toBe(false);
    expect(existsSync(join(root, new Date(D + (KEEP_DAYS + 2) * 86_400_000).toISOString().slice(0, 10)))).toBe(true);
  });
});
