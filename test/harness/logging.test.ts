// The logs' rules on the laptop and the board: nothing secret or private gets in
// (src/logRedact.ts), every app-log line carries its full date and the version
// (src/debugLog.ts), client events record what the screen did and only
// shortcuts of the keyboard (src/clientEvents.ts), the diag bundle gathers the
// window and redacts it again (src/diag.ts), and the board counts its chrome
// taps (board/src/chrome.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { redactText, safeData, safeLine } from "../../src/logRedact.ts";
import { ChromeTaps } from "../../board/src/chrome.ts";

const vault = makeTempVault("vc-logging-");
const fake = installFakeTauri(vault);

const KEY = "sk-or-v1-" + "0123456789abcdef".repeat(4);
const EL = "xi_0123456789abcdefABCDEF0123456789";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYXJsIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
const UUID = "3f2a9c1e-8b7d-4e6f-a5c4-1d2e3f4a5b6c";

test("redactText: keys, bearer tokens, token= in URLs, JWTs, data URLs and blobs go; ids and paths stay", () => {
  const s = redactText(
    `key ${KEY} el ${EL} Authorization: Bearer abcDEF123456789xyz url https://box:8848/poll?after=3&token=s3cr3tT0k3nValue&vault=school2 jwt ${JWT} img data:image/png;base64,${"iVBORw0KGgo".repeat(10)} conv ${UUID} path notes/week 3/a.md`,
  );
  for (const bad of [KEY, EL, "abcDEF123456789xyz", "s3cr3tT0k3nValue", JWT, "iVBORw0KGgoiVBORw0KGgo"]) assert.ok(!s.includes(bad), `leaked ${bad.slice(0, 12)}…: ${s}`);
  for (const good of [UUID, "notes/week 3/a.md", "after=3", "vault=school2"]) assert.ok(s.includes(good), `lost ${good}: ${s}`);
  assert.match(redactText(`{"apiKey":"abc12345678","password": "hunter22"}`), /"apiKey":"\[redacted\]","password": "\[redacted\]"/);
  assert.match(redactText("vc_token=abcdef0123456789; Path=/"), /vc_token=\[redacted\]/);
});

test("safeData: secret-named fields are dropped, content-named fields become their size, the rest is capped", () => {
  const v = safeData({
    conv: UUID,
    token: "abc",
    openrouterKey: KEY,
    headers: { authorization: "Bearer zzzzzzzzzzzz", cookie: "vc_token=1" },
    text: "what Carl typed, never in a log",
    content: [{ type: "text", text: "a file's contents" }],
    args: { path: "notes/a.md", content: "body" },
    error: `failed with ${KEY}`,
    long: "word ".repeat(200),
    n: 3,
    ok: true,
  }) as Record<string, any>;
  assert.equal(v.conv, UUID);
  assert.equal(v.token, "[redacted]");
  assert.equal(v.openrouterKey, "[redacted]");
  assert.equal(v.headers.authorization, "[redacted]");
  assert.equal(v.headers.cookie, "[redacted]");
  assert.equal(v.text, "[31 chars]");
  assert.equal(v.content, "[1 items]");
  assert.equal(v.args, "[2 fields]");
  assert.ok(!String(v.error).includes(KEY) && String(v.error).startsWith("failed with"));
  assert.ok(String(v.long).length < 340 && String(v.long).includes("…[+700]"));
  assert.equal(v.n, 3);
  assert.equal(v.ok, true);
  // A line is one JSON object, safe.
  const line = safeLine({ at: "2026-10-17T21:00:00.000Z", ev: "turn", prompt: "hello", apiKey: KEY });
  assert.deepEqual(JSON.parse(line), { at: "2026-10-17T21:00:00.000Z", ev: "turn", prompt: "[5 chars]", apiKey: "[redacted]" });
});

test("app-log lines: full ISO time and the version on every line; data redacted", async () => {
  const { vlog, flushDebugLogToDisk, formatEntry, APP_VERSION } = await import("../../src/debugLog.ts");
  assert.equal(formatEntry({ t: Date.parse("2026-10-17T21:03:11.123Z"), tag: "boot", data: { view: null }, v: "0.6.45" }), '2026-10-17T21:03:11.123Z v0.6.45 boot {"view":null}');
  // A line never breaks across lines.
  assert.equal(formatEntry({ t: 0, tag: "x", data: "a\nb", v: "1" }), "1970-01-01T00:00:00.000Z v1 x a ⏎ b");
  vlog("box.intent", { type: "send", conv: UUID, cmid: "c-1", text: "never logged", token: KEY });
  vlog("console.info", `[voice] key ${KEY}`);
  const before = fake.calls.length;
  await flushDebugLogToDisk(vault);
  const call = fake.calls.slice(before).find((c) => c.cmd === "append_debug_log");
  assert.ok(call, "flushed");
  const text = String(call!.args.text);
  assert.match(text, new RegExp(`===== flush @ \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z v${APP_VERSION} \\(`));
  const lines = text.split("\n").filter((l) => l && !l.startsWith("====="));
  assert.ok(lines.length >= 2);
  for (const l of lines) assert.match(l, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z v\S+ \S+/, l);
  const intent = lines.find((l) => l.includes("box.intent"))!;
  assert.ok(intent.includes(`"conv":"${UUID}"`) && intent.includes('"cmid":"c-1"'));
  assert.ok(!text.includes(KEY) && !text.includes("never logged"));
});

test("client events: shortcuts only (never a typed character), and what the screen changed", async () => {
  const { shortcutOf, diffSnap, cev, flushClientEvents } = await import("../../src/clientEvents.ts");
  const k = (key: string, m: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => shortcutOf({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m });
  assert.equal(k("k", { ctrlKey: true }), "Ctrl+K");
  assert.equal(k("l", { ctrlKey: true }), "Ctrl+L");
  assert.equal(k("F", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+F");
  assert.equal(k("Escape"), "Escape");
  assert.equal(k("a"), null);
  assert.equal(k("A", { shiftKey: true }), null);
  assert.equal(k("Enter"), null);
  assert.equal(k("Tab"), null);
  assert.equal(k("Control", { ctrlKey: true }), null);
  assert.equal(k("Enter", { ctrlKey: true }), "Ctrl+Enter");

  const base = { file: "a.md", mode: "view", panes: 1, paneFile: "a.md", conv: null, fullscreen: false, popout: false, left: false, right: false, chatSidebar: false, settings: false, notes: false, chats: false, voice: false, voiceConnecting: false, voiceMuted: false, voiceError: null, voiceText: false, follow: false, box: "up", vault: "school2" } as any;
  const evs = diffSnap(base, { ...base, file: "b.md", paneFile: "b.md", mode: "edit", conv: UUID, fullscreen: true, voice: true, voiceError: "mic denied", box: "down" });
  assert.deepEqual(
    evs.map((e) => [e.ev, e.data]),
    [
      ["file.open", { path: "b.md" }],
      ["mode", { mode: "edit" }],
      ["chat.open", { conv: UUID }],
      ["chat.fullscreen", { on: true }],
      ["voice", { on: true }],
      ["voice.error", { error: "mic denied" }],
      ["box", { state: "down" }],
    ],
  );
  assert.deepEqual(diffSnap(base, { ...base }), []);
  // The box going down says why; coming back says how long it was down.
  const down = { ...base, box: "down", boxReason: "Failed to connect to thinkbox", boxDownAt: 1_000 };
  assert.deepEqual(diffSnap(base, down, 1_000), [{ ev: "box", data: { state: "down", err: "Failed to connect to thinkbox" } }]);
  assert.deepEqual(diffSnap(down, { ...base, box: "up" }, 65_000), [{ ev: "box", data: { state: "up", downMs: 64_000 } }]);

  const { useStore } = await import("../../src/store.ts");
  useStore.setState({ vaultPath: vault });
  const before = fake.calls.length;
  cev("chat.popout", { on: true, text: "private" });
  cev("key", { combo: "Ctrl+K" });
  await flushClientEvents();
  const call = fake.calls.slice(before).find((c) => c.cmd === "client_event_append");
  assert.ok(call);
  const lines = String(call!.args.line).split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.match(lines[0].at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.equal(lines[0].ev, "chat.popout");
  assert.equal(lines[0].text, "[7 chars]");
  assert.equal(lines[1].combo, "Ctrl+K");
  assert.ok(typeof lines[1].v === "string");
});

test("diag bundle: the last N minutes of each log, redacted again, written under .vault-chat/diag", async () => {
  const { textLinesSince, buildDiagBundle, writeDiagBundle } = await import("../../src/diag.ts");
  const now = Date.parse("2026-10-17T21:30:00.000Z");
  const appLog = [
    "===== flush @ 2026-10-17T21:29:00.000Z v0.6.45 (3 entries) =====",
    "2026-10-17T20:00:00.000Z v0.6.45 old line",
    `2026-10-17T21:20:00.000Z v0.6.45 box.intent {"conv":"c1","cmid":"m1"} ${KEY}`,
    "21:21:00.000 an older-format line",
  ].join("\n");
  assert.deepEqual(textLinesSince(appLog, now - 15 * 60_000), ['2026-10-17T21:20:00.000Z v0.6.45 box.intent {"conv":"c1","cmid":"m1"} [redacted-key]']);
  const b = buildDiagBundle({
    now,
    minutes: 15,
    vault: "school2",
    appLog: [appLog],
    clientEvents: ['{"at":"2026-10-17T21:25:00.000Z","ev":"file.open","path":"a.md"}\n{"at":"2026-10-17T20:00:00.000Z","ev":"old"}'],
    syncLog: ['{"ts":' + (now - 1000) + ',"kind":"push","ok":true}'],
    box: { turns: [{ ev: "turn", error: `401 with key ${KEY}`, apiKey: KEY }], journal: [`Bearer ${"a".repeat(20)}`] },
  }) as any;
  assert.equal(b.laptop.appLog.length, 1);
  assert.deepEqual(b.laptop.clientEvents, [{ at: "2026-10-17T21:25:00.000Z", ev: "file.open", path: "a.md" }]);
  assert.equal(b.laptop.syncLog.length, 1);
  const all = JSON.stringify(b);
  assert.ok(!all.includes(KEY) && !all.includes("a".repeat(20)), all);

  // End to end on the fake vault (not in box mode: the box's half says so).
  const { useStore } = await import("../../src/store.ts");
  useStore.setState({ vaultPath: vault });
  fs.writeFileSync(path.join(vault, ".vault-chat", "app-log.txt"), `${new Date().toISOString()} v0.6.45 boot {}\n`);
  const p = await writeDiagBundle(15);
  assert.ok(p && p.includes("/.vault-chat/diag/diag-") && p.endsWith(".json"));
  const out = JSON.parse(fs.readFileSync(p!, "utf8"));
  assert.equal(out.kind, "vault-chat-diag");
  assert.ok(out.laptop.appLog.some((l: string) => l.includes(" boot ")));
  assert.deepEqual(out.box, { note: "not in box mode" });
});

test("board chrome taps are counted: pressed, missed (moved off), dropped (a tap's synthesized click)", () => {
  const presses: string[] = [];
  const c = new ChromeTaps<string>((b) => presses.push(b));
  c.down(1, "pen", 10, 10);
  assert.equal(c.up(1, "pen", 12, 11, 100), true);
  assert.equal(c.click(150), false); // the click iOS synthesises after it
  c.down(2, "undo", 10, 10);
  assert.equal(c.up(2, "redo", 60, 10, 300), false);
  c.down(3, null, 0, 0);
  c.up(3, null, 0, 0, 400); // not on a button: not a missed tap
  assert.deepEqual(c.takeStats(), { pressed: 1, missed: 1, dropped: 1 });
  assert.deepEqual(c.takeStats(), { pressed: 0, missed: 0, dropped: 0 });
  assert.deepEqual(presses, ["pen"]);
});
