import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startKeepGoing } from "../keepGoing";

it("delivers real ship-result events once and NEVER produces ASKS/idle work", async () => {
  const root = mkdtempSync(join(tmpdir(), "keep-going-")), work = join(root, "work");
  mkdirSync(join(work, "ship-results"), { recursive: true });
  writeFileSync(join(work, "ship-results", "old.result"), "exit=0");
  // Old hourly state is harmless; no ASKS file or HTTP client exists anymore.
  writeFileSync(join(root, "keep-going.json"), JSON.stringify({ seen: ["old.result"], lastNudgeAt: 0 }));
  const posted: string[] = [];
  const options = { stateDir: root, workDir: work, deliver: async (name: string, body: string) => { posted.push(name + ":" + body); } };
  const k = startKeepGoing(options)!;
  await k.tick(); await k.tick();
  expect(posted).toEqual([]);
  writeFileSync(join(work, "ship-results", "new.result"), "exit=1\nError: boom");
  await k.tick(); await k.tick();
  expect(posted).toEqual(["new.result:exit=1\nError: boom"]);
  await startKeepGoing(options)!.tick();
  expect(posted).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(root, "keep-going.json"), "utf8")).seen).toContain("new.result");
});

it("does not acknowledge a failed result delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "keep-going-retry-"));
  mkdirSync(join(root, "ship-results"));
  let fail = true, deliveries = 0;
  const k = startKeepGoing({ stateDir: root, workDir: root, deliver: async () => { if (fail) throw Error("owned failure"); deliveries++; } })!;
  writeFileSync(join(root, "ship-results", "new.result"), "exit=0");
  await expect(k.tick()).rejects.toThrow("owned failure");
  fail = false; await k.tick(); await k.tick();
  expect(deliveries).toBe(1);
});
