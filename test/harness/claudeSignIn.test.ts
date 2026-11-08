// "Sign in with Claude" (the one line at the top of Settings, and the prompt a
// blocked AI surface draws): the flow around the pty capture, and signing out.
//
// What is worth pinning here is not the button but the handling of what comes
// back. The pty side (src-tauri/src/claude_login.rs) hands the token straight to
// the keychain and answers with nothing, so this side has to read the keychain's
// copy, mirror it into the store the box push reads, and then push — and it has
// to tell a failed push apart from a failed sign-in, because the first one has
// still left a working token on the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

// The component's module graph reaches src/store.ts, which touches
// localStorage as it is created — so the fakes go in before the import, as in
// panelayout.test.ts. Nothing below reaches Tauri: every flow is driven through
// its injected io.
installFakeTauri(makeTempVault("vc-claude-signin-"));
const { beginSignIn, finishSignIn, saveTypedToken, signOut } = await import("../../src/ClaudeCodeSignIn.tsx");
type SignInIo = import("../../src/ClaudeCodeSignIn.tsx").SignInIo;

const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y";
const TOKEN = "sk-ant-oat01-NeverSaidOutLoud-0123456789" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOpQr";

type Rig = { io: SignInIo; calls: string[]; stored: { token: string | null }; remembered: string[] };
/** An override gets the call log so a replaced method still records its turn. */
type Over = (calls: string[]) => Partial<SignInIo>;

function rig(over: Over = () => ({}), stored: string | null = TOKEN): Rig {
  const calls: string[] = [];
  const box = { token: stored };
  const remembered: string[] = [];
  const io: SignInIo = {
    start: async () => (calls.push("start"), URL),
    // The real command stores the token itself; it answers with nothing.
    finish: async (code) => void calls.push(`finish:${code}`),
    cancel: async () => void calls.push("cancel"),
    openUrl: async (u) => void calls.push(`open:${u}`),
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

test("the flow starts, opens the page, and hands the url back for the code step", async () => {
  const { io, calls } = rig();
  const r = await beginSignIn(io);
  assert.deepEqual(r, { url: URL });
  assert.deepEqual(calls, ["start", `open:${URL}`]);
});

test("a browser that will not open is not a dead end — the url still comes back", async () => {
  const { io, calls } = rig(() => ({ openUrl: async () => { throw new Error("no opener on PATH"); } }));
  const r = await beginSignIn(io);
  assert.deepEqual(r, { url: URL }, "the command is running and waiting; show the link");
  assert.deepEqual(calls, ["start"]);
});

test("a machine with no claude to drive falls back instead of throwing", async () => {
  const { io, calls } = rig(() => ({ start: async () => { throw new Error("no Claude Code on this machine"); } }));
  const r = await beginSignIn(io);
  assert.deepEqual(r, { fallback: "no Claude Code on this machine" });
  assert.deepEqual(calls, [], "nothing was opened and nothing was stored");
});

test("the code goes over, then the keychain's copy is mirrored to the store and pushed", async () => {
  const { io, calls, remembered } = rig();
  assert.equal(await finishSignIn(io, "  code-from-browser  "), null);
  assert.deepEqual(calls, ["finish:code-from-browser", "read", "remember", "push"]);
  assert.deepEqual(remembered, [TOKEN], "the store gets the keychain's value, not a retyped one");
});

test("a refused code is reported and nothing is stored or pushed", async () => {
  const { io, calls } = rig(() => ({
    finish: async () => { throw new Error("That code wasn't accepted. Sign in again to get a new code."); },
  }));
  const err = await finishSignIn(io, "stale");
  assert.equal(err, "That code wasn't accepted. Sign in again to get a new code.");
  assert.deepEqual(calls, [], "no read, no remember, no push");
});

test("an empty code never reaches the waiting command", async () => {
  const { io, calls } = rig();
  assert.match(String(await finishSignIn(io, "   ")), /paste the code/);
  assert.deepEqual(calls, []);
});

test("a push that fails still says the token is on this machine", async () => {
  const { io, calls } = rig((log) => ({ push: async () => (log.push("push"), "the box refused the keys") }));
  const err = await finishSignIn(io, "code");
  assert.ok(err, "the user is told something");
  assert.match(err!, /signed in/, `a stored token must not read as a failed sign-in: ${err}`);
  assert.match(err!, /the box did not take the token/);
  assert.deepEqual(calls, ["finish:code", "read", "remember", "push"], "it was stored before the push failed");
});

test("a push that throws is caught, not propagated", async () => {
  const { io } = rig(() => ({ push: async () => { throw new Error("tailnet is down"); } }));
  const err = await finishSignIn(io, "code");
  assert.match(String(err), /signed in.*tailnet is down/);
});

test("a keychain that has nothing afterwards is an error, and nothing is pushed", async () => {
  const { io, calls } = rig(() => ({}), null);
  const err = await finishSignIn(io, "code");
  assert.match(String(err), /nothing was found in the keychain/);
  assert.deepEqual(calls, ["finish:code", "read"], "no remember, no push");
});

test("no message on any path can carry the token", async () => {
  // Every way finishing can go wrong, with a token present throughout.
  const cases: Over[] = [
    () => ({ push: async () => "the box refused the keys" }),
    () => ({ push: async () => { throw new Error("tailnet is down"); } }),
    () => ({ storedToken: async () => { throw new Error("keyring is locked"); } }),
    () => ({ finish: async () => { throw new Error("that code wasn't accepted"); } }),
  ];
  for (const over of cases) {
    const { io } = rig(over);
    const err = await finishSignIn(io, "code");
    assert.ok(err, "this case is meant to fail");
    assert.ok(!err!.includes("sk-ant"), `a message leaked a token: ${err}`);
  }
  // And the message built by our own code around a real stored token is clean.
  const { io } = rig(() => ({ push: async () => "refused" }));
  assert.ok(!String(await finishSignIn(io, "code")).includes(TOKEN));
});

test("the paste field still stores and pushes a hand-minted token", async () => {
  const { io, calls, remembered } = rig();
  assert.equal(await saveTypedToken(io, `  ${TOKEN}  `), null);
  assert.deepEqual(calls, ["remember", "push"], "no pty is started for a pasted token");
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
