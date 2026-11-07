// A commit gated once is not gated again as the next ship's baseline; only complete runs are reused.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedGates, rememberGates, type ShipConfig } from "../simpleShipHost";
import { CHANGE_GATES, type GateReceipt } from "../shipGates";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function config(): ShipConfig {
  const root = mkdtempSync(join(tmpdir(), "vc-gatecache-")); roots.push(root);
  return { repo: join(root, "repo"), remote: "agents", workRoot: join(root, "work"), dependencies: "/deps", pi: "/pi", node: "/node", npm: "/npm", bash: "/bash", bwrap: "/bwrap", path: "/bin" };
}
const gates = (over: Partial<GateReceipt> = {}): GateReceipt[] => CHANGE_GATES.map((gate) => ({ gate, exitCode: 0, logArtifact: `/logs/${gate}.log`, complete: true, ...over }));
const A = "a".repeat(40), B = "b".repeat(40);

describe("ship gate cache", () => {
  it("reuses a commit's complete gate results, and only that commit's", () => {
    const o = config();
    expect(cachedGates(o, A)).toBeNull();
    rememberGates(o, A, gates());
    expect(cachedGates(o, A)).toEqual(gates());
    expect(cachedGates(o, B)).toBeNull();
  });
  it("never keeps an incomplete or timed-out run, or a partial gate list", () => {
    const o = config();
    rememberGates(o, A, gates({ complete: false }));
    rememberGates(o, A, gates({ timedOut: true }));
    rememberGates(o, A, gates().slice(1));
    expect(cachedGates(o, A)).toBeNull();
  });
  it("expires after 14 days, and a different installed toolchain is a different cache", () => {
    const o = config();
    const then = Date.now() - 15 * 86_400_000;
    rememberGates(o, A, gates(), then);
    expect(cachedGates(o, A)).toBeNull();
    rememberGates(o, A, gates());
    expect(cachedGates({ ...o, dependencies: "/other-deps" }, A)).toBeNull();
    expect(cachedGates(o, A)).not.toBeNull();
  });
});
