import { it, expect } from "vitest";
import { compactSubagents, emptyPicture, expandSubagents, reduce } from "../../src/convlog/reduce";
import type { LogRecord } from "../../src/convlog/protocol";

const row = (id: string, status: string) => ({ threadId: id, status, prompt: `task ${id}` });
const meta = (seq: number, subagents: unknown[]): LogRecord => ({ seq, conv: "c", at: seq, type: "meta", patch: { subagents } });

// The reader accepts a record without the worker order (the writer will omit an unchanged order next).
it("expands a record with no order to the full list", () => {
  const many = Array.from({ length: 500 }, (_, i) => row(`w${i}`, "done"));
  let p = reduce(emptyPicture("c"), meta(1, many));
  const next = [...many.slice(0, 499), row("w499", "running")];
  const rec = meta(2, next);
  const stored = compactSubagents(p, rec) as any;
  expect(stored.type).toBe("subagents");
  const { order: _order, ...noOrder } = stored;
  expect(JSON.stringify(noOrder).length).toBeLessThan(400);
  expect(expandSubagents(p, noOrder)).toEqual(rec);
  p = reduce(p, rec);
  expect(p.meta.subagents).toEqual(next);
});

it("writes the order when a worker is added or the order changes", () => {
  const base = [row("a", "done"), row("b", "done"), row("c", "done")];
  const p = reduce(emptyPicture("c"), meta(1, base));
  const added = meta(2, [...base, row("d", "running")]);
  const s1 = compactSubagents(p, added) as any;
  expect(s1.order).toEqual(["a", "b", "c", "d"]);
  expect(expandSubagents(p, s1)).toEqual(added);
  const moved = meta(2, [base[2], base[0], base[1]]);
  const s2 = compactSubagents(p, moved) as any;
  if (s2.type === "subagents") {
    expect(s2.order).toEqual(["c", "a", "b"]);
    expect(expandSubagents(p, s2)).toEqual(moved);
  }
});
