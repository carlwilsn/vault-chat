// One sign-in, and a box added afterwards.
//
// Carl's acceptance requirement, in his order: he signs in once on his laptop
// with no box; later he connects a box and the AI works there without a second
// sign-in, a paste, a prompt on the box, or SSH.
//
// Two things had to be true for that, and one of them was missing. The keys
// already travel over the existing push, and a box picked in Settings is pushed
// to — but a key change with NO box pushed nowhere, and the server the app runs
// itself starts with an empty key store. So signing in on a machine with no box
// left the AI still asking to sign in.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-one-signin-");
const fake = installFakeTauri(vault);

const LOCAL = "http://127.0.0.1:45999";
const BOX = "http://box.example:8848";

/** Where keys were pushed, in order. */
const pushedTo: string[] = [];
/** What `vault_box_config` answers; null is "no box". */
let boxConfig: { box: string } | null = null;

fake.setHandler("vault_box_config", () => boxConfig);
fake.setHandler("local_server_start", () => ({ url: LOCAL, vault }));
// Connecting a box writes sync.json and starts its sync loop; neither is what
// this test is about, but going through connectBox is what drops the cached
// "no box" answer, so the commands it makes are answered rather than stubbed out.
fake.setHandler("vault_box_connect", () => null);
fake.setHandler("box_post_json", (args: any) => {
  if (String(args?.url ?? "").includes("/api/v1/keys")) pushedTo.push(String(args.url));
  return { status: 200, body: "{}" };
});

const store = (await import("../../src/store.ts")).useStore;
// The app has read its keychain (main.tsx hydrateKeychain): a push waits for that.
store.setState({ vaultPath: vault, keysLoaded: true } as never);
const boxChat = await import("../../src/boxChat.ts");
const { ensureLocalServer } = boxChat;
const { keysChanged } = await import("../../src/boxKeys.ts");

// Importing boxChat leaves its polling alive, which would hold the test runner
// open after the last assertion (the same teardown boxorder.test.ts uses).
after(() => boxChat.stopBoxChat());

test("with no box, a key change reaches the server the app runs itself", async () => {
  boxConfig = null;
  pushedTo.length = 0;
  // Nothing has been started yet, so there is nowhere to push and nothing is
  // claimed — the sign-in itself still succeeded, which is why this is quiet
  // rather than an error.
  await keysChanged();
  assert.deepEqual(pushedTo, []);

  // The app settles on the vault and runs a server for it.
  const local = await ensureLocalServer(vault);
  assert.equal(local?.url, LOCAL);

  // NOW a sign-in reaches it. Without this the local server would never learn
  // the token and the AI would keep asking.
  await keysChanged();
  assert.deepEqual(pushedTo, [`${LOCAL}/api/v1/keys`]);
});

test("a box gets the sign-in, and wins over a server the app was running", async () => {
  // A second vault, because readBoxConfig caches its answer per vault for 30s
  // and this has to be a box from the first look. On ONE vault the switch is
  // immediate anyway: connectBox deletes that cached answer as it writes
  // sync.json (src/vaultSync.ts). Driving connectBox from here instead starts
  // its sync loop, which holds the test runner open — that is not what is
  // being checked.
  const withBox = makeTempVault("vc-one-signin-box-");
  boxConfig = { box: BOX };
  store.setState({ vaultPath: withBox });
  pushedTo.length = 0;

  await keysChanged();
  assert.deepEqual(pushedTo, [`${BOX}/api/v1/keys`], "the box, not a local server");

  // A box, once configured, is what the chat talks to, and nothing local is
  // started for that vault at all.
  assert.equal((await boxChat.boxLinkFor(withBox))?.url, BOX);
  assert.equal(await ensureLocalServer(withBox), null, "a vault with a box runs no server of its own");

  store.setState({ vaultPath: vault });
});

test("a box that lost the sign-in gets it back by itself", async () => {
  // Carl: Settings said "Signed in to Claude" while every chat waited for a
  // sign-in — the box had lost the token. The laptop holds it, so it pushes it
  // again the moment the box says it has none.
  const lost = makeTempVault("vc-one-signin-lost-");
  boxConfig = { box: BOX };
  fake.setHandler("box_get_json", (args: any) =>
    String(args?.url ?? "").includes("/api/v1/health")
      ? { status: 200, body: JSON.stringify({ ok: true, engine: { backend: "claude", claude: { state: "up", signedIn: false } } }) }
      : { status: 200, body: "{}" },
  );
  store.setState({ vaultPath: lost, serviceKeys: { claudeCode: "sk-ant-oat01-held" } } as never);
  pushedTo.length = 0;
  const { readClaudeHealth } = await import("../../src/claudeAuthLive.ts");
  await readClaudeHealth(true);
  for (let i = 0; i < 50 && !pushedTo.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(pushedTo, [`${BOX}/api/v1/keys`], "the sign-in went back to the box");
  store.setState({ vaultPath: vault, serviceKeys: {} } as never);
});

test("nothing is pushed for a vault the app is not holding", async () => {
  boxConfig = null;
  pushedTo.length = 0;
  store.setState({ vaultPath: null });
  await keysChanged();
  assert.deepEqual(pushedTo, [], "no vault, no server, no push");
  store.setState({ vaultPath: vault });
});
