// The agent's edits turn up in the open file without a refresh:
//  - /poll "vault_changed" runs a box sync cycle at once, and the
//    merge it brings reloads the open pane in place;
//  - a pane with typing not yet on disk is never overwritten — it says
//    "Changed by the agent" instead.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-live-");
const fake = installFakeTauri(vault);
const NOTE = `${vault}/notes/a.md`;
const OTHER = `${vault}/notes/b.md`;
fs.mkdirSync(path.join(vault, "notes"), { recursive: true });
fs.writeFileSync(NOTE, "# A\n\nfirst version\n");
fs.writeFileSync(OTHER, "# B\n");

fake.setHandler("vault_box_config", () => ({ box: "http://127.0.0.1:9", vault: "v" }));
fake.setHandler("list_markdown_files", () => []);
fake.setHandler("read_binary_file", ({ path: p }) => [...fs.readFileSync(p)]);
fake.setHandler("append_sync_log", () => null);
fake.setHandler("machine_host", () => "laptop");
fake.setHandler("read_humanized", () => []);
fake.setHandler("read_deny_lines", () => []);
fake.setHandler("edit_text_file", ({ path: p, oldString, newString }) => {
  const t = fs.readFileSync(p, "utf8");
  fs.writeFileSync(p, t.replace(oldString, newString));
  return `replaced 1 occurrence(s) in ${p}`;
});

// The box: the agent's commit lands on the laptop when a cycle merges it.
// Every vault_box_sync call is recorded (pull or full, and how many overlap).
const syncCalls: { pull: boolean }[] = [];
let syncRunning = 0;
let syncMaxOverlap = 0;
const okReport = { configured: true, ok: true, message: "synced", committed: false, merged: false, conflict: null, error: null, error_kind: null, changes_waiting: 0, big_files: [], github_warning: null, github_pushed_at: null };
let boxHas: Record<string, string> | null = null;
let cycles = 0;
fake.setHandler("vault_box_sync", async ({ pull }) => {
  cycles++;
  syncCalls.push({ pull: !!pull });
  syncRunning++;
  syncMaxOverlap = Math.max(syncMaxOverlap, syncRunning);
  await new Promise((r) => setTimeout(r, 30));
  syncRunning--;
  if (!boxHas) return okReport;
  for (const [rel, text] of Object.entries(boxHas)) fs.writeFileSync(path.join(vault, rel), text);
  const merged_paths = Object.keys(boxHas);
  boxHas = null;
  return { ...okReport, merged: true, merged_paths, message: "merged box into master; pushed" };
});
// The box's working copy as GET /api/v1/vault/file serves it (live edits ahead of the sync).
const boxFiles: Record<string, string> = {};
const fileFetches: string[] = [];
// The box's /poll: the events queued by the test, then a quiet long-poll.
const queue: any[] = [];
let seq = 0;
fake.setHandler("box_get_json", async ({ url }) => {
  const u = new URL(String(url));
  const ok = (v: unknown) => ({ status: 200, body: JSON.stringify(v) });
  // The vault's log (src/convlog/protocol.ts): a vault-level signal is a record with conv null.
  if (u.pathname === "/poll") {
    for (let i = 0; i < 20 && !queue.length; i++) await new Promise((r) => setTimeout(r, 25));
    const events = queue.splice(0).map(({ vault: _v, ...signal }) => ({ seq: ++seq, conv: null, at: Date.now(), type: "signal", signal }));
    return ok({ next: seq, events, epoch: "e1" });
  }
  if (u.pathname === "/api/v2/conversations") return ok({ rows: [], seq, epoch: "e1" });
  if (u.pathname === "/api/v1/vault/file") {
    const rel = u.searchParams.get("path") ?? "";
    fileFetches.push(rel);
    if (!(rel in boxFiles)) return { status: 404, body: '{"error":"no"}' };
    return ok({ path: rel, size: boxFiles[rel]!.length, base64: Buffer.from(boxFiles[rel]!).toString("base64") });
  }
  return { status: 404, body: "{}" };
});

const { useStore } = await import("../../src/store.ts");
const vs = await import("../../src/vaultSync.ts");
const bc = await import("../../src/boxChat.ts");
const live = await import("../../src/liveReload.ts");

const S = () => useStore.getState();
async function waitFor(what: string, fn: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

after(() => {
  bc.stopBoxChat();
  vs.stopVaultSyncLoop();
});

test("box mode: vault_changed on /poll syncs at once and the open note shows the agent's edit", async () => {
  useStore.setState({ vaultPath: vault });
  S().setCurrentFile(NOTE, fs.readFileSync(NOTE, "utf8"));
  await vs.ensureVaultSyncLoop(vault);
  await waitFor("the first cycle", () => cycles === 1, 8000); // it waits for the vault on screen (≤ 4 s)
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(await bc.startBoxChat(vault));

  // The agent on the box edited the note and published it.
  boxHas = { "notes/a.md": "# A\n\nedited by the agent\n" };
  const t0 = Date.now();
  queue.push({ vault: "v", type: "vault_changed", paths: ["notes/a.md"] });
  await waitFor("the open note to update", () => S().currentContent === "# A\n\nedited by the agent\n");
  assert.equal(cycles, 2, "one cycle, right away (the interval is 15 s)");
  assert.ok(Date.now() - t0 < 2000, `in ${Date.now() - t0} ms`);
  assert.equal(S().currentFile, NOTE);
});

test("a merge while a cycle is running still comes in (one follow-up cycle)", async () => {
  boxHas = { "notes/a.md": "# A\n\nsecond agent edit\n" };
  const before = cycles;
  void vs.boxSyncNow(vault); // starts a cycle
  void vs.boxSyncNow(vault); // in flight: queued, not dropped
  await waitFor("the note", () => S().currentContent === "# A\n\nsecond agent edit\n");
  await waitFor("the follow-up", () => cycles === before + 2);
});

test("file_changed: an open SVG shows the box's edit at once — display only, the disk untouched, no box chat open", async () => {
  const SVG = `${vault}/dog.svg`;
  const gold = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="gold" width="9" height="9"/></svg>';
  const purple = gold.replace("gold", "purple");
  fs.writeFileSync(SVG, gold);
  S().setCurrentFile(SVG, "");
  useStore.setState({ activeConversationId: null });
  assert.equal(new TextDecoder().decode(await live.readShownBytes(SVG)), gold);
  const rev0 = live.fileRev(SVG);
  const cyclesBefore = cycles;

  // A voice Edit on the box: the event comes at once, the commit later.
  boxFiles["dog.svg"] = purple;
  const t0 = Date.now();
  queue.push({ vault: "v", type: "file_changed", path: "dog.svg" });
  await waitFor("the image to re-render", () => live.fileRev(SVG) > rev0);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `shown in ${ms} ms`);
  assert.equal(new TextDecoder().decode(await live.readShownBytes(SVG)), purple, "the viewer reads the box's bytes");
  assert.equal(fs.readFileSync(SVG, "utf8"), gold, "nothing written to this disk");
  assert.equal(cycles, cyclesBefore, "no sync ran for it (vault_changed does that)");

  // The merge lands the same bytes: no second redraw, and the disk is the truth again.
  const rev1 = live.fileRev(SVG);
  fs.writeFileSync(SVG, purple);
  await live.refreshOpenFiles({ vault, paths: ["dog.svg"] });
  assert.equal(live.fileRev(SVG), rev1, "same bytes: nothing flickers");
  fs.writeFileSync(SVG, gold); // a later change on disk shows (the override is gone)
  await live.refreshOpenFiles({ vault, paths: ["dog.svg"] });
  assert.equal(new TextDecoder().decode(await live.readShownBytes(SVG)), gold);
});

test("file_changed: a burst to one file is one fetch (~150 ms debounce); a file not open is never fetched", async () => {
  S().setCurrentFile(NOTE, fs.readFileSync(NOTE, "utf8"));
  const onDisk = fs.readFileSync(NOTE, "utf8");
  fileFetches.length = 0;
  boxFiles["notes/a.md"] = "# A\n\nlive from the box\n";
  queue.push(
    { vault: "v", type: "file_changed", path: "notes/a.md" },
    { vault: "v", type: "file_changed", path: "notes/a.md" },
    { vault: "v", type: "file_changed", path: "notes/closed.md" },
  );
  await waitFor("the note to show the box's text", () => S().currentContent === "# A\n\nlive from the box\n");
  assert.deepEqual(fileFetches, ["notes/a.md"]);
  assert.equal(fs.readFileSync(NOTE, "utf8"), onDisk, "the disk waits for the merge");
  // A refresh with no names (another merge) does not take the box's text back.
  await live.refreshOpenFiles({ vault });
  assert.equal(S().currentContent, "# A\n\nlive from the box\n");
});

test("file_changed over unsaved typing: the notice, and Reload takes the box's text", async () => {
  let typing = true;
  const un = live.registerDirty(NOTE, () => typing);
  S().reloadCurrent(NOTE, "# A\n\nlive from the box\nCarl types");
  boxFiles["notes/a.md"] = "# A\n\nlive from the box, again\n";
  queue.push({ vault: "v", type: "file_changed", path: "notes/a.md" });
  await waitFor("the notice", () => live.useLiveFiles.getState().diskChanged[NOTE] === true);
  assert.equal(S().currentContent, "# A\n\nlive from the box\nCarl types", "his buffer stays");
  assert.equal(live.pendingBoxText(NOTE), "# A\n\nlive from the box, again\n");
  typing = false;
  un();
});

test("git is serialized: sync-now (pull) during a running cycle, the interval and a full Sync now never overlap", async () => {
  syncCalls.length = 0;
  syncMaxOverlap = 0;
  const before = cycles;
  // vault_changed → a pull; more of them and a full "Sync now" while it runs.
  queue.push({ vault: "v", type: "vault_changed", paths: ["notes/a.md"] });
  await waitFor("the pull", () => syncCalls.length >= 1);
  void vs.boxSyncNow(vault, { pull: true });
  void vs.boxSyncNow(vault);
  void vs.boxSyncNow(vault, { pull: true });
  await waitFor("the follow-up", () => cycles >= before + 2);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(syncMaxOverlap, 1, "never two cycles at once");
  assert.equal(syncCalls[0]!.pull, true, "vault_changed asks for a pull (no pushes before the merge)");
  assert.equal(syncCalls[1]!.pull, false, "a full Sync now queued behind it stays full");
  assert.equal(syncCalls.length, 2, "kicks during a cycle are one follow-up");
});

test("unsaved typing is never overwritten: the pane says it changed instead", async () => {
  let typing = true;
  const un = live.registerDirty(NOTE, () => typing);
  S().reloadCurrent(NOTE, "# A\n\nsecond agent edit\nCarl is typing");
  fs.writeFileSync(NOTE, "# A\n\nthird agent edit\n");
  await live.refreshOpenFiles({ vault, paths: ["notes/a.md"] });
  assert.equal(S().currentContent, "# A\n\nsecond agent edit\nCarl is typing", "his buffer stays");
  assert.equal(live.useLiveFiles.getState().diskChanged[NOTE], true, "Changed by the agent — Reload");
  // Reload takes the agent's version and clears the notice.
  typing = false;
  live.applyDiskContent(NOTE, fs.readFileSync(NOTE, "utf8"));
  assert.equal(S().currentContent, "# A\n\nthird agent edit\n");
  assert.equal(live.useLiveFiles.getState().diskChanged[NOTE], undefined);
  un();
});

test("a PDF or image named as changed re-renders (its revision bumps); one not named does not", async () => {
  const pdf = `${vault}/out/report.pdf`;
  S().setCurrentFile(pdf, "");
  await live.refreshOpenFiles({ vault });
  assert.equal(live.fileRev(pdf), 0);
  await live.refreshOpenFiles({ vault, paths: ["out/report.pdf"] });
  assert.equal(live.fileRev(pdf), 1);
});
