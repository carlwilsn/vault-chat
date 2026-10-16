// The agent's edits turn up in the open file without a refresh:
//  - box mode: /poll "vault_changed" runs a box sync cycle at once, and the
//    merge it brings reloads the open pane in place;
//  - local mode: the laptop agent's Write/Edit reloads the open pane;
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
const okReport = { configured: true, ok: true, message: "synced", committed: false, merged: false, conflict: null, error: null, error_kind: null, changes_waiting: 0, big_files: [], github_warning: null, github_pushed_at: null };
let boxHas: Record<string, string> | null = null;
let cycles = 0;
fake.setHandler("vault_box_sync", async () => {
  cycles++;
  await new Promise((r) => setTimeout(r, 30));
  if (!boxHas) return okReport;
  for (const [rel, text] of Object.entries(boxHas)) fs.writeFileSync(path.join(vault, rel), text);
  const merged_paths = Object.keys(boxHas);
  boxHas = null;
  return { ...okReport, merged: true, merged_paths, message: "merged box into master; pushed" };
});
// The box's /poll: the events queued by the test, then a quiet long-poll.
const queue: any[] = [];
let seq = 0;
fake.setHandler("box_get_json", async ({ url }) => {
  const u = new URL(String(url));
  const ok = (v: unknown) => ({ status: 200, body: JSON.stringify(v) });
  if (u.pathname === "/poll") {
    if (u.searchParams.get("after") === "latest") return ok({ next: seq, events: [] });
    for (let i = 0; i < 20 && !queue.length; i++) await new Promise((r) => setTimeout(r, 25));
    const events = queue.splice(0);
    seq += events.length;
    return ok({ next: seq, events });
  }
  if (u.pathname === "/conversations") return ok({ conversations: [] });
  if (u.pathname === "/status") return ok({ runs: [] });
  return { status: 404, body: "{}" };
});

const { useStore } = await import("../../src/store.ts");
const vs = await import("../../src/vaultSync.ts");
const bc = await import("../../src/boxChat.ts");
const live = await import("../../src/liveReload.ts");
const { buildTools } = await import("../../src/tools.ts");

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
  await waitFor("the first cycle", () => cycles === 1);
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

test("local mode: the laptop agent's Write and Edit reload the open panes showing that file (only those)", async () => {
  bc.stopBoxChat();
  vs.stopVaultSyncLoop();
  S().splitWith(OTHER, "# B\n", "right");
  assert.equal(S().panes.length, 2);
  const tools = buildTools(vault) as any;
  await tools.Write.execute({ path: NOTE, contents: "# A\n\nwritten locally\n" }, { toolCallId: "w1", messages: [] });
  await waitFor("pane A", () => S().panes.some((p) => p.file === NOTE && p.content === "# A\n\nwritten locally\n"));
  await tools.Edit.execute({ path: NOTE, old_string: "written locally", new_string: "edited locally" }, { toolCallId: "e1", messages: [] });
  await waitFor("pane A after Edit", () => S().panes.some((p) => p.file === NOTE && p.content === "# A\n\nedited locally\n"));
  assert.equal(S().panes.find((p) => p.file === OTHER)?.content, "# B\n", "the other pane is untouched");
});

test("a PDF or image named as changed re-renders (its revision bumps); one not named does not", async () => {
  const pdf = `${vault}/out/report.pdf`;
  S().setCurrentFile(pdf, "");
  await live.refreshOpenFiles({ vault });
  assert.equal(live.fileRev(pdf), 0);
  await live.refreshOpenFiles({ vault, paths: ["out/report.pdf"] });
  assert.equal(live.fileRev(pdf), 1);
});
