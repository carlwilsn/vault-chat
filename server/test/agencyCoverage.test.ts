// Parity between what Carl sees and what the agent can reach (src/agencyCoverage.ts). A UI file added without a line
// there fails here: the change must say which state the agent reads, changes and watches it through, or name the gap.
// A line naming state that no part offers fails too. The ship gate counts a failing test, so parity is kept by every
// future change, not by a one-time audit.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { COVERAGE, OTHER_STATE, UNMAPPED_CONTROLS, coveragePercent } from "../../src/agencyCoverage";
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
    expect(coveragePercent(COVERAGE, "src/")).toBeGreaterThanOrEqual(80);
    expect(coveragePercent(COVERAGE, "phone/")).toBeGreaterThanOrEqual(50);
  });
});

// The check that can't be talked round by a file's word: it reads the controls themselves. A new button, input or
// clickable element anywhere in the UI (an existing file too) fails unless it names the offer that reaches it, or an
// exemption with a reason; a named offer must be an action its part declares.
describe("every new control on screen names the offer that reaches it", () => {
  const all = uiControlFiles(ROOT).flatMap((f) => controlsIn(ROOT, f));

  it("no file has more unmapped controls than the ratchet allows", () => {
    const over: string[] = [];
    const counts = new Map<string, number>();
    for (const c of all) if (!c.offer && !c.exempt) counts.set(c.file, (counts.get(c.file) ?? 0) + 1);
    for (const [f, n] of counts) if (n > (UNMAPPED_CONTROLS[f] ?? 0)) over.push(`${f}: ${n} controls without data-offer (allowed ${UNMAPPED_CONTROLS[f] ?? 0}); e.g. ${all.filter((c) => c.file === f && !c.offer && !c.exempt).slice(-1)[0]!.tag}`);
    expect(over, "a new control must carry data-offer=\"<part>.<action>\" or data-offer-exempt=\"<why>\"").toEqual([]);
  });

  it("the ratchet only names files that exist (lower or drop a number when controls go)", () => {
    const files = new Set(uiControlFiles(ROOT));
    expect(Object.keys(UNMAPPED_CONTROLS).filter((f) => !files.has(f))).toEqual([]);
  });

  it("a control's data-offer names an action its part declares", () => {
    const bad: string[] = [];
    for (const c of all.filter((x) => x.offer)) {
      const m = /^app\/([\w-]+)\.(\w+)$/.exec(c.offer!);
      const dir = m ? join(ROOT, "src", "plugins", m[1]!) : "";
      const src = m && existsSync(dir) ? (readdirSync(dir, { recursive: true } as never) as unknown[]).map(String).filter((f) => /\.tsx?$/.test(f)).map((f) => readFileSync(join(dir, f), "utf8")).join("\n") : "";
      if (!m || !APP_PLUGINS.some((p) => p.id === `app/${m[1]}`) || !/\boffer\(/.test(src) || !new RegExp(`(^|[\\s{,])["']?${m[2]}["']?\\s*:\\s*\\{`, "m").test(src)) bad.push(`${c.file}: data-offer="${c.offer}"`);
    }
    expect(bad).toEqual([]);
  });
});
