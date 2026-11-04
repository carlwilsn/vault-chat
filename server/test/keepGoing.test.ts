import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startKeepGoing } from "../keepGoing";

it("posts each new ship result once, then nudges an idle agent with asks left", async () => {
  const posted: any[] = [];
  let lastActivityAt = Date.now();
  const srv = createServer((req, res) => {
    if (req.method === "POST") {
      let b = "";
      req.on("data", (c) => (b += c)).on("end", () => { posted.push(JSON.parse(b)); res.end("{}"); });
    } else res.end(JSON.stringify({ rows: [{ id: "c", running: false, asking: false, lastActivityAt }] }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  const root = mkdtempSync(join(tmpdir(), "keep-going-"));
  const work = join(root, "work");
  mkdirSync(join(work, "ship-results"), { recursive: true });
  mkdirSync(join(work, "ship-requests"));
  writeFileSync(join(work, "ship-results", "old.result"), "exit=0");
  writeFileSync(join(root, "ASKS.md"), "**Shipped: 1 / 34 (3%)**");
  const k = startKeepGoing({ selfUrl: `http://127.0.0.1:${port}`, stateDir: root, workDir: work, asksFile: join(root, "ASKS.md"), convId: "c", idleMs: 1000 })!;

  await k.tick();
  expect(posted).toEqual([]); // the old result was already there; the agent is active

  writeFileSync(join(work, "ship-results", "new.result"), "exit=1\nError: boom");
  await k.tick();
  await k.tick();
  expect(posted).toHaveLength(1);
  expect(posted[0].convId).toBe("c");
  expect(posted[0].text).toContain("Error: boom");

  lastActivityAt = Date.now() - 5000;
  writeFileSync(join(work, "ship-results", "x.running"), "");
  await k.tick();
  expect(posted).toHaveLength(1); // something is shipping: no nudge

  const { rmSync } = await import("node:fs");
  rmSync(join(work, "ship-results", "x.running"));
  await k.tick();
  await k.tick();
  expect(posted).toHaveLength(2); // one nudge, not one per tick
  expect(posted[1].text).toContain("Continue with ASKS.md");

  srv.close();
});
