// Parity between what Carl sees and what the agent can reach (src/agencyCoverage.ts). A UI file added without a line
// there fails here: the change must say which state the agent reads, changes and watches it through, or name the gap.
// A line naming state that no part offers fails too. The ship gate counts a failing test, so parity is kept by every
// future change, not by a one-time audit.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { COVERAGE, EXEMPT_REASONS, OTHER_STATE, coveragePercent } from "../../src/agencyCoverage";
import { controlsIn, uiControlFiles } from "./agencyControls";
import { APP_PLUGINS } from "../../src/appPlugins";

const ROOT = join(__dirname, "..", "..");
const uiFiles = (): string[] => [
  ...readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".tsx")).map((f) => `src/${f}`),
  ...readdirSync(join(ROOT, "src", "plugins"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `src/plugins/${d.name}`),
  ...(existsSync(join(ROOT, "phone", "src")) ? readdirSync(join(ROOT, "phone", "src")).filter((f) => f.endsWith(".tsx")).map((f) => `phone/src/${f}`) : []),
];

describe("everything on screen has a line saying how the agent reaches it", () => {
  it("every UI file is in the map (add a line to src/agencyCoverage.ts for a new one)", () => {
    const missing = uiFiles().filter((f) => !(f in COVERAGE));
    expect(missing, `UI without a coverage line: ${missing.join(", ")}`).toEqual([]);
  });

  it("no line names a file that is gone", () => {
    const files = new Set(uiFiles());
    expect(Object.keys(COVERAGE).filter((k) => !k.startsWith("box/") && !files.has(k))).toEqual([]);
  });

  it("every state a line names is offered by some part", () => {
    const offered = new Set([...APP_PLUGINS.map((p) => p.id), ...OTHER_STATE]);
    const bad = Object.entries(COVERAGE).flatMap(([k, c]) => ("state" in c ? c.state.filter((s) => !offered.has(s)).map((s) => `${k} → ${s}`) : []));
    expect(bad).toEqual([]);
  });

  it("each app part in src/plugins declares offers (api.offer), so its line is true", () => {
    const silent = Object.keys(COVERAGE)
      .filter((k) => k.startsWith("src/plugins/"))
      .filter((k) => !readdirSync(join(ROOT, k), { recursive: true } as never).some((f: unknown) => /\.(tsx?|js)$/.test(String(f)) && /\boffer\(/.test(readFileSync(join(ROOT, k, String(f)), "utf8"))));
    expect(silent).toEqual([]);
  });

  it("the share covered is counted (a gap counts half), and only rises", () => {
    // Raise these floors when a gap closes; a change that lowers them must say why here.
    expect(coveragePercent(COVERAGE, "src/")).toBe(100);
    expect(coveragePercent(COVERAGE, "phone/")).toBe(100);
    expect(Object.values(COVERAGE).filter((c) => "screenOnly" in c || ("gap" in c && c.gap)), "no screen-only line and no gap").toEqual([]);
  });
});

// The check that can't be talked round by a file's word: it reads the controls themselves. A new button, input or
// clickable element anywhere in the UI (an existing file too) fails unless it names the offer that reaches it, or an
// exemption with a reason; a named offer must be an action its part declares.
describe("every new control on screen names the offer that reaches it", () => {
  const all = uiControlFiles(ROOT).flatMap((f) => controlsIn(ROOT, f));

  it("every control names the model action it runs, or one of the allowed exemptions (no ratchet: none may bypass)", () => {
    const bare = all.filter((c) => !c.offer && !c.exempt).map((c) => `${c.file}: ${c.tag}`);
    expect(bare, "a control must carry data-offer=\"app/<part>.<action>\" (or box:<noun>.<action>) or data-offer-exempt=\"<an EXEMPT_REASONS line>\"").toEqual([]);
    const odd = all.filter((c) => c.exempt && !EXEMPT_REASONS.includes(c.exempt)).map((c) => `${c.file}: ${c.exempt}`);
    expect(odd, "an exemption must be one of src/agencyCoverage.ts EXEMPT_REASONS").toEqual([]);
  });

  // A control's data-offer is checked against the offers the parts really build: test/harness/offerParity.test.ts.
});
