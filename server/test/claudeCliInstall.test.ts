// Putting the pinned Claude Code CLI where a box reads it from.
//
// The hole this closes: the deployed box installs a bundle, never node_modules,
// so the SDK's pinned CLI only exists where the repo does. Carl's box ran Claude
// Code at all only because one was copied in by hand.
import { describe, it, expect, afterAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { placeCli, placedCliPath } from "../engine/claude/cliInstall";
import { findClaude } from "../engine/claude/install";
import { tmp, cleanup } from "./helpers";

const roots: string[] = [];
const root = () => {
  const r = tmp("cliinstall");
  roots.push(r);
  return r;
};
afterAll(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

/** A stand-in for the real CLI: anything that answers --version the way it does. */
function fakeCli(dir: string, version = "2.1.319"): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "claude");
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi\nexit 9\n`);
  chmodSync(p, 0o755);
  return p;
}

describe("installing the pinned Claude Code CLI", () => {
  it("places it where findClaude reads it, and says which version it placed", () => {
    const r = root();
    const src = fakeCli(join(r, "release"));
    const out = placeCli({ from: src, stateDir: join(r, "state") });
    expect("error" in out ? out.error : null).toBeNull();
    if ("error" in out) return;
    expect(out.install.version).toBe("2.1.319");

    // It is at the one path findClaude prefers, and executable.
    const dest = placedCliPath(join(r, "state"));
    expect(existsSync(dest)).toBe(true);
    expect(statSync(dest).mode & 0o111).toBeTruthy();

    // The claim that matters is the NEXT boot's: ask the resolver, with nothing
    // in the environment pointing at anything else.
    const found = findClaude({ stateDir: join(r, "state"), env: {} });
    expect("error" in found ? found.error : found.install).toMatchObject({ cli: dest, version: "2.1.319", source: "installed" });
  });

  it("refuses a file this machine cannot run, and keeps the CLI already installed", () => {
    const r = root();
    const stateDir = join(r, "state");
    const good = fakeCli(join(r, "good"), "2.1.319");
    expect("error" in placeCli({ from: good, stateDir })).toBe(false);

    // Something that exists but does not answer --version: a truncated download,
    // a binary for another architecture. Installing it would break every turn,
    // so it is refused and what works stays.
    const broken = join(r, "broken-claude");
    writeFileSync(broken, "not an executable");
    chmodSync(broken, 0o755);
    const out = placeCli({ from: broken, stateDir });
    expect("error" in out).toBe(true);
    const found = findClaude({ stateDir, env: {} });
    expect("error" in found ? null : found.install.version).toBe("2.1.319");
  });

  it("says plainly when there is nothing to install", () => {
    const r = root();
    const out = placeCli({ from: join(r, "absent"), stateDir: join(r, "state") });
    expect("error" in out && out.error).toMatch(/no such file/);
  });
});
