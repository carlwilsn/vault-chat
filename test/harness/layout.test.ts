// The agent's Layout tool, end to end, and the host layout actions it shares with plugins.
//  1. The box's real tool (server/layoutTool.ts) puts a "layout" signal on a fake box's REAL feed; the laptop's box chat
//     (src/boxChat.ts) hands it to src/layoutOnLaptop.ts, which runs src/layoutOps.ts on the real store and acks with the
//     layout it read back; the tool's result is that ack (never an assumed success).
//  2. A plugin reaches the same ops through api.host.layout (src/hostApi.ts), with the app's own backend (src/hostBackend.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-layout-");
const fake = installFakeTauri(vault);
const box = new FakeBox();
box.showVault = vault;

async function fetchVia(url: string, init: RequestInit, timeoutMs: number) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    throw String((e as Error)?.message ?? e);
  }
}
fake.setHandler("vault_box_config", () => ({ box: box.url, vault: "v" }));
fake.setHandler("box_get_json", ({ url, timeoutMs }) => fetchVia(url, { method: "GET" }, timeoutMs ?? 20000));
fake.setHandler("box_post_json", ({ url, body }) => fetchVia(url, { method: "POST", body, headers: { "content-type": "application/json" } }, 20000));
fake.setHandler("path_exists", ({ path }) => fs.existsSync(path));
fake.setHandler("read_binary_file", ({ path }) => [...fs.readFileSync(path)]);
fake.setHandler("conversations_write_all", () => null);

const W = (rel: string, body: string) => {
  fs.mkdirSync(`${vault}/${rel}`.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(`${vault}/${rel}`, body);
};
W("a.md", "# A\n");
W("b.md", "# B\n");
W("c.md", "# C\n");

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const { layoutTool } = await import("../../server/layoutTool.ts");
const { resetPresence } = await import("../../server/show.ts");
const { createHostApi } = await import("../../src/hostApi.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const S = () => useStore.getState();

async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sent: Record<string, unknown>[] = [];
const emit = (ev: Record<string, unknown>) => (sent.push(ev), void box.emit(null, { type: "signal", signal: ev } as any));
const Layout = (args: Record<string, unknown>, ackMs = 5000) => layoutTool({ vault, emit, ackMs }, args);
/** The layout JSON in a tool result. */
const layoutOf = (text: string) => JSON.parse(text.split("\n").at(-1)!);

before(async () => {
  resetPresence();
  await box.start();
  useStore.setState({ vaultPath: vault, leftCollapsed: false, rightCollapsed: false, chatFullscreen: false, popoutOpen: false });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("the laptop polls the feed as client=laptop", () => box.seen.some((x) => x.route === "GET /poll"));
});
after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("get: the agent sees the real layout, read back from the app's store", async () => {
  const r = await Layout({ action: "get" });
  assert.equal(r.ok, true, r.text);
  const l = layoutOf(r.text);
  assert.equal(l.split, false);
  assert.deepEqual(l.panes, []);
  assert.equal(l.leftPanelOpen, true);
  assert.equal(l.rightPanelOpen, true);
  assert.equal("chatFullscreen" in l, false, "no full-screen state in the layout");
  assert.equal(sent.at(-1)!.type, "layout");
});

test("openInPane puts files in panes (turning the split on) and the result is the layout read back", async () => {
  let r = await Layout({ action: "openInPane", path: "a.md", pane: "left" });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(layoutOf(r.text).panes.map((p: any) => p.file), ["a.md"]);
  r = await Layout({ action: "openInPane", path: "b.md", pane: "right" });
  assert.equal(r.ok, true, r.text);
  const l = layoutOf(r.text);
  assert.equal(l.split, true);
  assert.deepEqual(l.panes.map((p: any) => [p.side, p.file]), [["left", "a.md"], ["right", "b.md"]]);
  assert.equal(l.activePane, "right");
});

test("focus, closePane and split off change the real store, and the read-back says so", async () => {
  let r = await Layout({ action: "focus", target: "left" });
  assert.equal(layoutOf(r.text).activePane, "left");
  r = await Layout({ action: "closePane", pane: "right" });
  assert.equal(r.ok, true, r.text);
  let l = layoutOf(r.text);
  assert.equal(l.split, false);
  assert.equal(l.currentFile, "a.md");
  assert.equal(S().panes.length, 0);
  // A pane that is not there: refused with why, nothing assumed.
  r = await Layout({ action: "closePane", pane: "right" });
  assert.equal(r.ok, false);
  assert.match(r.text, /FAILED: there is no split/);
  // Split on with one file: refused; off when not split: a no-op, not an error.
  r = await Layout({ action: "split", on: true });
  assert.equal(r.ok, false);
  r = await Layout({ action: "split", on: false });
  assert.equal(r.ok, true);
  await Layout({ action: "openInPane", path: "c.md", pane: "right" });
  r = await Layout({ action: "split", on: false });
  l = layoutOf(r.text);
  assert.equal(l.split, false);
  assert.equal(l.currentFile, "c.md", "off keeps the active pane");
});

test("panels and full-screen chat: several ops at once, each reported, the final layout is the screen's", async () => {
  // The right panel is Chats (the chat list); every chat is a tile.
  const r = await Layout({ ops: [{ action: "closeLeftPanel" }, { action: "closeRightPanel" }] });
  assert.equal(r.ok, true, r.text);
  let l = layoutOf(r.text);
  assert.equal(l.leftPanelOpen, false);
  assert.equal(l.rightPanelOpen, false);
  assert.equal(S().leftCollapsed, true);
  assert.equal(S().chatSidebarOpen, false);
  const again = await Layout({ action: "closeLeftPanel" });
  assert.match(again.text, /already closed/);
  await Layout({ action: "openLeftPanel" });
  await Layout({ action: "openRightPanel" });
  assert.equal(S().leftCollapsed, false);
  assert.equal(S().chatSidebarOpen, true);
  // No zoom (Carl 11-25): full screen is one tile filling the viewer; the noun has no fullscreen / maximize action.
  for (const action of ["fullscreenChat", "maximize"]) assert.match((await Layout({ action, on: true })).text, /unknown|not an action|no action|isn't|is not/i, action);
  assert.equal("chatFullscreen" in l, false, "no full-screen state in the layout");
});

test("a pane holds a web page: opened, read back with its address and title, navigated, driven, closed", async () => {
  const { registerWebPane, paneKey, boxDevUrl, embedKind } = await import("../../src/webPane.ts");
  const { show } = await import("../../server/show.ts");
  await Layout({ action: "split", on: false });
  useStore.setState({ currentFile: null, currentContent: "", panes: [], activePaneId: null, splitDirection: null });
  // In place of the active pane's (nothing open: alone).
  let r = await Layout({ action: "openInPane", url: "https://example.com/a" });
  assert.equal(r.ok, true, r.text);
  let l = layoutOf(r.text);
  assert.deepEqual(l.panes, [{ side: "single", url: "https://example.com/a", active: true }]);
  assert.equal(l.currentUrl, "https://example.com/a");
  assert.equal(l.currentFile, null, "a page is not a file");
  // Its title, once the page says it.
  S().setWebTitle("https://example.com/a", "Example A");
  l = layoutOf((await Layout({ action: "get" })).text);
  assert.equal(l.panes[0].title, "Example A");
  // A file beside it: the split, as for two files.
  r = await Layout({ action: "openInPane", path: "a.md", pane: "left" });
  l = layoutOf(r.text);
  assert.deepEqual(l.panes.map((p: any) => [p.side, p.file ?? p.url]), [["left", "a.md"], ["right", "https://example.com/a"]]);
  // The page's buttons: refused on a file, honest when no live view is behind them, run when one is.
  r = await Layout({ action: "webPage", do: "back" });
  assert.equal(r.ok, false);
  assert.match(r.text, /shows a file, not a web page/);
  r = await Layout({ action: "webPage", do: "reload", pane: "right" });
  assert.equal(r.ok, false);
  assert.match(r.text, /a link here, not a live view/);
  const right = S().panes[1]!.id;
  const did: string[] = [];
  const off = registerWebPane(paneKey(right), { live: true, act: async (w, u) => void did.push(u ? `${w} ${u}` : w) });
  r = await Layout({ ops: [{ action: "webPage", do: "back", pane: "right" }, { action: "webPage", do: "browser", pane: "right", url: "https://example.org/x" }] });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(did, ["back", "browser https://example.org/x"]);
  off();
  // Carl follows a link in the page: the pane's address is where he is now.
  S().setPaneFile(right, "https://example.com/b", "");
  l = layoutOf((await Layout({ action: "get" })).text);
  assert.equal(l.panes[1].url, "https://example.com/b");
  assert.equal(l.panes[1].title, undefined, "the old page's title is not the new one's");
  // The agent sends the same pane elsewhere.
  r = await Layout({ action: "openInPane", url: "https://example.com/c", pane: "right" });
  assert.equal(layoutOf(r.text).panes[1].url, "https://example.com/c");
  // Show {url, pane} opens it in the viewer, not the browser.
  const sh = await show({ vault, device: "laptop", emit, ackMs: { laptop: 5000 } }, { url: "https://example.net/", where: "laptop", pane: "left" });
  assert.equal(sh.ok, true, sh.text);
  assert.match(sh.text, /in the left pane/);
  assert.equal(S().panes[0]!.file, "https://example.net/");
  // Closed: back to one; with no split, closePane with no pane closes the one page.
  r = await Layout({ action: "closePane", pane: "left" });
  assert.deepEqual(layoutOf(r.text).panes, [{ side: "single", url: "https://example.com/c", active: true }]);
  r = await Layout({ action: "closePane" });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(layoutOf(r.text).panes, []);
  // A dev server: localhost goes through the box's proxy (as Show's), never as localhost.
  const n = sent.length;
  r = await Layout({ action: "openInPane", url: "http://localhost:1560/after/" });
  assert.equal(r.ok, false);
  assert.match(r.text, /no proxy/);
  assert.equal(sent.length, n, "refused before anything was sent");
  r = await layoutTool({ vault, emit, ackMs: 5000, dev: async (port) => ({ origin: `https://box.tail1.ts.net:${port}` }) }, { action: "openInPane", url: "http://localhost:1560/after/?scenario=x" });
  assert.equal(r.ok, true, r.text);
  assert.equal(S().currentFile, "https://box.tail1.ts.net:1560/after/?scenario=x");
  // What the dev page shows, as its frame reported it (server/devProxy.ts frameScript): read back in its pane.
  const seen = { text: "Hello\nOpen a vault", textLength: 18, errors: ["boom"], failed: [{ status: 401, url: "https://box.tail1.ts.net:1560/after/x.json", how: "GET" }], at: "2026-11-24T00:00:00.000Z" };
  S().setWebPage("https://box.tail1.ts.net:1560/after/?scenario=x", seen);
  r = await Layout({ action: "get" });
  assert.deepEqual(layoutOf(r.text).panes[0].page, seen);
  assert.match(r.text, /18 chars of text, 1 errors, 1 failed requests/);
  // Which addresses show: public pages (the native view) and the box's dev origin (an iframe); the rest a link with why.
  assert.equal(boxDevUrl("https://box.tail1.ts.net:1560/"), true);
  assert.equal(boxDevUrl("http://box.tail1.ts.net:1560/"), false);
  assert.deepEqual(embedKind("https://example.com/"), { kind: "public" });
  assert.deepEqual(embedKind("https://box.tail1.ts.net:1560/"), { kind: "dev" });
  assert.ok("link" in embedKind("http://192.168.1.4/"));
  // Bad input.
  assert.match((await Layout({ action: "openInPane", url: "ftp://x" })).text, /http\(s\) address/);
  assert.match((await Layout({ action: "openInPane", url: "https://x.com", path: "a.md" })).text, /not both/);
  assert.match((await Layout({ action: "webPage", do: "dance" })).text, /needs do/);
  await Layout({ action: "closePane" });
});

test("a public page is driven: read with refs, click / type / scroll / select through the pane's view, read back", async () => {
  const { registerWebPane, paneKey, setPickingPane } = await import("../../src/webPane.ts");
  const { driveScript, answerOf, seenOf, driveOpFor, pickContext, TEXT_MAX, ELEMENTS_MAX } = await import("../../src/webDrive.ts");
  const { useDraft, clearDraft } = await import("../../src/plugins/composer/draft.ts");
  const { composerOffers } = await import("../../src/plugins/composer/index.tsx");
  useStore.setState({ currentFile: null, currentContent: "", panes: [], activePaneId: null, splitDirection: null });
  clearDraft();
  const url = "https://example.com/login";
  assert.equal((await Layout({ action: "openInPane", url })).ok, true);
  // A stand-in for the native view: the page script's steps as the view would answer them (web_embed_eval).
  const steps: Record<string, unknown>[] = [];
  let text = "Sign in";
  const page = (): Record<string, unknown> => ({ url, title: "Sign in", text, textLength: text.length, elements: ['e1 textbox "Email"', 'e2 password "Password" (filled)', 'e3 button "Sign in"'], scroll: { y: 0, max: 900 } });
  const picks: boolean[] = [];
  const off = registerWebPane(paneKey(null), {
    live: true,
    act: async () => undefined,
    drive: async (op) => {
      steps.push(op as Record<string, unknown>);
      if (op.op === "click" && op.ref === "e9") return { error: "no element e9 on the page now (read it again)" };
      if (op.op === "click") text = "Welcome";
      if (op.op === "describe") return { picked: { url, ref: op.ref, tag: "button", label: "Sign in", text: "Sign in", html: '<button type="submit">Sign in</button>' } };
      return op.op === "read" ? page() : { did: `${op.op} done` };
    },
    read: async () => void S().setWebPage(url, seenOf(page())),
    pick: async (on) => void (picks.push(on), setPickingPane(paneKey(null), on)),
  });
  try {
    // read: the page's text and elements, into the pane's read-back.
    let r = await Layout({ action: "webPage", do: "read" });
    assert.equal(r.ok, true, r.text);
    let pg = layoutOf(r.text).panes[0].page;
    assert.deepEqual(pg.elements, ['e1 textbox "Email"', 'e2 password "Password" (filled)', 'e3 button "Sign in"']);
    assert.equal(pg.errors, undefined, "a public page claims no error count it never read");
    assert.match(r.text, /3 elements/);
    // type, then click by text: each step runs in the page, and the answer is the page read again.
    r = await Layout({ action: "webPage", do: "type", ref: "e1", value: "carl@example.com", enter: true });
    assert.equal(r.ok, true, r.text);
    assert.deepEqual(steps.at(-1), { op: "type", ref: "e1", value: "carl@example.com", enter: true });
    r = await Layout({ action: "webPage", do: "click", text: "Sign in" });
    assert.equal(r.ok, true, r.text);
    // Carl watches it: the agent's cursor goes to the element first, then the click.
    assert.deepEqual(steps.slice(-2), [{ op: "point", text: "Sign in" }, { op: "click", text: "Sign in" }]);
    assert.equal(layoutOf(r.text).panes[0].page.text, "Welcome", "read back after the click");
    r = await Layout({ action: "webPage", do: "scroll", by: "bottom" });
    assert.deepEqual(steps.at(-1), { op: "scroll", by: "bottom" });
    // A stale ref: the page's own word, not a success.
    r = await Layout({ action: "webPage", do: "click", ref: "e9" });
    assert.equal(r.ok, false);
    assert.match(r.text, /no element e9/);
    // select with a ref: the element is a chip in the composer (its state), and it goes with the message as context.
    r = await Layout({ action: "webPage", do: "select", ref: "e3" });
    assert.equal(r.ok, true, r.text);
    const sel = (composerOffers().state.draft.read() as { selections?: { name: string; ref: string; html: string }[] }).selections;
    assert.deepEqual(sel?.map((x) => [x.name, x.ref]), [["button · Sign in", "e3"]]);
    assert.match(pickContext(useDraft.getState().picks), /e3 <button> "Sign in"[\s\S]*html: <button/);
    composerOffers().actions.detach.run({ name: "button · Sign in" });
    assert.equal(useDraft.getState().picks.length, 0, "the chip's x (detach) takes it off");
    // select without one: Select is on (Carl picks), and the pane says so.
    r = await Layout({ action: "webPage", do: "select" });
    assert.equal(r.ok, true, r.text);
    assert.deepEqual(picks, [true]);
    assert.equal(layoutOf(r.text).panes[0].picking, true);
    setPickingPane(paneKey(null), false);
    // Bad input never reaches the page.
    const n = steps.length;
    assert.match((await Layout({ action: "webPage", do: "click" })).text, /needs ref/);
    assert.match((await Layout({ action: "webPage", do: "type", ref: "e1" })).text, /needs value/);
    assert.match((await Layout({ action: "webPage", do: "click", ref: "button" })).text, /like "e12"/);
    assert.equal(steps.length, n);
  } finally {
    off();
  }
  // A pane without a drivable view (the dev server's iframe) says so.
  const off2 = registerWebPane(paneKey(null), { live: true, act: async () => undefined });
  const r = await Layout({ action: "webPage", do: "read" });
  assert.equal(r.ok, false);
  assert.match(r.text, /only a public page's view can be driven/);
  off2();
  await Layout({ action: "closePane" });

  // The page script itself: valid JS for every step, and typed text kept exactly ("$&" is not a replacement pattern).
  for (const op of [{ op: "read" }, { op: "click", text: "a" }, { op: "type", ref: "e1", value: "x$&y'\"</script>", enter: true }, { op: "scroll", by: -200 }, { op: "describe", ref: "e1" }, { op: "point", ref: "e1" }, { op: "pickStart" }, { op: "pickPoll" }, { op: "pickStop" }] as const) {
    const js = driveScript(op as never);
    assert.doesNotThrow(() => new Function(js), `${op.op}: the script parses`);
    assert.ok(js.includes(JSON.stringify(op)), `${op.op}: the op is in the script as JSON`);
  }
  // Answers as WebView2 (JSON of the script's JSON string) and WKWebView (the string) give them; nothing else is one.
  assert.deepEqual(answerOf(JSON.stringify(JSON.stringify({ did: "x" }))), { did: "x" });
  assert.deepEqual(answerOf(JSON.stringify({ did: "x" })), { did: "x" });
  assert.equal(answerOf("null"), null);
  assert.equal(answerOf("not json"), null);
  // The page's word bounded again.
  const big = seenOf({ text: "x".repeat(TEXT_MAX * 2), textLength: 5, elements: Array.from({ length: ELEMENTS_MAX + 50 }, (_, i) => `e${i} link`), elementCount: 999, scroll: { y: -3, max: "a" } });
  assert.equal(big.text.length, TEXT_MAX);
  assert.equal(big.textLength, TEXT_MAX, "never less than what is shown");
  assert.equal(big.elements!.length, ELEMENTS_MAX);
  assert.equal(big.elementCount, 999);
  assert.deepEqual(big.scroll, { y: 0, max: 0 });
  assert.deepEqual(driveOpFor("scroll", { by: "sideways" }), 'scroll\'s by is pixels (down; negative: up), "top" or "bottom"');
});

test("a dev-server pane (an iframe) keeps its own history from where the page says it is", async () => {
  const { frameHistory, frameArrived, frameStep } = await import("../../src/webPane.ts");
  const D = "https://box.tail1.ts.net:1560";
  let h = frameHistory(`${D}/a`);
  // The page reports where it landed: the address the pane sent it to, or a redirect's end (replacing that entry).
  h = frameArrived(h, `${D}/a`, true);
  assert.deepEqual(h, { stack: [`${D}/a`], at: 0 });
  h = frameArrived(h, `${D}/a/`, true);
  assert.deepEqual(h, { stack: [`${D}/a/`], at: 0 });
  // Carl follows two links: two entries.
  h = frameArrived(h, `${D}/b`);
  h = frameArrived(h, `${D}/c`);
  assert.deepEqual(h, { stack: [`${D}/a/`, `${D}/b`, `${D}/c`], at: 2 });
  // Back twice, forward once (the pane's buttons / webPage), and the end says so.
  let s = frameStep(h, -1)!;
  assert.equal(s.url, `${D}/b`);
  s = frameStep(s.h, -1)!;
  assert.equal(s.url, `${D}/a/`);
  assert.equal(frameStep(s.h, -1), null, "nothing before the first page");
  s = frameStep(s.h, 1)!;
  assert.equal(s.url, `${D}/b`);
  h = frameArrived(s.h, `${D}/b`, true);
  assert.equal(h.at, 1, "the page arriving where it was sent changes nothing");
  // The window's own Back (a mouse button) lands on the entry before: one step back, not a new entry.
  h = frameArrived(h, `${D}/a/`);
  assert.deepEqual(h, { stack: [`${D}/a/`, `${D}/b`, `${D}/c`], at: 0 });
  // A new page from here drops what was ahead, as a browser does.
  h = frameArrived(h, `${D}/d`);
  assert.deepEqual(h, { stack: [`${D}/a/`, `${D}/d`], at: 1 });
  assert.equal(frameStep(h, 1), null);
});

test("a web pane's address bar: what was typed opens through the agent's own openInPane, in that pane", async () => {
  const { addressFor, openTyped } = await import("../../src/webPane.ts");
  // An address as it is; a host gets https://; other words are a search; nothing typed opens nothing.
  assert.equal(addressFor("https://en.wikipedia.org/wiki/Cat"), "https://en.wikipedia.org/wiki/Cat");
  assert.equal(addressFor("  en.wikipedia.org/wiki/Dog "), "https://en.wikipedia.org/wiki/Dog");
  assert.equal(addressFor("example.com:8080/x?y=1"), "https://example.com:8080/x?y=1");
  assert.equal(addressFor("localhost:5173"), "https://localhost:5173");
  assert.equal(addressFor("cauchy sequence"), "https://duckduckgo.com/?q=cauchy%20sequence");
  assert.equal(addressFor("wikipedia"), "https://duckduckgo.com/?q=wikipedia");
  assert.equal(addressFor("   "), null);
  assert.equal(openTyped("  "), null);

  await Layout({ action: "split", on: false });
  useStore.setState({ currentFile: null, currentContent: "", panes: [], activePaneId: null, splitDirection: null });
  // The one viewer: the page goes in its place, as openInPane {url} with no pane does.
  await Layout({ action: "openInPane", url: "https://en.wikipedia.org/wiki/Cat" });
  assert.match(openTyped("en.wikipedia.org/wiki/Dog")!, /opened https:\/\/en\.wikipedia\.org\/wiki\/Dog/);
  assert.equal(S().currentFile, "https://en.wikipedia.org/wiki/Dog");
  // A split: typed in the right pane's bar, the right pane goes there (openInPane {url, pane: "right"}).
  await Layout({ ops: [{ action: "openInPane", path: "a.md", pane: "left" }, { action: "openInPane", url: "https://en.wikipedia.org/wiki/Cat", pane: "right" }, { action: "focus", target: "left" }] });
  const right = S().panes[1]!.id;
  assert.match(openTyped("green tree frog", right)!, /in the right pane/);
  assert.equal(S().panes[0]!.file, `${vault}/a.md`);
  assert.equal(S().panes[1]!.file, "https://duckduckgo.com/?q=green%20tree%20frog");
  // The agent reads the new address back.
  const l = layoutOf((await Layout({ action: "get" })).text);
  assert.deepEqual(l.panes.map((p: any) => p.file ?? p.url), ["a.md", "https://duckduckgo.com/?q=green%20tree%20frog"]);
});

test("bad input is refused before anything is sent; an offline laptop is said honestly", async () => {
  const n = sent.length;
  // A file with no pane goes where new things go (tiles); a spot that isn't one is refused here.
  assert.match((await Layout({ action: "moveTile", tile: "t1", spot: "middle" })).text, /spot is one of/);
  assert.match((await Layout({ action: "dance" })).text, /Unknown layout action/);
  assert.match((await Layout({})).text, /needs action/);
  assert.equal(sent.length, n);
  resetPresence();
  const off = await Layout({ action: "get" });
  assert.equal(off.ok, false);
  assert.match(off.text, /laptop isn't online/);
  assert.equal(sent.length, n);
});

test("a plugin and the agent use the same ops: api.host.layout.apply / get through the app's backend", async () => {
  const alive = () => true;
  const fx = { add: (_n: string, f: () => void) => f } as any;
  const api = createHostApi(appHostBackend, fx, alive, (f) => f);
  await api.layout.apply([{ op: "openInPane", path: "a.md", pane: "left" }, { op: "openInPane", path: "b.md", pane: "right" }]);
  const l = api.layout.get();
  assert.equal(l.split, true);
  assert.deepEqual(l.panes.map((p) => p.file), ["a.md", "b.md"]);
  const r = await api.layout.apply({ op: "closePane", pane: "left" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.layout.panes.map((p) => p.file), ["b.md"]);
  assert.equal(r.layout.split, false);
  const bad = await api.layout.apply({ op: "focus", target: "left" });
  assert.equal(bad.ok, false);
  assert.match(bad.results[0]!.error!, /no split/);
  // A stopped run's api does nothing.
  const dead = createHostApi(appHostBackend, fx, () => false, (f) => f);
  assert.equal((await dead.layout.apply({ op: "openLeftPanel" })).ok, false);
});

test("three columns (Carl 11-25): the agent makes them with the drop's own op and reads them back; a column splits; halves are refused there", async () => {
  const alive = () => true;
  const fx = { add: (_n: string, f: () => void) => f } as any;
  const api = createHostApi(appHostBackend, fx, alive, (f) => f);
  await api.layout.apply([{ op: "openInPane", path: "a.md", pane: "left" }, { op: "openInPane", path: "b.md", pane: "right" }]);
  const spots = (l: any) => (l.tiles as any[]).map((t) => `${t.spot}=${t.empty ? "-" : (t.file ?? t.chat).split("/").pop()}`).join(" ");
  assert.equal(spots(api.layout.get()), "left=a.md right=b.md");
  let r = await api.layout.apply({ op: "openInPane", path: "c.md", spot: "middle-third" });
  assert.equal(r.ok, true);
  assert.equal(spots(r.layout), "left-third=a.md middle-third=c.md right-third=b.md");
  assert.deepEqual([r.layout.tileSplit!.t1, r.layout.tileSplit!.t2].map((v) => Math.round(v * 1000)), [333, 667]);
  // A column's top half: the column there shrinks into the bottom half, the moved tile's column stays, empty.
  const c = (r.layout.tiles as any[]).find((t) => t.file?.endsWith("c.md")).tile;
  r = await api.layout.apply({ op: "moveTile", tile: c, spot: "top-right-third" });
  assert.equal(r.ok, true);
  assert.equal(spots(r.layout), "left-third=a.md middle-third=- top-right-third=c.md bottom-right-third=b.md");
  // A half is no spot in three columns; a fifth spot neither.
  r = await api.layout.apply({ op: "moveTile", tile: c, spot: "left" });
  assert.equal(r.ok, false);
  r = await api.layout.apply({ op: "openInPane", path: "a.md", spot: "top-left-third" });
  assert.equal(r.ok, false);
  // The lines: dragged as the dividers are.
  r = await api.layout.apply({ op: "resize", tiles: { t1: 0.25, c2: 0.4 } });
  assert.equal(r.layout.tileSplit!.t1, 0.25);
  assert.equal(r.layout.tileSplit!.c2, 0.4);
  // The empty middle closed: two columns are two halves again.
  const mid = (r.layout.tiles as any[]).find((t) => t.empty).tile;
  r = await api.layout.apply({ op: "closePane", tile: mid });
  assert.equal(spots(r.layout), "left=a.md top-right=c.md bottom-right=b.md");
});

test("zoom (Carl 11-25): Ctrl+= / Ctrl+- / Ctrl+0 and the agent's zoom are one op on one tile's content; the step is the viewers' 1.1", async () => {
  const alive = () => true;
  const fx = { add: (_n: string, f: () => void) => f } as any;
  const api = createHostApi(appHostBackend, fx, alive, (f) => f);
  const { hit } = await import("../../src/shortcuts.ts");
  const key = (k: string, code: string, shiftKey = false) => ({ key: k, code, ctrlKey: true, metaKey: false, shiftKey, altKey: false });
  assert.equal(hit(key("=", "Equal") as any, "view.zoomIn", false), true);
  assert.equal(hit(key("+", "Equal", true) as any, "view.zoomIn", false), true);
  assert.equal(hit(key("-", "Minus") as any, "view.zoomOut", false), true);
  assert.equal(hit(key("0", "Digit0") as any, "view.zoomReset", false), true);
  let r = await api.layout.apply([{ op: "openInPane", path: "a.md", pane: "left" }, { op: "openInPane", path: "b.md", pane: "right" }]);
  const tiles = (l: any) => l.tiles as any[];
  const b = tiles(r.layout).find((t) => t.file?.endsWith("b.md")).tile;
  r = await api.layout.apply({ op: "zoom", tile: b, zoom: "in" });
  r = await api.layout.apply({ op: "zoom", tile: b, zoom: "in" });
  assert.equal(tiles(r.layout).find((t) => t.tile === b).zoom, 1.21);
  assert.equal(tiles(r.layout).find((t) => t.file?.endsWith("a.md")).zoom, undefined);
  r = await api.layout.apply({ op: "zoom", tile: b, zoom: "out" });
  assert.equal(tiles(r.layout).find((t) => t.tile === b).zoom, 1.1);
  r = await api.layout.apply({ op: "zoom", tile: b, zoom: "reset" });
  assert.equal(tiles(r.layout).find((t) => t.tile === b).zoom, undefined);
  r = await api.layout.apply({ op: "zoom", tile: b, zoom: "big" as any });
  assert.equal(r.ok, false);
});
