// Connecting a box: what it needs, and what it says when nothing answers.
//
// Carl, on a release: Settings → Box told him to "Add your OpenRouter key under
// Keys first" and would not sync without one, and a box that didn't answer said
// `School2 didn't answer: error sending request for url (…)`. With Claude only,
// connecting a box needs nothing but the Claude sign-in — and it has to work
// signed out, because the sign-in follows and is pushed on connect. When a box
// can't be reached the reason is almost always this laptop's Tailscale, so that
// is said in one line with the one thing to do about it. vault-chat never asks
// for a Tailscale login itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const root = join(import.meta.dirname, "..", "..");
const vault = makeTempVault("vc-connect-box-");
const fake = installFakeTauri(vault);

/** What was POSTed to the box, so a push can be checked rather than assumed. */
const posted: { url: string; body: unknown }[] = [];
fake.setHandler("vault_box_config", () => null);
fake.setHandler("box_post_json", (args: any) => {
  posted.push({ url: String(args?.url ?? ""), body: JSON.parse(String(args?.body ?? "{}")) });
  return { status: 200, body: "{}" };
});

const { tailscaleHelp, connectTrouble, GET_TAILSCALE_URL } = await import("../../src/tailscaleHelp.ts");
const { TailscaleNote } = await import("../../src/SettingsPane.tsx");
const { useStore } = await import("../../src/store.ts");
const { pushKeysToBox } = await import("../../src/boxKeys.ts");
const { KEY } = await import("../../src/keychain.ts");

const connected = { installed: true, connected: true, state: "Running", canOpen: true };

// ---- what connecting needs -------------------------------------------------

test("connecting a box works with no key at all: the empty set is pushed, not refused", async () => {
  useStore.setState({ vaultPath: vault, apiKeys: {} as never, serviceKeys: {} as never, boxToken: null });
  posted.length = 0;
  const err = await pushKeysToBox("http://box.example:8848");
  assert.equal(err, null, "a signed-out laptop must still be able to connect a box");
  assert.deepEqual(posted, [{ url: "http://box.example:8848/api/v1/keys", body: { keys: {} } }]);
});

test("the Claude sign-in is the only key that travels, and it travels on connect", async () => {
  useStore.setState({ serviceKeys: { claudeCode: "sk-ant-oat01-test" } as never });
  posted.length = 0;
  assert.equal(await pushKeysToBox("http://box.example:8848"), null);
  const keys = (posted[0]?.body as { keys: Record<string, string> }).keys;
  assert.deepEqual(Object.keys(keys), [KEY.claudeCode], "one key: the sign-in, under the name the box stores it as");
  assert.equal(keys[KEY.claudeCode], "sk-ant-oat01-test");
  useStore.setState({ serviceKeys: {} as never });
});

test("no OpenRouter key is asked for anywhere in the box section", () => {
  const src = readFileSync(join(root, "src", "SettingsPane.tsx"), "utf8");
  assert.ok(!/OpenRouter/i.test(src), "Settings must not name OpenRouter at all");
  // The old gate, in the two shapes it had: a sentence to paste a key first, and
  // a Sync button disabled without one.
  assert.ok(!/under Keys first/i.test(src));
  const sync = src.match(/<Button size="sm" onClick=\{\(\) => void sync\(\)\} disabled=\{([^}]*)\}/);
  assert.ok(sync, "the Sync button is still there to check");
  assert.equal(sync![1], 'busy === "sync"', "syncing waits on nothing but itself");
});

// ---- what it says when nothing answers -------------------------------------

test("Tailscale not installed: one line, and the download", () => {
  const h = tailscaleHelp({ installed: false, connected: false, state: "NotInstalled", canOpen: false });
  assert.ok(h);
  assert.match(h!.line, /Tailscale isn't installed/);
  assert.equal(h!.action?.label, "Get Tailscale");
  assert.equal(h!.action?.kind, "get");
  assert.match(GET_TAILSCALE_URL, /^https:\/\/tailscale\.com\//);
});

test("Tailscale installed but off: one line, and the app to open", () => {
  const needsLogin = tailscaleHelp({ installed: true, connected: false, state: "NeedsLogin", canOpen: true });
  assert.match(needsLogin!.line, /isn't signed in/);
  assert.equal(needsLogin!.action?.label, "Open Tailscale");
  const stopped = tailscaleHelp({ installed: true, connected: false, state: "NoService", canOpen: true });
  assert.match(stopped!.line, /isn't running/);
  // Nothing to open: the line still says what is wrong rather than offering a
  // button that cannot work.
  const noApp = tailscaleHelp({ installed: true, connected: false, state: "Stopped", canOpen: false });
  assert.match(noApp!.line, /“Stopped”/);
  assert.equal(noApp!.action, null);
});

test("Tailscale fine, or never asked: nothing is said about it", () => {
  assert.equal(tailscaleHelp(connected), null);
  assert.equal(tailscaleHelp(null), null, "not asked is not an answer — guessing would put a wrong line on screen");
  assert.equal(tailscaleHelp(undefined), null);
});

test("a box that didn't answer with Tailscale connected names the box and says why, in words", () => {
  const t = connectTrouble("School2", "error sending request for url (https://school2.tail.ts/api/v1/health): operation timed out", connected);
  assert.equal(t.line, "School2 didn't answer: the box did not answer in time.");
  assert.equal(t.action, null, "nothing to offer: Tailscale is up, so this is the box");
  // The raw message never reaches Carl in either case.
  assert.ok(!t.line.includes("error sending request"));
  const off = connectTrouble("School2", "error sending request for url (…): dns error", { ...connected, connected: false, state: "NeedsLogin" });
  assert.match(off.line, /Tailscale isn't signed in/);
  assert.equal(off.action?.label, "Open Tailscale");
});

// ---- on screen -------------------------------------------------------------

test("the line and its one button are what is drawn — and nothing at all when there is nothing to say", () => {
  const html = renderToStaticMarkup(
    createElement(TailscaleNote, { help: tailscaleHelp({ installed: true, connected: false, state: "NeedsLogin", canOpen: true }) }),
  );
  assert.match(html, /signed in on this laptop/, "the line itself (the apostrophe is escaped markup)");
  assert.match(html, /Open Tailscale<\/button>/);
  // One line, one button: no second sentence, no address, no raw error.
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.equal(renderToStaticMarkup(createElement(TailscaleNote, { help: null })), "");
});
