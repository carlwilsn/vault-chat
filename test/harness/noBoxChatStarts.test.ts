// Opening a vault on a machine with no box.
//
// The app carries a server and runs it itself for a vault with no box, so that
// "install, sign in, pick a vault, chat" is the whole of it. The box's own
// screen found that it never happened: the release opened the vault and the
// chat said "Connect your box to chat", with the server it carries never
// started at all.
//
// The reason was the load path, not the server. `boxLinkFor` asks nothing and
// starts nothing — deliberately, it is asked constantly — and loadConversations
// asked it and gave up on the answer. Only `startBoxChat` ever reached
// `ensureLocalServer`, and the early return meant it was never called.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-nobox-chat-");
// A second vault for the failing start: a server that did come up is
// remembered per vault, so the two cases cannot share one.
const vaultB = makeTempVault("vc-nobox-chat-b-");
const fake = installFakeTauri(vault);

const LOCAL = "http://127.0.0.1:45998";

/** What the chat was saying at the moment the server was asked for. */
let whenAsked: { on: boolean; starting?: boolean } | null = null;
/** Whether starting one works at all this run. */
let canStart = true;

fake.setHandler("vault_box_config", () => null); // no box of his own
fake.setHandler("local_server_start", (args: any) => {
  whenAsked = store.getState().boxChat;
  if (!canStart) throw "this build carries no vault-chat server to run";
  return { url: LOCAL, vault: String(args?.vault ?? vault) };
});
fake.setHandler("box_post_json", () => ({ status: 200, body: "{}" }));
fake.setHandler("box_get_json", () => ({ status: 200, body: "{}" }));

const store = (await import("../../src/store.ts")).useStore;
const boxChat = await import("../../src/boxChat.ts");

// Importing boxChat leaves its polling alive, which would hold the test runner
// open after the last assertion (the teardown oneSignIn.test.ts uses too).
after(() => boxChat.stopBoxChat());

test("the vault's conversations load by starting the server this machine runs itself", async () => {
  canStart = true;
  whenAsked = null;
  store.setState({ vaultPath: vault, boxChat: null, conversationsLoaded: false });

  await store.getState().loadConversations();

  assert.ok(
    fake.calls.some((c) => c.cmd === "local_server_start"),
    "the server the app carries was never started",
  );
  assert.notEqual(store.getState().boxChat?.on, false, 'the chat still says "connect a box" with a server running');
  // And while it was starting it said so, rather than naming a box he does
  // not need and cannot be expected to go and get.
  assert.equal(whenAsked?.starting, true, "the chat told him to connect a box while it was starting one");
  assert.equal(whenAsked?.on, false, "not on until the server answers");
});

test("and says there is no box only when none could be started here", async () => {
  canStart = false;
  boxChat.stopBoxChat();
  store.setState({ vaultPath: vaultB, boxChat: null, conversationsLoaded: false });

  await store.getState().loadConversations();

  assert.equal(store.getState().boxChat?.on, false, "nothing to chat with, and the pane has to say so");
  assert.ok(!store.getState().boxChat?.starting, "it is not still starting: that attempt failed");
  assert.equal(store.getState().conversationsLoaded, true, "the load finished rather than hanging on a dead start");
});
