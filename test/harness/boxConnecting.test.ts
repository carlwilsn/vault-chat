// Opening the app after a while (a wake from sleep, Tailscale still coming back, a box restart): the first requests to
// the box fail. The chat says "Connecting to the box…" (calm, no raw transport error) and retries quickly; the moment
// the box answers it is up (a quick head probe, not the next long poll). Only when it stays out of reach past the grace
// does it say so, in plain words (the raw error in the tooltip / the gate's reason). A message sent while connecting
// waits and goes when the box answers. Against a fake box with the real feed (test/harness/fakeBox.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-boxconnecting-");
const fake = installFakeTauri(vault);
const box = new FakeBox();

async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// The laptop's transport (reqwest) says "error sending request for url (…)" when the request never got an answer.
fake.setHandler("vault_box_config", () => ({ box: box.url, vault: "v" }));
fake.setHandler("box_get_json", async ({ url, timeoutMs }) => {
  try {
    const r = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs ?? 20000) });
    return { status: r.status, body: await r.text() };
  } catch {
    throw `error sending request for url (${url})`;
  }
});
fake.setHandler("box_post_json", async ({ url, body }) => {
  try {
    const r = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20000) });
    return { status: r.status, body: await r.text() };
  } catch {
    throw `error sending request for url (${url})`;
  }
});

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const chat = await import("../../src/chat-controller.ts");
const { chatGateOf } = await import("../../src/chatGate.ts");
const { composerOffers } = await import("../../src/plugins/composer/index.tsx");
const S = () => useStore.getState();

// Every state the chat passes through, to prove "unreachable" never flashed during a transient failure.
const seen: (boolean | null)[] = [];
useStore.subscribe((s) => {
  const r = s.boxChat?.on ? s.boxChat.reachable : undefined;
  if (r !== undefined && seen.at(-1) !== r) seen.push(r);
});

const GRACE = 1500;
bc.connectTiming.graceMs = GRACE;
bc.connectTiming.retryMs = 200;
bc.connectTiming.slowRetryMs = 300;

before(async () => {
  await box.start();
  // The app opens while the box can't be reached yet.
  box.down = true;
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
});

after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("a transient failure on open: Connecting, never the error; recovers by itself the moment the box answers", async () => {
  await waitFor("a failed attempt", () => S().boxChat?.on === true && /error sending request/.test(S().boxChat?.reason ?? ""));
  const g = chatGateOf(S());
  assert.equal(g.connecting, true);
  assert.equal(g.boxDown, false, "not called out of reach inside the grace");
  assert.equal(g.ready, true, "typing and Send stay on: a message waits for the box");
  // The agent reads the same: the composer's send state says connecting, with the raw error only as diagnostics.
  const send = (composerOffers().state.send.read as () => any)();
  assert.equal(send.connecting, true);
  assert.match(send.lastError, /error sending request/);
  // On screen: the calm words, muted, the raw error only in the tooltip.
  const { Composer } = await import("../../src/plugins/composer/Composer.tsx");
  const snap = useStore.getInitialState();
  Object.assign(snap, { vaultPath: vault, boxChat: S().boxChat });
  const html = renderToStaticMarkup(createElement(Composer));
  assert.match(html, /placeholder="Connecting to the box…"/);
  assert.match(html, /data-el="box-connecting"/);
  assert.doesNotMatch(html, /data-el="box-unreachable"/);
  assert.doesNotMatch(html.replace(/title="[^"]*"/g, ""), /error sending request/, "the transport's words only in the tooltip");
  assert.doesNotMatch(html, /text-amber/);
  // The box comes back well inside the grace: up at once (the head probe), not after a long poll.
  await new Promise((r) => setTimeout(r, 300));
  box.down = false;
  const t0 = Date.now();
  await waitFor("up", () => S().boxChat?.reachable === true, 3000);
  assert.ok(Date.now() - t0 < 1500, `up within the retry, not a long poll (${Date.now() - t0} ms)`);
  assert.ok(!seen.includes(false), `never "unreachable": ${JSON.stringify(seen)}`);
  assert.equal(chatGateOf(S()).connecting, false);
});

test("a message sent while connecting waits and goes when the box answers (never NOT sent)", async () => {
  box.down = true;
  await waitFor("connecting again", () => S().boxChat?.reachable === null && !!S().boxChat?.reason, 5000);
  const sent = chat.sendMessage("typed while it reconnects");
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(S().messages.some((m) => m.role === "user" && m.content === "typed while it reconnects"), "shown at once");
  box.down = false;
  await sent;
  await waitFor("delivered", () => box.intents.some((i: any) => i.text === "typed while it reconnects"), 5000);
  assert.ok(!S().messages.some((m) => /NOT sent/.test(String(m.content))));
  assert.ok(!seen.includes(false), `never "unreachable": ${JSON.stringify(seen)}`);
});

test("the box stays out of reach: after the grace a plain-words line (the raw error only as the reason)", async () => {
  box.down = true;
  await waitFor("connecting", () => S().boxChat?.reachable === null && !!S().boxChat?.reason, 5000);
  const t0 = Date.now();
  await waitFor("out of reach", () => S().boxChat?.reachable === false, GRACE + 3000);
  assert.ok(Date.now() - t0 >= GRACE - 600, "not before the grace");
  const g = chatGateOf(S());
  assert.equal(g.boxDown, true);
  assert.equal(g.connecting, false);
  const why = bc.unreachableWhy(g.reason);
  assert.doesNotMatch(why, /error sending request|https?:/);
  assert.equal(why, "the box is not answering");
  const { Composer } = await import("../../src/plugins/composer/Composer.tsx");
  const snap = useStore.getInitialState();
  Object.assign(snap, { vaultPath: vault, boxChat: S().boxChat });
  const html = renderToStaticMarkup(createElement(Composer));
  assert.match(html, /data-el="box-unreachable"/);
  assert.match(html, /Box unreachable: the box is not answering/);
  assert.doesNotMatch(html.replace(/title="[^"]*"/g, ""), /error sending request/);
  assert.doesNotMatch(html, /<textarea[^>]*\sdisabled=""/, "typing stays on");
  // It comes back: up again by itself.
  box.down = false;
  bc._boxChatSession()!.kick();
  await waitFor("back", () => S().boxChat?.reachable === true, 5000);
});
