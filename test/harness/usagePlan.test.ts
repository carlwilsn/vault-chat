// The context ring's popover: the plan's rows as drawn (src/UsagePopover.tsx planRows), from the box's figures.
import { test, after } from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-usageplan-");
installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
const { asOf, planRows } = await import("../../src/UsagePopover.tsx");

const NOW = Date.parse("2026-11-24T18:00:00Z");

test("no running 5-hour window reads 'not started', not a dash", () => {
  const rows = planRows({ fiveHour: { percent: 0, resetsAt: null }, weekly: { percent: 40, resetsAt: null } }, NOW);
  assert.deepEqual(rows[0], { label: "5-hour window", value: "not started", percent: 0 });
  assert.equal(planRows({ fiveHour: null, weekly: { percent: 1, resetsAt: null } }, NOW)[0]!.value, "not started");
  // A kept window whose reset has passed is over: not started either.
  assert.equal(planRows({ fiveHour: { percent: 90, resetsAt: NOW - 1000 }, weekly: null }, NOW)[0]!.value, "not started");
  assert.match(planRows({ fiveHour: { percent: 37.4, resetsAt: NOW + 3600_000 }, weekly: null }, NOW)[0]!.value, /^37% · resets /);
});

test("per-model weekly limits and extra usage get their own rows", () => {
  const rows = planRows(
    {
      fiveHour: { percent: 10, resetsAt: NOW + 3600_000 },
      weekly: { percent: 40, resetsAt: NOW + 3 * 86400_000 },
      scoped: [{ label: "Opus", percent: 55, resetsAt: null }],
      extra: { enabled: true, used: 12.34, limit: 50, percent: 24.7, currency: "USD" },
    },
    NOW,
  );
  assert.deepEqual(rows.map((r) => r.label), ["5-hour window", "Weekly", "Opus weekly", "Extra usage"]);
  assert.equal(rows[2]!.value, "55%");
  assert.match(rows[3]!.value, /12\.34.*\/.*50/);
  assert.equal(rows[3]!.percent, 24.7);
  // Extra usage off and unspent: no row.
  assert.equal(planRows({ fiveHour: null, weekly: null, extra: { enabled: false, used: 0, limit: null, percent: null, currency: "USD" } }, NOW).length, 2);
});

test("old figures say when they were read", () => {
  assert.equal(asOf({ fiveHour: null, weekly: null, at: NOW - 60_000 }, NOW), "");
  assert.match(asOf({ fiveHour: null, weekly: null, at: NOW - 3600_000 }, NOW), /^as of /);
});
