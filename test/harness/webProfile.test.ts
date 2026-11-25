// The web pages' kept profile and downloads (src/webProfile.ts, src-tauri/src/web_embed.rs), end to end on the app's side:
//  1. box:workspace signOutOfSites (the model noun the agent calls) travels the real feed to the laptop, runs the layout
//     op there, and that op is the shell's web_profile_clear: the one action the Settings button calls too.
//  2. A download the shell reports ending becomes the store's downloads, the layout's `downloads` the workspace noun
//     reads (name, vault-relative path, size, time; the source only as a host), and the pane's "Saved <name>" notice.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-webprofile-");
const fake = installFakeTauri(vault);
const box = new FakeBox();
box.showVault = vault;
const g = globalThis as any;
g.isTauri = true;

// Events: keep the callbacks the app listens with, so the shell's "web-embed" reports can be delivered.
const callbacks = new Map<number, (e: unknown) => void>();
const listeners: { event: string; handler: number }[] = [];
let nextCb = 1;
g.__TAURI_INTERNALS__.transformCallback = (cb: (e: unknown) => void) => (callbacks.set(nextCb, cb), nextCb++);
fake.setHandler("plugin:event|listen", ({ event, handler }) => (listeners.push({ event, handler }), listeners.length));
const fire = (event: string, payload: unknown) => {
  for (const l of listeners.filter((x) => x.event === event)) callbacks.get(l.handler)?.({ event, id: 0, payload });
};

async function fetchVia(url: string, init: RequestInit, timeoutMs: number) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { status: r.status, body: await r.text() };
}
fake.setHandler("vault_box_config", () => ({ box: box.url, vault: "v" }));
fake.setHandler("box_get_json", ({ url, timeoutMs }) => fetchVia(url, { method: "GET" }, timeoutMs ?? 20000));
fake.setHandler("box_post_json", ({ url, body }) => fetchVia(url, { method: "POST", body, headers: { "content-type": "application/json" } }, 20000));
fake.setHandler("path_exists", ({ path }) => fs.existsSync(path));
fake.setHandler("conversations_write_all", () => null);
let cleared = 0;
fake.setHandler("web_profile_clear", () => (cleared++, 2));
const vaultsTold: (string | null)[] = [];
fake.setHandler("web_profile_vault", ({ vault: v }) => (vaultsTold.push(v), null));

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const { resetPresence } = await import("../../server/show.ts");
const { actBoxOffer } = await import("../../server/boxOffers.ts");
const { readLayout } = await import("../../src/layoutOps.ts");
const wp = await import("../../src/webProfile.ts");
const S = () => useStore.getState();

async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const emit = (ev: Record<string, unknown>) => void box.emit(null, { type: "signal", signal: ev } as any);
const deps = { vault, emit, ackMs: 5000 };

before(async () => {
  resetPresence();
  await box.start();
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("the laptop polls the feed", () => box.seen.some((x) => x.route === "GET /poll"));
});
after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("box:workspace signOutOfSites runs on the laptop as the shell's web_profile_clear, and says what it did", async () => {
  const r = await actBoxOffer(deps, "box:workspace", "signOutOfSites", {});
  assert.equal(r.ok, true, r.text);
  assert.equal(cleared, 1);
  assert.match(r.text, /signOutOfSites: done \(signed out of every site.*2 open pages reloaded\)/);
  // The Settings button is the same action (one path): it names the noun's action and calls signOutOfSites.
  const pane = fs.readFileSync(new URL("../../src/plugins/settings/Pane.tsx", import.meta.url), "utf8");
  assert.match(pane, /data-offer="box:workspace\.signOutOfSites"[^>]*onClick=\{\(\) => void signOut\(\)\}/);
  assert.match(pane, /await signOutOfSites\(\)/);
  const r2 = await wp.signOutOfSites();
  assert.equal(r2.ok, true);
  assert.equal(cleared, 2);
});

test("the shell refusing is said, not assumed", async () => {
  fake.setHandler("web_profile_clear", () => {
    throw "web pages need the Windows or macOS app";
  });
  const r = await actBoxOffer(deps, "box:workspace", "signOutOfSites", {});
  assert.equal(r.ok, false);
  assert.match(r.text, /FAILED: could not clear the web pages' profile: web pages need the Windows or macOS app/);
});

test("downloads: the shell is told the vault; an ended download is the layout's downloads and the pane's notice", async () => {
  wp.startWebProfile();
  await waitFor("the shell told the vault", () => vaultsTold.includes(vault));
  await waitFor("listening to the views", () => listeners.some((l) => l.event === "web-embed"));
  const abs = `${vault}/.vault-chat/downloads/Lecture 3 (1).pdf`;
  // Started: no notice yet; the source's url is only its host on a saved download.
  const started = { id: "w1", kind: "download", url: "drive.google.com", name: "Lecture 3 (1).pdf", path: abs };
  assert.equal(wp.downloadNote(started as any), undefined);
  fire("web-embed", started);
  assert.deepEqual(S().webDownloads, []);
  const ended = { id: "w1", kind: "downloaded", url: "drive.google.com", name: "Lecture 3 (1).pdf", path: abs, size: 52_431, ok: true };
  fire("web-embed", ended);
  await waitFor("the download is kept", () => S().webDownloads.length === 1);
  const d = S().webDownloads[0]!;
  assert.equal(d.name, "Lecture 3 (1).pdf");
  assert.equal(d.path, ".vault-chat/downloads/Lecture 3 (1).pdf");
  assert.equal(d.size, 52_431);
  assert.equal(d.ok, true);
  assert.equal(d.from, "drive.google.com");
  assert.ok(!Number.isNaN(Date.parse(d.at)));
  assert.deepEqual(wp.downloadNote(ended as any), { text: "Saved Lecture 3 (1).pdf" });
  // The workspace noun's state is the layout the laptop reads back: the downloads ride in it.
  assert.deepEqual(readLayout().downloads, [d]);
  const back = await actBoxOffer(deps, "box:workspace", "split", { on: false });
  assert.deepEqual((back.state!.layout as any).downloads, [d]);
  // A failed one is kept as failed (no size); a refused one (no vault) offers the browser.
  fire("web-embed", { id: "w1", kind: "downloaded", name: "big.zip", path: `${vault}/.vault-chat/downloads/big.zip`, ok: false });
  await waitFor("the failed one", () => S().webDownloads.length === 2);
  assert.deepEqual({ ...S().webDownloads[0]!, at: "" }, { name: "big.zip", path: ".vault-chat/downloads/big.zip", size: null, ok: false, at: "" });
  assert.deepEqual(wp.downloadNote({ id: "w1", kind: "downloaded", name: "big.zip", ok: false } as any), { text: "Download failed: big.zip" });
  assert.deepEqual(wp.downloadNote({ id: "w1", kind: "download", url: "https://x.com/f.pdf" } as any), { text: "No vault open to save downloads to", url: "https://x.com/f.pdf" });
  // No cookie, token or query string in what the agent reads.
  assert.doesNotMatch(JSON.stringify(readLayout()), /token|cookie|\?/i);
});

test("the list keeps the newest 20, newest first, one entry per file", () => {
  let list: ReturnType<typeof wp.downloadsAfter> = [];
  for (let i = 0; i < 25; i++) list = wp.downloadsAfter(list, { id: "w", kind: "downloaded", name: `f${i}.txt`, path: `/v/.vault-chat/downloads/f${i}.txt`, size: i, ok: true }, "/v");
  assert.equal(list.length, wp.MAX_DOWNLOADS);
  assert.equal(list[0]!.name, "f24.txt");
  list = wp.downloadsAfter(list, { id: "w", kind: "downloaded", name: "f20.txt", path: "/v/.vault-chat/downloads/f20.txt", size: 1, ok: true }, "/v");
  assert.equal(list.filter((d) => d.name === "f20.txt").length, 1);
  assert.equal(list[0]!.name, "f20.txt");
  assert.equal(wp.downloadsAfter(list, { id: "w", kind: "load", url: "https://x.com" }, "/v").length, list.length);
});
