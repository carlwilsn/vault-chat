// A vault switch shows nothing of the old vault under the new one (11-24: switching school2 -> vault-chat showed
// school2's folders under "vault-chat" for ~1/3 s, and school2's turned-off snail cursor mounted for a few frames).
// The store's setVault drops the old tree at the switch, and a listing of another vault that finishes late is dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

installFakeTauri(makeTempVault("vc-vaultswitch-"));
const { useStore } = await import("../../src/store.ts");

const entry = (path: string) => ({ path, name: path.split("/").pop()!, is_dir: true }) as any;

test("switching vaults clears the old tree at once; a late listing of the old vault never lands", () => {
  const S = useStore.getState;
  S().setVault("/v/school2");
  S().setFiles([entry("/v/school2/CS 336"), entry("/v/school2/IEMS 469")], "/v/school2");
  assert.equal(S().files.length, 2);
  S().setVault("/v/vault-chat");
  assert.equal(S().vaultPath, "/v/vault-chat");
  assert.deepEqual(S().files, []);
  // The old vault's refresh, started before the switch, answers after it: dropped.
  S().setFiles([entry("/v/school2/CS 336")], "/v/school2");
  assert.deepEqual(S().files, []);
  S().setFiles([entry("/v/vault-chat/reports")], "/v/vault-chat");
  assert.deepEqual(S().files.map((f: any) => f.path), ["/v/vault-chat/reports"]);
  // The same vault again keeps its tree.
  S().setVault("/v/vault-chat");
  assert.equal(S().files.length, 1);
});
