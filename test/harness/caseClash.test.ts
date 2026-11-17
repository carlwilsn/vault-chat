// Windows (the laptop build) treats file names that differ only in letter case as the same file, so two such
// files in the repo break its TypeScript build while Linux builds pass (PinnedApps.tsx/pinnedApps.ts, then
// ChangeReady.tsx/changeReady.ts). This keeps the repo free of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

test("no two tracked files differ only in letter case (Windows sees them as one)", () => {
  const root = join(import.meta.dirname, "..", "..");
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const f of files) {
    const k = f.toLowerCase();
    const prev = seen.get(k);
    if (prev && prev !== f) clashes.push(`${prev} <> ${f}`);
    else seen.set(k, f);
  }
  assert.deepEqual(clashes, []);
});
