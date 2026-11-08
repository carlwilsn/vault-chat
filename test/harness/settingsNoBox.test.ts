// What Settings says on a machine that has just been installed.
//
// The first thing Carl sees there, on a fresh laptop with no box and no vault
// picked yet, was "Checking your Claude sign-in…" — for ever, because nothing
// was being asked: the health read needs an open vault to have a server to ask.
// Underneath it, Models said "Set on the box once it is connected", which stopped
// being true when the app started running a server itself.
//
// So this pins the line a fresh install actually shows — and that the Models
// row underneath it is gone for good (Carl: "no model picker in Settings at
// all"; a chat's model is chosen beside Send).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const root = join(import.meta.dirname, "..", "..");
const vault = makeTempVault("vc-settings-no-box-");
const fake = installFakeTauri(vault);
fake.setHandler("vault_box_config", () => null);
fake.setHandler("box_get_json", () => ({ status: 200, body: "{}" }));

const { useStore } = await import("../../src/store.ts");
const { ClaudeAccountLine } = await import("../../src/ClaudeCodeSignIn.tsx");
const { SIGN_IN_BUTTON, claudeAuthOf } = await import("../../src/claudeAuth.ts");
const live = await import("../../src/claudeAuthLive.ts");

test("with no vault open, the account line offers the sign-in instead of checking for ever", () => {
  live.forgetClaudeHealth();
  useStore.setState({ vaultPath: null, serviceKeys: {} as never });
  const html = renderToStaticMarkup(createElement(ClaudeAccountLine));
  assert.ok(!html.includes("Checking your Claude sign-in"), `still waiting on nothing: ${html}`);
  assert.match(html, new RegExp(SIGN_IN_BUTTON), "the one button is on screen");
});

test("the decision itself: an answer when nothing is being asked, a wait when something is", () => {
  const signedInHealth = { engine: { engines: { default: "claude", claude: { signedIn: true, version: "2.1.0" } } } };
  // No vault: nothing to ask, so this machine's own token is the whole answer.
  assert.deepEqual(claudeAuthOf(null, null, null), { signedIn: false, known: true });
  assert.deepEqual(claudeAuthOf("sk-ant-oat01-x", null, null), { signedIn: true, known: true });
  // A vault open and no health yet IS a wait — the guard that stops "sign in"
  // flashing at someone who is signed in only matters where something is being
  // asked, and it has to stay.
  assert.deepEqual(claudeAuthOf(null, "/vaults/School2", null), { signedIn: false, known: false });
  // And once it has answered, the box's word.
  assert.deepEqual(claudeAuthOf(null, "/vaults/School2", signedInHealth), { signedIn: true, known: true });
  assert.deepEqual(claudeAuthOf(null, "/vaults/School2", { engine: { engines: { default: "claude", claude: { signedIn: false } } } }), {
    signedIn: false,
    known: true,
  });
});

test("nothing in Settings still assumes a box is the only thing that runs a vault", () => {
  const src = readFileSync(join(root, "src", "SettingsPane.tsx"), "utf8");
  // Keys go to the box when there is one and to the server the app runs itself
  // when there is not (src/boxKeys.ts keysChanged), so saying "sent to the box"
  // was telling a laptop with no box that its sign-in went nowhere.
  assert.ok(!src.includes("sent to the box."), "the keys line still names the box as the only destination");
  assert.match(src, /given to whatever runs your vault/);
});

test("Settings has no model picker at all: the model is the chat's, beside Send", () => {
  // Carl: "No model picker in Settings at all." The line that used to wait on a
  // box for a model list is gone with the section itself (src/ChatModelPicker.tsx
  // is where a model is chosen now, per chat).
  const src = readFileSync(join(root, "src", "SettingsPane.tsx"), "utf8");
  for (const gone of ["Set on the box once it is connected", "Open a vault to choose the model.", "The models appear once the vault's server has answered.", "ModelsSection", "useAgentModel"]) {
    assert.ok(!src.includes(gone), `Settings still has a model picker: ${gone}`);
  }
});
