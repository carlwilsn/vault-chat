// The terminal button / Ctrl+J opens a terminal where the chat runs: on the
// box (ssh into the vault's working copy) for a box vault, on this laptop for a
// laptop-only vault; Shift opens the other one; a box that can't be reached or
// doesn't report user/path (an older server) falls back to the laptop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const plain = makeTempVault("vc-term-plain-");
const boxed = makeTempVault("vc-term-box-");
const boxedOld = makeTempVault("vc-term-old-");
const boxedDown = makeTempVault("vc-term-down-");
const boxedRefuse = makeTempVault("vc-term-refuse-");
const fake = installFakeTauri(plain);

const BOX = "https://thinkbox.tail1234.ts.net";
const OLD = "https://oldbox.tail1234.ts.net";
const DOWN = "https://downbox.tail1234.ts.net";
const boxOf: Record<string, unknown> = {
  [boxed]: { box: BOX, vault: "school2" },
  [boxedOld]: { box: OLD, vault: "school2" },
  [boxedDown]: { box: DOWN, vault: "school2" },
  [boxedRefuse]: { box: BOX, vault: "physics" },
};
fake.setHandler("vault_box_config", ({ vault }) => boxOf[vault] ?? null);
const healthUrls: string[] = [];
fake.setHandler("box_get_json", ({ url }) => {
  const u = new URL(url);
  healthUrls.push(url);
  if (u.origin === DOWN) throw "error sending request: operation timed out";
  if (u.origin === OLD) return { status: 200, body: JSON.stringify({ ok: true, app: "vault-chat-server", name: "oldbox" }) };
  const v = u.searchParams.get("vault") || "school2";
  return { status: 200, body: JSON.stringify({ ok: true, user: "carlwilsn", vaultPath: `/home/carlwilsn/vaults/${v}`, vaults: [] }) };
});
fake.setHandler("open_terminal", () => null);
let refuseBox = false;
fake.setHandler("open_box_terminal", () => {
  if (refuseBox) throw "no terminal emulator found";
  return null;
});

const { useStore } = await import("../../src/store.ts");
const t = await import("../../src/terminal.ts");

const opened = () => fake.calls.filter((c) => c.cmd === "open_terminal" || c.cmd === "open_box_terminal");
async function press(vault: string, shift = false) {
  useStore.setState({ vaultPath: vault } as any);
  fake.calls.length = 0;
  const notes: (string | null)[] = [];
  const off = t.subscribeTerminalNote((n) => notes.push(n));
  const choice = await t.openTerminal({ shift });
  off();
  return { choice, calls: opened(), notes };
}

test("choice logic: box vs laptop, shift swaps, fallback", () => {
  const target = { host: "thinkbox", user: "carl", path: "/v" };
  assert.deepEqual(t.chooseTerminal({ vault: "/l", hasBox: false, shift: false, target: null }), { where: "laptop", cwd: "/l" });
  assert.deepEqual(t.chooseTerminal({ vault: "/l", hasBox: false, shift: true, target: null }), { where: "laptop", cwd: "/l" });
  assert.deepEqual(t.chooseTerminal({ vault: "/l", hasBox: true, shift: false, target }), { where: "box", target });
  assert.deepEqual(t.chooseTerminal({ vault: "/l", hasBox: true, shift: true, target }), { where: "laptop", cwd: "/l" });
  const fb = t.chooseTerminal({ vault: "/l", hasBox: true, shift: false, target: null, error: "timed out" });
  assert.equal(fb.where, "laptop");
  assert.match((fb as any).note, /timed out.*this laptop/);
  assert.equal(t.terminalTitle("thinkbox"), "Terminal on thinkbox (Ctrl+J) · Shift: this laptop");
  assert.equal(t.terminalTitle(null), "Terminal (Ctrl+J)");
});

test("the box's health → the ssh target (host from the URL; vaultPath, else the vaults list)", () => {
  assert.deepEqual(t.boxTargetFromHealth(BOX, "school2", { user: "carl", vaultPath: "/home/carl/school2" }), {
    host: "thinkbox.tail1234.ts.net",
    user: "carl",
    path: "/home/carl/school2",
  });
  assert.equal(t.boxTargetFromHealth(BOX, "physics", { user: "carl", vaults: [{ name: "school2", path: "/a" }, { name: "physics", path: "/b" }] }).path, "/b");
  assert.throws(() => t.boxTargetFromHealth(BOX, "school2", { name: "old" }), /older server/);
});

test("laptop-only vault: the local terminal at the vault, shift or not", async () => {
  for (const shift of [false, true]) {
    const r = await press(plain, shift);
    assert.deepEqual(r.calls, [{ cmd: "open_terminal", args: { cwd: plain } }]);
    assert.deepEqual(r.notes, []);
  }
  assert.equal(await t.terminalBoxName(plain), null);
});

test("box vault: a terminal on the box in that vault's working copy; Shift → this laptop", async () => {
  assert.equal(await t.terminalBoxName(boxed), "thinkbox");
  healthUrls.length = 0;
  const r = await press(boxed);
  assert.deepEqual(r.calls, [
    { cmd: "open_box_terminal", args: { host: "thinkbox.tail1234.ts.net", user: "carlwilsn", path: "/home/carlwilsn/vaults/school2" } },
  ]);
  assert.match(healthUrls[0]!, /\/api\/v1\/health\?vault=school2$/);
  const s = await press(boxed, true);
  assert.deepEqual(s.calls, [{ cmd: "open_terminal", args: { cwd: boxed } }]);
  assert.deepEqual(s.notes, []);
});

test("an older box (no user/path), an unreachable one, or a failed launch → the laptop, with a quiet note", async () => {
  for (const v of [boxedOld, boxedDown]) {
    const r = await press(v);
    assert.deepEqual(r.calls, [{ cmd: "open_terminal", args: { cwd: v } }]);
    assert.equal(r.notes.length, 1);
    assert.match(String(r.notes[0]), /this laptop/);
  }
  refuseBox = true;
  const r = await press(boxedRefuse);
  refuseBox = false;
  assert.deepEqual(r.calls.map((c) => c.cmd), ["open_box_terminal", "open_terminal"]);
  assert.match(String(r.notes[0]), /no terminal emulator found/);
});
