// Chat details: the box's roll-over divider in a transcript, and the context
// dial's number for a reopened chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

installFakeTauri(makeTempVault());
const cc = await import("../../src/chatContext.ts");

const msg = (role: "user" | "assistant", content: string, extra: object = {}) => ({ role, content, ...extra });
const divider = (extra: object) => msg("assistant", cc.COMPACTION_DIVIDER_TEXT, { system: true, ...extra });

test("a roll-over (or an old compaction) is a divider carrying its summary", () => {
  const roll = divider({ rollover: { recap: "RECAP" } });
  const comp = divider({ compaction: { summary: "SUMMARY", at: 1 } });
  assert.ok(cc.isCompactionDivider(roll as any));
  assert.ok(cc.isCompactionDivider(comp as any));
  assert.equal(cc.dividerSummary(roll as any), "RECAP");
  assert.equal(cc.dividerSummary(comp as any), "SUMMARY");
  assert.ok(!cc.isCompactionDivider(msg("assistant", "a reply") as any));
});

test("a reopened chat reports its newest turn's context, unknown after a divider", () => {
  const ms = [msg("user", "a"), msg("assistant", "b", { usage: { prompt: 1, completion: 1, total: 2, context: 1234 } }), msg("user", "c")];
  assert.equal(cc.lastReportedContext(ms as any), 1234);
  assert.equal(cc.lastReportedContext([...ms, divider({ rollover: { recap: "R" } })] as any), 0);
  assert.equal(cc.lastReportedContext([] as any), 0);
});
