// Execute the target-aware phone-local Clear closure; never reset the shared agent or history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterClear } from "../../src/convlog/view.ts";
const boot = readFileSync(new URL("../../phone/src/boot.ts", import.meta.url), "utf8");
const clear = ts.transpile(boot.slice(boot.indexOf("  async function clearThread("), boot.indexOf('  /** "/compact')), { target: ts.ScriptTarget.ES2022 });

test("phone Clear only persists this device's view cutoff; no history or other view is mutated", async () => {
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
  await runInNewContext(clear + ';clearThread("main")', context);
  assert.equal(rendered, 1); assert.equal(removed, 1);
  assert.equal(JSON.stringify(messages), original);
  assert.deepEqual(JSON.parse(storage.get("vc_phone_cleared")!), { main: "old-2", "project-other": "other-cutoff" });
  const cutoff = JSON.parse(storage.get("vc_phone_cleared")!).main;
  assert.deepEqual(afterClear(messages as any, cutoff), []);
  assert.deepEqual(afterClear(messages as any, undefined), messages, "a device without this local cutoff still sees everything");
  const next = { mid: "new-1", role: "assistant", content: "New reply" };
  assert.deepEqual(afterClear([...messages, next] as any, cutoff), [next]);
});

test("phone Clear on an empty thread is a no-op, not an agent reset", async () => {
  await runInNewContext(clear + ';clearThread("main")', { convId: "main", pic: {}, picView: () => ({ messages: [] }) });
});


test("background row Clear fetches only that target, preserves active owner/draft/nodes and pending work", async () => {
  const storage = new Map<string, string>();
  const messages = [{ mid: "target-1" }, { mid: "target-2" }];
  const requests: string[] = [];
  const context = {
    convId: "main", pic: {}, picView: () => { throw Error("active view must not supply background cutoff"); },
    CLEARED_KEY: "vc_phone_cleared", clearedAt: { main: "main-cutoff" },
    outgoing: [{ convId: "main", failed: true }, { convId: "project-target", failed: true }, { convId: "project-target", failed: false }],
    shownNodes: new Map([["main-1", { el: { remove: () => { throw Error("active DOM removed"); } } }]]),
    localStorage: { setItem: (key: string, value: string) => storage.set(key, value) },
    api: async (url: string) => { requests.push(url); return { ok: true, json: async () => ({ picture: { messages } }) }; },
    makeChatView: () => (p: any) => p,
    renderThread: () => { throw Error("active thread rerendered"); },
    input: { value: "unsent owner draft" },
  };
  await runInNewContext(clear + ';clearThread("project-target")', context);
  assert.deepEqual(requests, ["/api/v2/conversations/project-target/checkpoint"]);
  assert.deepEqual(JSON.parse(storage.get("vc_phone_cleared")!), { main: "main-cutoff", "project-target": "target-2" });
  assert.equal(context.convId, "main"); assert.equal(context.input.value, "unsent owner draft");
  assert.deepEqual(JSON.parse(JSON.stringify(context.outgoing)), [{ convId: "main", failed: true }, { convId: "project-target", failed: false }]);
  assert.equal(context.shownNodes.size, 1);
  assert.deepEqual(afterClear(messages as any, "target-2"), []);
});

test("a failed background checkpoint never clears active history or writes a cutoff", async () => {
  const context = { convId: "main", api: async () => ({ ok: false, status: 404, json: async () => ({ error: "not found" }) }) };
  await assert.rejects(runInNewContext(clear + ';clearThread("missing")', context), /not found/);
});
