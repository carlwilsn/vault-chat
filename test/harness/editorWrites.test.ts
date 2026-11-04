import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorWrites } from "../../src/editorWrites";

function fixture() {
  const disk = new Map<string, string>([["/viewer/private.md", "old"], ["/owner/private.md", "owner"]]);
  const saves: string[] = [];
  const q = new EditorWrites({ read: async p => disk.get(p)!, write: async (p, text) => { saves.push(text); disk.set(p, text); } });
  const queue = (text: string, vault = "/viewer", path = vault + "/private.md") => q.queue({ vault, path, text }, disk.get(path)!, () => {}, () => {});
  return { disk, saves, q, queue };
}

test("immediate send drains paste before the 300 ms autosave, and acknowledge avoids sync on unchanged sends", async () => {
  const { q, disk, queue } = fixture();
  queue("pasted");
  assert.equal(disk.get("/viewer/private.md"), "old");
  const writes = await q.flush("/viewer");
  assert.equal(disk.get("/viewer/private.md"), "pasted");
  q.acknowledge(writes);
  assert.deepEqual(await q.flush("/viewer"), []);
});

test("edits are path captured and viewer-scoped, not owned by the conversation", async () => {
  const { q, disk, queue } = fixture();
  queue("paste"); queue("owner queued", "/owner");
  q.acknowledge(await q.flush("/viewer"));
  assert.equal(disk.get("/viewer/private.md"), "paste");
  assert.equal(disk.get("/owner/private.md"), "owner");
  q.acknowledge(await q.flush("/owner"));
});

test("independent disk edit is never overwritten; pending conflict cannot pretend saved", async () => {
  const { q, disk, queue, saves } = fixture();
  queue("paste"); disk.set("/viewer/private.md", "independent newer");
  await assert.rejects(q.flush("/viewer"), /changed on disk/);
  await assert.rejects(q.flush("/viewer"), /changed on disk/);
  assert.deepEqual(saves, []);
  assert.equal(disk.get("/viewer/private.md"), "independent newer");
  q.discard("/viewer/private.md");
});

test("failed local writes remain retryable and cannot release a reader", async () => {
  let fail = true, disk = "old";
  const q = new EditorWrites({ read: async () => disk, write: async (_, v) => { if (fail) throw Error("offline"); disk = v; } });
  q.queue({ vault: "/v", path: "/v/a.md", text: "fresh" }, "old", () => {}, () => {});
  await assert.rejects(q.flush("/v"), /offline/);
  fail = false;
  const writes = await q.flush("/v");
  assert.equal(disk, "fresh"); q.acknowledge(writes);
});

test("a delayed save followed by another paste serializes and old acknowledgement cannot lose the new edit", async () => {
  let disk = "old", release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const q = new EditorWrites({ read: async () => disk, write: async (_, text) => { await gate; disk = text; } });
  q.queue({ vault: "/v", path: "/v/a.md", text: "first" }, "old", () => {}, () => {});
  const first = q.flush("/v");
  q.queue({ vault: "/v", path: "/v/a.md", text: "second" }, "old", () => {}, () => {});
  const second = q.flush("/v"); release();
  q.acknowledge(await first);
  const writes = await second;
  assert.equal(disk, "second"); assert.equal(writes.length, 1);
  q.acknowledge(writes);
});


test("a completed autosave superseded by Git does not permanently block sends on its obsolete hash", async () => {
  const { q, disk, queue } = fixture();
  queue("saved local");
  await q.flush("/viewer"); // no Send acknowledgement yet
  disk.set("/viewer/private.md", "newer synced remote");
  assert.deepEqual(await q.flush("/viewer"), []);
  assert.equal(disk.get("/viewer/private.md"), "newer synced remote");
});

test("a newer unsaved edit still conflicts after a previously completed autosave", async () => {
  const { q, disk, queue } = fixture();
  queue("saved local"); await q.flush("/viewer");
  queue("unsent local"); disk.set("/viewer/private.md", "newer remote");
  await assert.rejects(q.flush("/viewer"), /changed on disk/);
  assert.equal(disk.get("/viewer/private.md"), "newer remote"); q.discard("/viewer/private.md");
});

test("Reload cancels debounce; Keep mine explicitly rebases then awaits the same barrier", async () => {
  const { q, disk, queue } = fixture();
  queue("discarded typing"); q.discard("/viewer/private.md");
  assert.deepEqual(await q.flush("/viewer"), []);
  disk.set("/viewer/private.md", "kept mine"); queue("kept mine");
  const writes = await q.flush("/viewer"); assert.equal(writes[0].text, "kept mine");
  q.acknowledge(writes);
});


test("explicit resolution waits for a save already in flight, so Keep mine cannot be overwritten afterwards", async () => {
  let disk = "old", release!: () => void, writing!: () => void;
  const started = new Promise<void>(r => { writing = r; });
  const gate = new Promise<void>(r => { release = r; });
  const q = new EditorWrites({ read: async () => disk, write: async (_, text) => { writing(); await gate; disk = text; } });
  q.queue({ vault: "/v", path: "/v/a.md", text: "in flight" }, "old", () => {}, () => {});
  const flush = q.flush("/v"); await started;
  let resolved = false;
  const resolution = q.discard("/v/a.md").then(() => { disk = "explicit kept mine"; resolved = true; });
  await Promise.resolve(); assert.equal(resolved, false);
  release(); await flush; await resolution;
  assert.equal(disk, "explicit kept mine"); assert.deepEqual(await q.flush("/v"), []);
});
