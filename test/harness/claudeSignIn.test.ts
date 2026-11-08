// "Sign in with Claude" (the one line at the top of Settings, and the prompt a
// blocked AI surface draws): what happens to the token Carl pastes, and signing
// out.
//
// What is worth pinning here is the handling, not the field: the token goes into
// this machine's keychain and then to the box, and a failed push has to read
// differently from a failed sign-in, because the first one has still left a
// working token on the machine. No message on any path may carry the token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

// The component's module graph reaches src/store.ts, which touches
// localStorage as it is created — so the fakes go in before the import, as in
// panelayout.test.ts. Nothing below reaches Tauri: every flow is driven through
// its injected io.
installFakeTauri(makeTempVault("vc-claude-signin-"));
const { saveTypedToken, setupCommandFor, signOut } = await import("../../src/ClaudeCodeSignIn.tsx");
type SignInIo = import("../../src/ClaudeCodeSignIn.tsx").SignInIo;

const TOKEN = "sk-ant-oat01-NeverSaidOutLoud-0123456789" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOpQr";

type Rig = { io: SignInIo; calls: string[]; stored: { token: string | null }; remembered: string[] };
/** An override gets the call log so a replaced method still records its turn. */
type Over = (calls: string[]) => Partial<SignInIo>;

function rig(over: Over = () => ({}), stored: string | null = TOKEN): Rig {
  const calls: string[] = [];
  const box = { token: stored };
  const remembered: string[] = [];
  const io: SignInIo = {
    // Claude Code is already on this machine, which is the ordinary case and
    // the one that must cost nothing.
    ensureCli: async () => (calls.push("cli"), { cli: "/already/here/claude", version: "2.1.319" }),
    storedToken: async () => (calls.push("read"), box.token),
    remember: (t) => {
      calls.push("remember");
      remembered.push(t);
    },
    push: async () => (calls.push("push"), null),
    // Signing out: the token off this machine. The box loses it on the push that
    // follows, because the box's store becomes exactly what is pushed.
    forget: async () => {
      calls.push("forget");
      box.token = null;
    },
    ...over(calls),
  };
  return { io, calls, stored: box, remembered };
}

test("no message on any path can carry the token", async () => {
  // Every way storing a pasted token can go wrong, with a real one in hand.
  const cases: Over[] = [
    () => ({ push: async () => "the box refused the keys" }),
    () => ({ push: async () => { throw new Error("tailnet is down"); } }),
  ];
  for (const over of cases) {
    const { io } = rig(over);
    const err = await saveTypedToken(io, TOKEN);
    assert.ok(err, "this case is meant to fail");
    assert.ok(!err!.includes("sk-ant"), `a message leaked a token: ${err}`);
  }
});

test("the paste field still stores and pushes a hand-minted token", async () => {
  const { io, calls, remembered } = rig();
  assert.equal(await saveTypedToken(io, `  ${TOKEN}  `), null);
  assert.deepEqual(calls, ["remember", "push"], "nothing is driven for a pasted token");
  assert.deepEqual(remembered, [TOKEN], "trimmed");
});

test("the paste field refuses an empty token and reports a failed push honestly", async () => {
  const { io, calls } = rig();
  assert.match(String(await saveTypedToken(io, "  ")), /paste the token/i);
  assert.deepEqual(calls, []);

  const bad = rig(() => ({ push: async () => "the box refused the keys" }));
  const err = await saveTypedToken(bad.io, TOKEN);
  assert.match(String(err), /saved on this machine/);
  assert.ok(!String(err).includes(TOKEN));
});

test("signing out takes the token off this machine and pushes the set without it", async () => {
  const { io, calls, stored } = rig();
  assert.equal(await signOut(io), null);
  assert.deepEqual(calls, ["forget", "push"], "removed here first, then the box is told");
  assert.equal(stored.token, null, "nothing is left on this machine");
});

test("a sign-out whose push failed still says this machine is signed out", async () => {
  const { io, calls, stored } = rig((log) => ({ push: async () => (log.push("push"), "the box refused the keys") }));
  const err = await signOut(io);
  assert.ok(err, "the user is told something");
  assert.match(err!, /signed out here/, `a removed token must not read as a failed sign-out: ${err}`);
  assert.match(err!, /the box kept its copy/);
  assert.equal(stored.token, null);
  assert.deepEqual(calls, ["forget", "push"]);
});

test("a keychain that will not give the token up is a failed sign-out, and nothing is pushed", async () => {
  const { io, calls } = rig((log) => ({
    forget: async () => {
      log.push("forget");
      throw new Error("keyring is locked");
    },
  }));
  const err = await signOut(io);
  assert.match(String(err), /could not remove the token.*keyring is locked/);
  assert.deepEqual(calls, ["forget"], "no push: the set still has the token in it");
});

test("signing out never reads the token, so no sign-out message can hold one", async () => {
  // The strongest form of "it cannot leak": the value is never in this code's
  // hands. Every way signing out can go wrong, with a token present throughout.
  for (const over of [
    () => ({}),
    () => ({ push: async () => "the box refused the keys" }),
    () => ({ push: async () => { throw new Error("tailnet is down"); } }),
    () => ({ forget: async () => { throw new Error("keyring is locked"); } }),
  ] as Over[]) {
    const { io, calls } = rig(over);
    const err = await signOut(io);
    assert.ok(!calls.includes("read"), `signing out asked the keychain for the token: ${calls}`);
    assert.ok(!String(err ?? "").includes(TOKEN), `a sign-out message leaked a token: ${err}`);
    assert.ok(!String(err ?? "").includes("sk-ant"), `a sign-out message leaked a token: ${err}`);
  }
});

test("the command Carl copies names the claude that will run it", () => {
  // A machine that has one on its PATH keeps the plain command; a CLI the app
  // fetched itself is not on his PATH, so the command has to name it — quoted,
  // because he pastes this into a real shell and Windows paths have spaces.
  assert.equal(setupCommandFor(null), "claude setup-token");
  assert.equal(setupCommandFor("/home/carl/.local/share/vault-chat/claude"), "/home/carl/.local/share/vault-chat/claude setup-token");
  assert.equal(setupCommandFor("C:\\Users\\Carl Wilson\\AppData\\claude.exe"), '"C:\\Users\\Carl Wilson\\AppData\\claude.exe" setup-token');
});
