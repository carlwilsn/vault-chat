// The update banner is state (it was screen-only: LaptopBuild read versions, not the banner): app/titlebar's `update`
// reads it, checkUpdates / installUpdate / dismissUpdate act through the banner's own actions, updateChanged watches it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

installFakeTauri(makeTempVault("vc-update-"));
const { publishUpdate, updateNow, onUpdateChanged } = await import("../../src/updateState.ts");
const { titlebarOffers } = await import("../../src/plugins/titlebar/index.tsx");

test("the banner's state and actions reach the agent through app/titlebar", async () => {
  const offers = titlebarOffers({ host: {} as never });
  const seen: string[] = [];
  const off = onUpdateChanged((u) => seen.push(u.state));
  let installed = 0;
  const actions = { install: async () => void installed++, dismiss: () => publishUpdate({ state: "idle" }, actions), check: () => {} };
  publishUpdate({ state: "idle" }, actions);
  await assert.rejects(() => (offers.actions!.installUpdate!.run as () => Promise<unknown>)(), /no update is offered now/);
  publishUpdate({ state: "available", version: "0.9.80" }, actions);
  publishUpdate({ state: "available", version: "0.9.80" }, actions);
  assert.deepEqual(await (offers.state!.update!.read as () => unknown)(), { state: "available", version: "0.9.80" });
  await (offers.actions!.installUpdate!.run as () => Promise<unknown>)();
  assert.equal(installed, 1);
  await (offers.actions!.dismissUpdate!.run as () => Promise<unknown>)();
  assert.equal(updateNow().state, "idle");
  off();
  assert.deepEqual(seen, ["available", "idle"], "a change is told once; the same state again is not");
});
