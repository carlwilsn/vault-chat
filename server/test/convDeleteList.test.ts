// A deleted chat's row reaches every client marked deleted (the client drops it, and the copy it had cached), so
// a chat Carl deleted never comes back on a surface that reloads its list. Left out of the list, a client that
// had it (its cache, a list from before the delete) kept showing it.
import { it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, type Running } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { ConvLog } from "../convlog/log";

let home = "";
let srv: Running | undefined;
let api: FakeApi | undefined;
afterAll(async () => {
  await srv?.stop();
  await api?.close();
  cleanup(home);
});

it("the list carries a deleted chat's row, marked deleted; Main and the others unmarked", async () => {
  home = tmp("vcdellist-");
  const vault = makeVault(join(home, "vault"));
  const secrets = await makeKeyStore(join(home, "secrets"), { "service.claude-code": "sk-ant-oat01-canary-not-real" });
  api = await fakeAnthropic("ok");
  const log = new ConvLog(vault);
  const now = Date.now();
  log.emit("main", { type: "meta", patch: { kind: "main", source: "main", title: "Main", createdAt: now, lastActivityAt: now } });
  log.emit("keep-1", { type: "meta", patch: { source: "manual", title: "Kept", createdAt: now, lastActivityAt: now } });
  log.emit("gone-1", { type: "meta", patch: { source: "manual", title: "Deleted one", createdAt: now, lastActivityAt: now } });
  log.emit("gone-1", { type: "meta", patch: { deleted: true, deletedAt: now, deletedBy: "test" } });
  log.close();
  srv = await startServer({ home, vault, secrets, anthropic: api.url });
  const rows = (await (await fetch(srv.base + "/api/v2/conversations")).json()).rows as { id: string; deleted?: boolean }[];
  const by = new Map(rows.map((r) => [r.id, r]));
  expect(by.get("gone-1")?.deleted).toBe(true);
  expect(by.get("keep-1")?.deleted).toBeUndefined();
  expect(by.get("main")?.deleted).toBeUndefined();
});
