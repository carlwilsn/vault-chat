// Sync exists only with a box. Every open vault is autosaved locally for
// history (no setting); a vault without a box never pushes or pulls, whatever
// an old config.json says; a box vault runs the box cycle as before; when the
// box is unreachable because Tailscale isn't connected, the chip says so.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const plain = makeTempVault("vc-sync-plain-");
const boxed = makeTempVault("vc-sync-box-");
const offline = makeTempVault("vc-sync-ts-");
const fake = installFakeTauri(plain);

// An old vault that had the plain git-remote auto-sync switched on.
fs.writeFileSync(
  path.join(plain, ".vault-chat", "config.json"),
  JSON.stringify({ sync: { enabled: true, pullIntervalSec: 5, pushDebounceSec: 1 } }),
);

const BOX = "https://thinkbox.t.ts.net";
const boxOf: Record<string, unknown> = {
  [boxed]: { box: BOX, vault: "boxed" },
  [offline]: { box: BOX, vault: "offline" },
};
fake.setHandler("vault_box_config", ({ vault }) => boxOf[vault] ?? null);
fake.setHandler("vault_commit_local", () => ({ ok: true, message: "committed locally (0 sub-repos)", error: false }));
fake.setHandler("vault_sync_status", () => ({ has_repo: true, remote: "git@github.com:me/old.git", has_changes: false, ahead: 2, nested_repos: [] }));
fake.setHandler("list_markdown_files", () => []);
fake.setHandler("append_sync_log", () => null);
fake.setHandler("machine_host", () => "laptop");

const okReport = {
  configured: true,
  ok: true,
  message: "synced",
  committed: true,
  merged: false,
  conflict: null,
  error: null,
  error_kind: null,
  changes_waiting: 0,
  big_files: [],
  github_warning: null,
  github_pushed_at: null,
};
const unreachable = {
  ...okReport,
  ok: false,
  message: "sync failed",
  error: "git fetch box failed (exit 128):\nfatal: unable to access 'https://thinkbox.t.ts.net/git/offline.git/': Could not resolve host: thinkbox.t.ts.net",
  error_kind: "unreachable",
  changes_waiting: 2,
};
fake.setHandler("vault_box_sync", ({ vault }) => (vault === offline ? unreachable : okReport));
let tailscale = { installed: true, connected: false, state: "Stopped", canOpen: true };
fake.setHandler("tailscale_check", () => tailscale);

const { useStore } = await import("../../src/store.ts");
const vs = await import("../../src/vaultSync.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const callsFor = (vault: string) => fake.calls.filter((c) => c.args?.vault === vault).map((c) => c.cmd);
const REMOTE_CMDS = ["vault_sync_pull", "vault_sync_push", "vault_sync_commit_local", "vault_sync_set_remote", "vault_sync_gh_create_repo"];

afterEach(() => vs.stopVaultSyncLoop());

test("a vault without a box: autosaved locally, never pushed or pulled (an old enabled config is ignored)", async () => {
  assert.equal((await vs.readVaultSyncConfig(plain)).enabled, false, "old sync.enabled no longer means anything");
  useStore.setState({ vaultPath: plain });
  await vs.ensureVaultSyncLoop(plain);
  await waitFor("a local commit", () => callsFor(plain).includes("vault_commit_local"));
  await sleep(300);
  const cmds = callsFor(plain);
  assert.deepEqual(cmds.filter((c) => REMOTE_CMDS.includes(c)), [], `no remote operation: ${cmds.join(", ")}`);
  assert.ok(!cmds.includes("vault_box_sync"));
  assert.deepEqual(vs.activeSyncVaults(), [plain]);
  // Its own cadence: the next pass comes on the autosave interval, not a remote poll.
  assert.equal(vs.AUTOSAVE_INTERVAL_MS, 12_000);
  // The config file is left as it was (old fields harmless, not rewritten).
  assert.match(fs.readFileSync(path.join(plain, ".vault-chat", "config.json"), "utf8"), /"enabled":true/);
});

test("a box vault: the box cycle runs as before (it commits locally itself); no plain autosave or remote loop", async () => {
  assert.equal((await vs.readVaultSyncConfig(boxed)).enabled, true);
  useStore.setState({ vaultPath: boxed });
  let st: any = null;
  const un = vs.subscribeBoxSync((s) => (st = s));
  await vs.ensureVaultSyncLoop(boxed);
  await waitFor("a box cycle", () => st?.report?.ok === true);
  un();
  const cmds = callsFor(boxed);
  assert.ok(cmds.includes("vault_box_sync"));
  assert.deepEqual(cmds.filter((c) => c === "vault_commit_local" || REMOTE_CMDS.includes(c)), []);
  assert.equal(st.attention, null);
  assert.ok(!fake.calls.some((c) => c.cmd === "tailscale_check"), "Tailscale is asked only after a box request fails");
});

test("box unreachable and Tailscale not connected: the chip says so at once, with Open Tailscale", async () => {
  useStore.setState({ vaultPath: offline });
  let st: any = null;
  const un = vs.subscribeBoxSync((s) => (st = s));
  await vs.ensureVaultSyncLoop(offline);
  await waitFor("the tailscale chip", () => st?.attention?.kind === "tailscale");
  un();
  assert.equal(st.attention.text, "Tailscale isn't connected");
  assert.match(st.attention.detail, /2 changes waiting/);
  assert.equal(st.tailscale.canOpen, true);
  assert.equal(fake.calls.filter((c) => c.cmd === "tailscale_check").length, 1);
});

test("the attention rules: Tailscale connected (or not installed) → the ordinary unreachable chip after a minute", () => {
  const now = Date.now();
  const base = {
    vault: offline,
    box: BOX,
    running: false,
    lastCycleAt: now,
    lastOkAt: null,
    report: unreachable as any,
    failingSince: now - 5_000,
    bigSince: null,
    githubFailingSince: null,
    attention: null,
  };
  const down = { installed: true, connected: false, state: "NoService", canOpen: false };
  const a = vs.boxAttentionOf({ ...base, tailscale: down }, now)!;
  assert.equal(a.kind, "tailscale");
  assert.match(a.detail, /not running/);
  // A blip with Tailscale fine: nothing yet; after a minute, the old chip.
  assert.equal(vs.boxAttentionOf({ ...base, tailscale: null }, now), null);
  assert.equal(vs.boxAttentionOf({ ...base, tailscale: null, failingSince: now - 61_000 }, now)!.kind, "offline");
  // Not installed: never blamed.
  const none = { installed: false, connected: false, state: "NotInstalled", canOpen: false };
  assert.equal(vs.boxAttentionOf({ ...base, tailscale: none, failingSince: now - 61_000 }, now)!.kind, "offline");
  // A git error (not a network one) is never blamed on Tailscale.
  const gitErr = { ...unreachable, error_kind: "git", error: "fatal: bad object" };
  assert.equal(vs.boxAttentionOf({ ...base, report: gitErr as any, tailscale: down }, now), null);
  // A conflict still comes first.
  const conflict = { ...unreachable, conflict: { files: ["a.md"], since: now } };
  assert.equal(vs.boxAttentionOf({ ...base, report: conflict as any, tailscale: down }, now)!.kind, "conflict");
});

test("a box merge that brings in notes reloads the Notes panel (and only for notes, or unknown paths)", async () => {
  assert.equal(vs.mergedNotes([".vault-chat/notes.jsonl", "a.md"]), true);
  assert.equal(vs.mergedNotes(["a.md"]), false);
  assert.equal(vs.mergedNotes([]), true, "unknown paths: reload to be safe");
  assert.equal(vs.mergedNotes(undefined), true);

  const notesVault = makeTempVault("vc-sync-notes-");
  boxOf[notesVault] = { box: BOX, vault: "notes" };
  const voiceNote = {
    id: "n-voice-1",
    timestamp: "2026-10-18T10:00:00.000Z",
    last_updated: "2026-10-18T10:00:00.000Z",
    anchors: [],
    turns: [],
    user_draft: "written on the box by voice",
    status: "open",
  };
  let onDisk: string[] = [];
  let reads = 0;
  fake.setHandler("notes_read", () => (reads++, onDisk));
  let report: any = { ...okReport, committed: false };
  fake.setHandler("vault_box_sync", ({ vault }) => (vault === offline ? unreachable : vault === notesVault ? report : okReport));
  useStore.setState({ vaultPath: notesVault, notes: [], notesLoaded: true });
  let st: any = null;
  const un = vs.subscribeBoxSync((s) => (s?.vault === notesVault ? (st = s) : null));
  await vs.ensureVaultSyncLoop(notesVault);
  await waitFor("the first cycle", () => st?.report?.ok === true);
  assert.equal(reads, 0, "no merge, no reload");

  // The box wrote a voice note; the next cycle merges it.
  onDisk = [JSON.stringify(voiceNote)];
  report = { ...okReport, committed: false, merged: true, message: "merged box into master; pushed", merged_paths: [".vault-chat/notes.jsonl"] };
  await vs.boxSyncNow(notesVault);
  await waitFor("the notes reload", () => useStore.getState().notes.some((n: any) => n.id === "n-voice-1"));
  const after = reads;

  // A merge of other files leaves the notes alone.
  report = { ...report, merged_paths: ["Ad Hoc/plan.md"] };
  await vs.boxSyncNow(notesVault);
  await sleep(200);
  assert.equal(reads, after, "a merge without notes does not reload them");
  un();
});
