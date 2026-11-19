// The Mac friend channel's gating rules (server/macFriend.ts): a version reaches the friend only when it passed every
// Mac check, soaked 24 h on Carl's laptop, and brought no new app error; at most every 7 days unless Carl asks.
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { decide, errorSignature, friendTick, isAppError, macFriendTool, parseReleases, readFriendState, type LaptopBuild, type LaptopError, type Release } from "../macFriend";

const H = 3_600_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");
const at = (h: number) => new Date(T0 + h * H).toISOString();
const rel = (version: string, macPassed = true): Release => ({ version, macPassed });
const ran = (version: string, h: number): LaptopBuild => ({ at: at(h), version, nativeVersion: version });
const err = (h: number, data: string, ev = "console.error"): LaptopError => ({ at: at(h), ev, data });

describe("the gates", () => {
  const builds = [ran("1.0.0", 0), ran("1.0.1", 10), ran("1.0.2", 20)];

  it("promotes the newest release that passed the Mac checks and soaked 24 h", () => {
    const d = decide({ now: T0 + 50 * H, releases: [rel("1.0.0"), rel("1.0.1"), rel("1.0.2")], builds, errors: [], friend: "1.0.0", last: null });
    expect(d.promote).toBe("1.0.2");
    expect(d.candidates.map((c) => c.version)).toEqual(["1.0.2", "1.0.1"]);
  });

  it("never a release whose Mac checks did not pass, however long it soaked", () => {
    const d = decide({ now: T0 + 500 * H, releases: [rel("1.0.1"), rel("1.0.2", false)], builds, errors: [], friend: "1.0.0", last: null });
    expect(d.promote).toBe("1.0.1");
    expect(d.candidates[0]).toMatchObject({ version: "1.0.2", ok: false });
    expect(d.candidates[0]!.why).toMatch(/Mac checks did not pass/);
    expect(decide({ now: T0 + 500 * H, releases: [rel("1.0.1", false)], builds, errors: [], friend: "1.0.0", last: null }).promote).toBeNull();
  });

  it("waits out the soak, and never takes a version Carl's laptop never ran", () => {
    const d = decide({ now: T0 + 40 * H, releases: [rel("1.0.2")], builds, errors: [], friend: "1.0.0", last: null });
    expect(d.promote).toBeNull();
    expect(d.candidates[0]!.why).toMatch(/soaking: .*20 of 24 h/);
    const never = decide({ now: T0 + 500 * H, releases: [rel("1.0.3")], builds, errors: [], friend: "1.0.0", last: null });
    expect(never.promote).toBeNull();
    expect(never.candidates[0]!.why).toMatch(/never ran on Carl's laptop/);
    // The core version string does not count: the native shell is what the friend would install.
    const coreOnly = decide({ now: T0 + 500 * H, releases: [rel("1.0.3")], builds: [{ at: at(0), version: "1.0.3+core.abcdef12", nativeVersion: "1.0.0" }], errors: [], friend: null, last: null });
    expect(coreOnly.promote).toBeNull();
  });

  it("holds on a new app error since the version arrived, and falls back to an older clean one", () => {
    const d = decide({ now: T0 + 60 * H, releases: [rel("1.0.1"), rel("1.0.2")], builds, errors: [err(25, "TypeError: x is undefined at 1234", "window.error")], friend: "1.0.0", last: null });
    expect(d.candidates.find((c) => c.version === "1.0.2")!.why).toMatch(/held: 1 new app error/);
    // 1.0.1 arrived at h10, before the error: it is held too (its code is in every later build) — conservative.
    expect(d.promote).toBeNull();
    // An error that stopped before a version arrived does not hold that version.
    const later = decide({ now: T0 + 60 * H, releases: [rel("1.0.2")], builds, errors: [err(15, "TypeError: boom", "unhandledrejection")], friend: "1.0.0", last: null });
    expect(later.promote).toBe("1.0.2");
  });

  it("errors the friend already lives with, and transport noise, do not hold", () => {
    const errors = [err(-5, "[notes] status-update failed: not found"), err(30, "[notes] status-update failed: not found"), err(31, "[notes] load failed: error sending request for url (https://box/notes)"), err(32, "[notes] load failed: HTTP 502"), { at: at(33), ev: "box.feed", data: "drop" }];
    const d = decide({ now: T0 + 60 * H, releases: [rel("1.0.2")], builds, errors, friend: "1.0.0", last: null });
    expect(d.promote).toBe("1.0.2");
    expect(isAppError(errors[2]!)).toBe(false);
    expect(errorSignature(err(1, "failed at 0x1f2e3d4c line 12"))).toBe(errorSignature(err(2, "failed at 0xdeadbeef1 line 99")));
  });

  it("at most every 7 days, unless Carl asks (which never skips a gate)", () => {
    const last = { version: "1.0.0", at: at(-24), tag: "mac-friend-v1.0.0", by: "timer" as const };
    const d = decide({ now: T0 + 50 * H, releases: [rel("1.0.2")], builds, errors: [], friend: "1.0.0", last });
    expect(d.promote).toBeNull();
    expect(d.why).toMatch(/next window/);
    expect(decide({ now: T0 + 50 * H, releases: [rel("1.0.2")], builds, errors: [], friend: "1.0.0", last, force: true }).promote).toBe("1.0.2");
    expect(decide({ now: T0 + 50 * H, releases: [rel("1.0.2", false)], builds, errors: [], friend: "1.0.0", last, force: true }).promote).toBeNull();
    expect(decide({ now: T0 + 7 * 24 * H, releases: [rel("1.0.2")], builds, errors: [], friend: "1.0.0", last }).promote).toBe("1.0.2");
  });

  it("only published v* releases count, and a release passed the Mac checks only with mac-update.json", () => {
    const r = parseReleases([
      { tag_name: "v1.0.2", assets: [{ name: "mac-update.json" }, { name: "mac-proof.zip" }] },
      { tag_name: "v1.0.1", assets: [{ name: "mac-proof.zip" }] },
      { tag_name: "v1.0.3", draft: true, assets: [{ name: "mac-update.json" }] },
      { tag_name: "mac-stable", prerelease: true, assets: [{ name: "latest-mac.json" }] },
    ]);
    expect(r).toEqual([{ version: "1.0.2", macPassed: true }, { version: "1.0.1", macPassed: false }]);
  });
});

describe("the box's tick", () => {
  function box() {
    const dir = tmp("mac-friend-");
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs", "host-builds.jsonl"), [ran("1.0.0", 0), ran("1.0.2", 20)].map((b) => JSON.stringify({ host: "laptop", revision: "r", surface: "tauri-production", ...b })).join("\n") + "\n");
    writeFileSync(join(dir, "logs", "app.jsonl"), JSON.stringify({ ...err(30, "[notes] load failed: HTTP 502"), device: "laptop" }) + "\n");
    return dir;
  }
  const fetchJson = (friend: string | null) => async (url: string) =>
    url.includes("api.github.com") ? [{ tag_name: "v1.0.2", assets: [{ name: "mac-update.json" }] }, { tag_name: "v1.0.0", assets: [] }] : friend ? { version: friend } : null;
  const main = "a".repeat(40);

  it("promotes by pushing the tag on GitHub's main, records it, and does not push again while the workflow runs", async () => {
    const dir = box();
    try {
      const calls: string[][] = [];
      const git = async (args: string[]) => (calls.push(args), args[0] === "ls-remote" ? `${main}\trefs/heads/main` : "");
      const r = await friendTick({ stateDir: dir, repo: dir, now: T0 + 50 * H, fetchJson: fetchJson("1.0.0"), git });
      expect(r.promoted).toMatchObject({ version: "1.0.2", tag: "mac-friend-v1.0.2", by: "timer" });
      expect(calls.at(-1)).toEqual(["push", "origin", `${main}:refs/tags/mac-friend-v1.0.2`]);
      expect(readFriendState(dir).last?.version).toBe("1.0.2");
      const again = await friendTick({ stateDir: dir, repo: dir, now: T0 + 51 * H, fetchJson: fetchJson("1.0.0"), git });
      expect(again.promoted).toBeNull();
      expect(calls.filter((c) => c[0] === "push")).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });

  it("status never pushes; a held version is said with why", async () => {
    const dir = box();
    try {
      writeFileSync(join(dir, "logs", "app.jsonl"), JSON.stringify({ ...err(30, "TypeError: boom", "window.error"), device: "laptop" }) + "\n");
      const git = async () => {
        throw new Error("no git in a status");
      };
      const s = await macFriendTool({ stateDir: dir, repo: dir, now: T0 + 50 * H, fetchJson: fetchJson("1.0.0"), git }, {});
      expect(s.text).toMatch(/Friend manifest: v1\.0\.0/);
      expect(s.text).toMatch(/v1\.0\.2: not yet, held: 1 new app error/);
      const p = await macFriendTool({ stateDir: dir, repo: dir, now: T0 + 50 * H, fetchJson: fetchJson("1.0.0"), git }, { action: "promote" });
      expect(p.text).toMatch(/no newer release passes every gate/);
    } finally {
      cleanup(dir);
    }
  });
});
