// Phase 3 removals: the one-time assistant.md ProposeMission migration.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault();
installFakeTauri(vault);
const meta = await import("../../src/meta.ts");

/** A shipped assistant.md that still told the agent to call ProposeMission. */
function shippedWithProposeMission(): string {
  const root = path.resolve(import.meta.dirname, "..", "..");
  const revs = execFileSync("git", ["log", "--all", "--format=%H", "--", "src-tauri/defaults/assistant.md"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  for (const r of revs) {
    try {
      const t = execFileSync("git", ["show", `${r}:src-tauri/defaults/assistant.md`], { cwd: root, encoding: "utf8" });
      if (t.includes("ProposeMission")) return t;
    } catch {
      /* not in that revision */
    }
  }
  throw new Error("no shipped assistant.md with ProposeMission in history");
}

test("assistant.md: shipped ProposeMission lines go, the user's own lines stay, once", async () => {
  const file = path.join(vault, ".vault-chat", "agent", "assistant.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const userLine = "When I say ProposeMission I mean: write me a plan note instead.";
  const text = shippedWithProposeMission() + "\n\nMy own rule: be brief.\n" + userLine + "\n";
  fs.writeFileSync(file, text);
  const before = text.split("\n").filter((l) => l.includes("ProposeMission")).length;
  assert.ok(before >= 2);
  assert.equal(await meta.dropProposeMissionLines(vault), true);
  const after = fs.readFileSync(file, "utf8");
  const left = after.split("\n").filter((l) => l.includes("ProposeMission"));
  assert.deepEqual(left, [userLine]);
  assert.ok(after.includes("My own rule: be brief."));
  // Idempotent: nothing shipped is left, so a second run writes nothing.
  assert.equal(await meta.dropProposeMissionLines(vault), false);
});
