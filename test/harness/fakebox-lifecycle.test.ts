// Disposal is a server lifecycle boundary, not just the end of its TCP connections.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { FakeBox } from "./fakeBox.ts";

test("close drains an already-running poll before disposing the log and files", async () => {
  const box = new FakeBox();
  await box.start();
  box.create("main", "Main");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => { enter = r; });
  const held = new Promise<void>((r) => { release = r; });
  box.log.wait = async () => { enter(); await held; };
  // Closing the fixture intentionally disconnects its client; retain that outcome.
  const client = fetch(`${box.url}/poll?after=${box.log.latest()}`).then(r => r.text(), e => e);
  await entered;
  let disposed = false;
  const closing = box.close().then(() => { disposed = true; });
  // Let server.close's callback run. A TCP close must not mean routes have drained.
  await new Promise((r) => setTimeout(r, 20));
  const disposedBeforeRelease = disposed;
  const filesBeforeRelease = existsSync(box.dir);
  release();
  await closing;
  await client;
  assert.equal(disposedBeforeRelease, false, "close must await its active poll handler");
  assert.equal(filesBeforeRelease, true, "an active reader still owns these files");
  assert.equal(existsSync(box.dir), false);
  assert.equal(existsSync(box.attachVault), false);
  assert.throws(() => box.log.emit("main", { type: "meta", patch: { title: "too late" } }), /writer is closed/);
});

test("close releases a held poll's delivery before draining routes", async () => {
  const box = new FakeBox();
  await box.start();
  box.create("main", "Main");
  const release = box.holdPolls();
  const client = fetch(`${box.url}/poll?after=${box.log.latest()}`).then(r => r.text(), e => e);
  while (!box.seen.some(r => r.route === "GET /poll")) await new Promise<void>(r => setImmediate(r));
  await box.close();
  await client;
  release(); // The caller's finally may still release; disposal is idempotent here.
  assert.equal(existsSync(box.dir), false);
});

test("restart releases the original canonical writer before reopening its files", async () => {
  const box = new FakeBox();
  await box.start();
  box.create("main", "Main");
  const original = box.log;
  box.restart();
  assert.throws(() => original.emit("main", { type: "meta", patch: { title: "old writer" } }), /writer is closed/);
  assert.equal(box.log.picture("main")?.meta.title, "Main");
  await box.close();
});
