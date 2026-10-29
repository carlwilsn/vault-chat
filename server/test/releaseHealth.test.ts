import { describe, expect, it } from "vitest";
import { evaluateReleaseHealth, type BoxReleaseHealth, type LaptopReleaseHealth, type ReleaseTarget } from "../releaseHealth";
const target: ReleaseTarget = { id: "release-1", version: "0.7.19", revision: "a".repeat(40), installedAt: 1000, previousVersion: "0.7.18" };
const box: BoxReleaseHealth = { version: target.version, revision: target.revision, observedAt: 2000, ready: true };
const laptop: LaptopReleaseHealth = { clientId: "paired-laptop", version: target.version, revision: target.revision, observedAt: 2000, challenge: "fresh-release-challenge", tauri: true, frontendMounted: true, boxConnected: true, syncReady: true, updaterReady: true };
const opts = { target, now: 3000, boxDeadline: 4000, maxReportAgeMs: 5000, laptopClientId: laptop.clientId, challenge: laptop.challenge, box, laptop };

describe("post-release health is actual box AND actual laptop", () => {
  it("confirms only fresh matching source/version readiness from both devices", () => {
    expect(evaluateReleaseHealth(opts)).toMatchObject({ status: "healthy", action: "confirm", box: "healthy", laptop: "healthy" });
  });
  it("never treats box reachability as laptop health; offline laptop stays pending without autorevert", () => {
    expect(evaluateReleaseHealth({ ...opts, laptop: undefined })).toMatchObject({ status: "pending", action: "wait", laptop: "pending", binaryFallback: false });
    expect(evaluateReleaseHealth({ ...opts, now: 100_000, box: { ...box, observedAt: 99_999 }, laptop: undefined })).toMatchObject({ status: "pending", action: "wait", laptop: "pending" });
  });
  it.each([
    { challenge: "old-challenge" }, { clientId: "other-client" }, { revision: "old-source" },
    { version: "0.7.18" }, { observedAt: 999 }, { observedAt: 9999 }, { observedAt: NaN },
  ])("cannot confirm from a stale/replayed/mismatching laptop report %j", (patch) => {
    expect(evaluateReleaseHealth({ ...opts, laptop: { ...laptop, ...patch } })).toMatchObject({ status: "pending", laptop: "pending" });
  });
  it.each(["tauri", "frontendMounted", "boxConnected", "syncReady", "updaterReady"] as const)("a fresh explicit negative laptop %s triggers source revert shipping", (field) => {
    expect(evaluateReleaseHealth({ ...opts, laptop: { ...laptop, [field]: false } })).toMatchObject({ status: "failed", action: "revert-and-ship", binaryFallback: true });
  });
  it("a reported laptop failure is not replaced by a later box-only ping", () => {
    expect(evaluateReleaseHealth({ ...opts, laptop: { ...laptop, error: "Tauri sync startup failed" } })).toMatchObject({ status: "failed", action: "revert-and-ship", reason: "Tauri sync startup failed" });
  });
  it("waits for the box before deadline; times out independently of the laptop", () => {
    expect(evaluateReleaseHealth({ ...opts, box: undefined })).toMatchObject({ status: "pending", box: "pending" });
    expect(evaluateReleaseHealth({ ...opts, now: 4000, box: undefined })).toMatchObject({ status: "failed", action: "revert-and-ship", box: "failed" });
  });
  it("box version alone is not proof: matching revision AND readiness are required", () => {
    expect(evaluateReleaseHealth({ ...opts, box: { ...box, revision: "other" } })).toMatchObject({ status: "pending" });
    expect(evaluateReleaseHealth({ ...opts, box: { ...box, ready: false } })).toMatchObject({ status: "pending" });
  });
  it("revert-release failures surface once instead of autoreverting the revert forever", () => {
    expect(evaluateReleaseHealth({ ...opts, target: { ...target, rollbackOf: "original-change" }, box: { ...box, error: "startup failed" } })).toMatchObject({ status: "failed", action: "needs-attention", binaryFallback: false });
  });
});

describe("B's instance-owned voice health extension", () => {
  it("ignores disabled/not-selected voice; does not require a universal live port", () => {
    expect(evaluateReleaseHealth({ ...opts, box: { ...box, voice: { required: false, state: "disabled", owned: false, startupDeadline: 0 } } })).toMatchObject({ status: "healthy" });
  });
  it("requires readiness and exclusive identity, never a foreign health 200", () => {
    expect(evaluateReleaseHealth({ ...opts, box: { ...box, voice: { required: true, state: "ready", owned: true, startupDeadline: 0 } } })).toMatchObject({ status: "healthy" });
    expect(evaluateReleaseHealth({ ...opts, box: { ...box, voice: { required: true, state: "ready", owned: false, startupDeadline: 5000 } } })).toMatchObject({ status: "failed", action: "revert-and-ship" });
  });
  it("allows an explicit dependency/setup deadline rather than prematurely failing the box", () => {
    const voice = { required: true, state: "starting" as const, owned: false, startupDeadline: 20_000 };
    expect(evaluateReleaseHealth({ ...opts, now: 4500, box: { ...box, voice } })).toMatchObject({ status: "pending", box: "pending" });
    expect(evaluateReleaseHealth({ ...opts, now: 20_000, box: { ...box, observedAt: 19_999, voice } })).toMatchObject({ status: "failed", box: "failed" });
  });
  it("an explicit bind failure is immediately visible with its real cause", () => {
    const voice = { required: true, state: "failed" as const, owned: false, startupDeadline: 20_000, error: "voice pipeline can't start: port in use by other-instance" };
    expect(evaluateReleaseHealth({ ...opts, box: { ...box, voice } })).toMatchObject({ status: "failed", reason: voice.error });
  });
});
