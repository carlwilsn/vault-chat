// Existing metadata append path only; no server, provider or command registration.
import { it, expect } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanup } from "./helpers";
import { ConvLog, convLog } from "../convlog/log";

it("whole-conversation metaPatch/appendMessage writes only changed keys with 175 large workers and preserves removals", async () => {
  const { createConv, readConv, patchMeta, appendMessage, emitTo } = await import("../engine/convs");
  const root = mkdtempSync(join(tmpdir(), "vc-meta-patch-"));
  const vault = join(root, "vault");
  try {
    const c = await createConv(vault, { title: "Large metadata" }, "fixture", "meta-patch-big");
    const workers = Array.from({ length: 175 }, (_, i) => ({ threadId: `worker-${i}`, state: "completed", task: "prompt ".repeat(700), summary: "report ".repeat(300) }));
    emitTo(vault, c.id, { type: "meta", patch: { subagents: workers, activity: "old drift" } });
    const full = (await readConv(vault, c.id))!;
    await patchMeta(vault, c.id, { ...full, title: "Only title changed" });
    const log = convLog(vault);
    const file = join(log.dir, `${c.id}.jsonl`);
    const last = () => readFileSync(file, "utf8").trim().split("\n").at(-1)!;
    expect(Buffer.byteLength(last())).toBeLessThan(256);
    expect(JSON.parse(last()).patch).toEqual({ title: "Only title changed" });
    const beforeNoop = log.latest();
    await patchMeta(vault, c.id, (await readConv(vault, c.id))!);
    expect(log.latest()).toBe(beforeNoop);
    const current = (await readConv(vault, c.id))!;
    await appendMessage(vault, c.id, { role: "assistant", content: "Retained actual message", mid: "original-caller" } as any, { ...current, activity: undefined } as any);
    expect(Buffer.byteLength(last())).toBeLessThan(256);
    expect(JSON.parse(last()).patch).toEqual({ activity: null });
    expect(log.picture(c.id)!.meta.activity).toBeUndefined();
    expect(log.picture(c.id)!.meta.subagents).toEqual(workers);
    expect(new ConvLog(vault).picture(c.id)).toEqual(log.picture(c.id));
    expect((await readConv(vault, c.id))!.messages.some(m => m.content === "Retained actual message")).toBe(true);
  } finally { cleanup(root); }
});
