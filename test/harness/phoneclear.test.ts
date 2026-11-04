// Execute the unchanged phone-local Clear closure; never reset the shared agent or history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterClear } from "../../src/convlog/view.ts";
const boot = readFileSync(new URL("../../phone/src/boot.ts", import.meta.url), "utf8");
const clear = boot.slice(boot.indexOf("  function clearThread()"), boot.indexOf('  /** "/compact'));

test("phone Clear only persists this device's view cutoff; no history or other view is mutated", () => {
  const messages = [{ mid: "old-1", role: "user", content: "My old message" }, { mid: "old-2", role: "assistant", content: "Hello sir — ordinary history" }];
  const original = JSON.stringify(messages);
  const storage = new Map<string, string>();
  let rendered = 0, removed = 0;
  const context = {
    convId: "main", pic: {}, picView: () => ({ messages }),
    CLEARED_KEY: "vc_phone_cleared", clearedAt: { "project-other": "other-cutoff" },
    outgoing: [], shownNodes: new Map([["old-1", { el: { remove: () => removed++ } }]]),
    localStorage: { setItem: (key: string, value: string) => storage.set(key, value) },
    renderThread: () => rendered++,
  };
  // No API, engine, delete, or shared-state stub exists: any such new action fails.
  runInNewContext(clear + ";clearThread()", context);
  assert.equal(rendered, 1); assert.equal(removed, 1);
  assert.equal(JSON.stringify(messages), original);
  assert.deepEqual(JSON.parse(storage.get("vc_phone_cleared")!), { main: "old-2", "project-other": "other-cutoff" });
  const cutoff = JSON.parse(storage.get("vc_phone_cleared")!).main;
  assert.deepEqual(afterClear(messages as any, cutoff), []);
  assert.deepEqual(afterClear(messages as any, undefined), messages, "a device without this local cutoff still sees everything");
  const next = { mid: "new-1", role: "assistant", content: "New reply" };
  assert.deepEqual(afterClear([...messages, next] as any, cutoff), [next]);
});

test("phone Clear on an empty thread is a no-op, not an agent reset", () => {
  runInNewContext(clear + ";clearThread()", { convId: "main", pic: {}, picView: () => ({ messages: [] }) });
});
