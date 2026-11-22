// The agent's control link to the laptop app (server/deviceLink.ts) across a vault switch. 2026-11-17: an agent in a
// chat of vault school2 drove Carl's app with Act; one step switched the app's vault to vault-chat. The app's feed then
// followed vault-chat: the next Act's signal, written to school2's log, was never carried to it (90 s "did not
// answer"), and from then on Act, Screen, Layout, PluginRead and LaptopBuild all said "offline" (presence was per
// vault) while Carl kept chatting from the same app. Control signals now ride every vault's feed and the link is
// tracked per device; when it is down the tools say since when and why.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConvLogs, convLog, globalFeed, setFeedVaults, signal } from "../convlog/log";
import { ackShow, feedOpened, resetPresence, show } from "../show";
import { _setChangeLineSink, gateOutcome, type ChangeLine } from "../changeNotices";
import { youLayer } from "../activity";
import { chatSeen, controlDown, linkState, linkStates, noteAnswer, resetLinks } from "../deviceLink";
import { screenTool } from "../screenTool";
import { layoutTool, LAYOUT_DESCRIPTION } from "../layoutTool";

const home = mkdtempSync(join(tmpdir(), "vc-ctrllink-"));
const A = join(home, "school2");
const B = join(home, "vault-chat");

type Sig = Record<string, unknown> & { type: string; id: string };

/** The laptop app following vault `on`'s feed: answers each control signal the feed carries with `answer`. */
function laptopOn(on: string, answer: (s: Sig) => Record<string, unknown> | null) {
  let cursor = globalFeed(on).latest();
  const seen: Sig[] = [];
  const leave = feedOpened(on, "laptop");
  let stop = false;
  void (async () => {
    while (!stop) {
      const got = globalFeed(on).after(cursor);
      cursor = got.next;
      for (const r of got.events) {
        const s = (r as { signal?: Sig }).signal;
        if (r.conv !== null || !s || s.to !== "laptop") continue;
        seen.push(s);
        const a = answer(s);
        if (a) ackShow(s.id, a);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  return { seen, close: () => ((stop = true), leave()) };
}

beforeAll(() => {
  for (const v of [A, B]) mkdirSync(join(v, ".vault-chat"), { recursive: true });
  _resetConvLogs();
  // Both vaults hold chats (the agent's chat is in school2).
  convLog(A).emit("agent-chat", { type: "meta", patch: { title: "agent", kind: "separate", createdAt: Date.now(), lastActivityAt: Date.now() } });
  convLog(B).emit("other", { type: "meta", patch: { title: "other", kind: "separate", createdAt: Date.now(), lastActivityAt: Date.now() } });
  setFeedVaults(A, () => [A, B]);
});
afterAll(() => {
  resetPresence();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => resetPresence());

const actAck = { ok: true, data: { steps: { ok: true, steps: [{ i: 1, action: "wait", ok: true, ms: 1 }], errors: [], text: "Chats", shots: [], ms: 1 } } };

describe("the control link follows the laptop across a vault switch", () => {
  it("Screen from a chat in school2 reaches the app after it switched to vault-chat (the 2026-11-17 wedge)", async () => {
    const app = laptopOn(B, (s) => (s.type === "capture" ? { ok: false, error: "not drawn in this test" } : null));
    try {
      const shot = await screenTool({ vault: A, emit: (ev) => signal(A, ev), ackMs: 3000 }, {});
      expect(shot.text).not.toMatch(/isn't online|did not answer/);
      expect(shot.text).toMatch(/could not draw its screen: not drawn in this test/);
      expect(app.seen.map((s) => s.type)).toEqual(["capture"]);
    } finally {
      app.close();
    }
  });

  it("each control signal reaches the app once, from its own vault's feed too; Show too (it names the vault when it is another)", () => {
    const before = globalFeed(B).latest();
    signal(A, { type: "plugin", id: "p1", to: "laptop", op: "list" });
    signal(A, { type: "show", id: "s1", to: "laptop", path: "notes.md" });
    signal(A, { type: "file_changed", path: "notes.md" });
    const carried = globalFeed(B).after(before).events.map((r) => (r as { signal?: Sig }).signal?.type);
    expect(carried).toEqual(["plugin", "show"]);
    const own = globalFeed(A).after(before).events.map((r) => (r as { signal?: Sig }).signal?.type);
    expect(own).toEqual(["plugin", "show", "file_changed"]);
  });

  it("down: the tools say since when and why, with the chat link beside it", async () => {
    const t0 = Date.now();
    resetLinks(t0 - 60_000);
    expect(controlDown("laptop", t0)).toMatch(/^The laptop isn't online: control link down since .*has not connected since the box started/);
    const r = await screenTool({ vault: A, emit: () => {}, ackMs: 200 }, {});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/isn't online: control link down since .*So its screen can't be seen/);
    const leave = feedOpened(B, "laptop");
    leave();
    chatSeen("laptop");
    const later = Date.now() + 20_000;
    const why = controlDown("laptop", later)!;
    expect(why).toMatch(/control link down since \d{4}-\d\d-\d\dT[\d:]+Z: no feed poll from the laptop app for 20 s/);
    expect(why).toContain("chat link up");
    expect(linkStates(later).laptop).toMatchObject({ control: "down", chat: "up", vault: B });
  });

  it("an app that is connected but does not answer is said so, and one answer clears it", async () => {
    const app = laptopOn(B, () => null);
    try {
      const r1 = await screenTool({ vault: A, emit: (ev) => signal(A, ev), ackMs: 150 }, {});
      const r2 = await screenTool({ vault: A, emit: (ev) => signal(A, ev), ackMs: 150 }, {});
      expect(r1.text).toMatch(/did not answer/);
      expect(r2.text).toMatch(/has not answered 2 requests in a row since/);
      expect(linkState("laptop")).toMatchObject({ control: "up", unanswered: 2, lastUnanswered: { type: "capture" } });
      noteAnswer("laptop", "capture", true);
      expect(linkState("laptop").unanswered).toBe(0);
    } finally {
      app.close();
    }
  });
});

describe("Layout openChat", () => {
  const layout = { panes: [{ pane: "left", path: "a.md" }], chat: { open: true } };
  const answer = (s: Sig) => {
    if (s.type === "plugin") {
      expect(s).toMatchObject({ op: "act", plugin: "app/chats", action: "open", args: { id: "main" } });
      return { ok: true, data: { answer: JSON.stringify({ ok: true, result: { open: "main" }, state: { selected: { id: "main", title: "Main", place: "main" } } }) } };
    }
    if (s.type === "layout") return { ok: true, landed: "chat open", data: { results: [], layout } };
    return null;
  };

  it("opens the chat through the chat list's own open and reads the layout back", async () => {
    const app = laptopOn(A, answer);
    try {
      const r = await layoutTool({ vault: A, emit: (ev) => signal(A, ev), ackMs: 3000 }, { action: "openChat", id: "main" });
      expect(r.ok).toBe(true);
      expect(r.text).toContain('- openChat: done (open now: {"id":"main","title":"Main","place":"main"})');
      expect(r.text).toContain('Open chat (read back from the chat list): {"id":"main","title":"Main","place":"main"}');
      expect(r.text).toContain(JSON.stringify(layout));
      expect(app.seen.map((s) => s.type)).toEqual(["plugin", "layout"]);
      expect(app.seen[1]!.ops).toEqual([]);
    } finally {
      app.close();
    }
  });

  it("needs an id; a refused open is a failure", async () => {
    expect((await layoutTool({ vault: A, emit: () => {} }, { action: "openChat" })).text).toMatch(/openChat needs id/);
    const app = laptopOn(A, (s) => (s.type === "plugin" ? { ok: true, data: { answer: JSON.stringify({ ok: false, error: 'no chat "nope"' }) } } : answer(s)));
    try {
      const r = await layoutTool({ vault: A, emit: (ev) => signal(A, ev), ackMs: 3000 }, { action: "openChat", id: "nope" });
      expect(r.ok).toBe(false);
      expect(r.text).toContain('- openChat: FAILED: no chat "nope"');
    } finally {
      app.close();
    }
  });

  it("a path of this chat's vault is not opened while the app has another vault open", async () => {
    const app = laptopOn(B, answer);
    try {
      const r = await layoutTool({ vault: A, emit: (ev) => signal(A, ev), ackMs: 3000 }, { action: "openInPane", pane: "left", path: "a.md" });
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/has the vault vault-chat open, and a\.md is not a file there/);
      expect(r.text).toMatch(/use Show \{path, where: "laptop", pane\}: it switches the app to this chat's vault \(school2\)/);
      expect(app.seen).toEqual([]);
    } finally {
      app.close();
    }
  });

  it("the tool descriptions point at openChat, not clicks", () => {
    expect(LAYOUT_DESCRIPTION).toMatch(/openChat \{id\}/);
  });
});

// 2026-11-20: a chat in school2 made a vault plugin while the laptop showed vault-chat. Show said "the laptop isn't
// online" (presence was the chat vault's) while Layout and LaptopBuild answered live; Layout refused every pane path;
// the gate applied the plugin in school2 and its "Done" line never said why nothing changed on screen. The vault the
// laptop has open is now one piece of state (server/deviceLink.ts laptopElsewhere) every one of them reads.
describe("the vault open on the laptop is state every tool uses", () => {
  const vaults = () => [{ name: "school2", path: A }, { name: "vault-chat", path: B }];
  beforeAll(() => {
    writeFileSync(join(A, "hw.md"), "# hw");
    writeFileSync(join(B, "notes.md"), "# notes");
  });

  it("Show of this chat's file while the app has another vault open: sent (not 'offline'), naming the chat's vault so the app switches", async () => {
    const app = laptopOn(B, (s) => (s.type === "show" ? { ok: true, vault: s.vault, landed: `opened the vault ${s.vault}; opened hw.md` } : null));
    try {
      const r = await show({ vault: A, vaults, emit: (ev) => void signal(A, ev), ackMs: { laptop: 3000, phone: 3000, board: 3000 } }, { path: "hw.md", where: "laptop" });
      expect(r.text).not.toMatch(/isn't online/);
      expect(r.ok).toBe(true);
      expect(app.seen.map((s) => [s.type, s.vault, s.path])).toEqual([["show", "school2", "hw.md"]]);
      expect(r.text).toBe("Shown on the laptop: opened the vault school2; opened hw.md.");
    } finally {
      app.close();
    }
  });

  it("Show with the app on this chat's vault sends no vault (as before)", async () => {
    const app = laptopOn(A, (s) => (s.type === "show" ? { ok: true, landed: "opened hw.md" } : null));
    try {
      const r = await show({ vault: A, vaults, emit: (ev) => void signal(A, ev), ackMs: { laptop: 3000, phone: 3000, board: 3000 } }, { path: "hw.md", where: "laptop" });
      expect(r.ok).toBe(true);
      expect(app.seen[0]!.vault).toBeUndefined();
    } finally {
      app.close();
    }
  });

  it("an app that follows this chat's vault's feed too (two feeds) has it on screen: no vault is named", async () => {
    const own = feedOpened(A, "laptop");
    const app = laptopOn(B, (s) => (s.type === "show" ? { ok: true, landed: "opened hw.md" } : null));
    try {
      const r = await show({ vault: A, vaults, emit: (ev) => void signal(A, ev), ackMs: { laptop: 3000, phone: 3000, board: 3000 } }, { path: "hw.md", where: "laptop" });
      expect(r.ok).toBe(true);
      expect(app.seen[0]!.vault).toBeUndefined();
    } finally {
      app.close();
      own();
    }
  });

  it("Layout openInPane of a file of the open vault goes through", async () => {
    const app = laptopOn(B, (s) => (s.type === "layout" ? { ok: true, landed: "opened", data: { results: [{ op: "openInPane", ok: true }], layout: { panes: [] } } } : null));
    try {
      const r = await layoutTool({ vault: A, emit: (ev) => signal(A, ev), ackMs: 3000 }, { action: "openInPane", pane: "left", path: "notes.md" });
      expect(r.ok).toBe(true);
      expect(app.seen.map((s) => s.type)).toEqual(["layout"]);
    } finally {
      app.close();
    }
  });

  it("an applied change of this vault says where it is when the laptop has another vault open; the you layer says which is open", async () => {
    const lines: ChangeLine[] = [];
    _setChangeLineSink((_v, _c, l) => void lines.push(l));
    const app = laptopOn(B, () => null);
    try {
      await gateOutcome(A, { plugin: ".vault-chat/plugins/wild-chat.js", version: "def43751", what: "A wilder look", asked: true, conv: "agent-chat", decision: "keep", reasons: [] });
      expect(lines[0]).toMatchObject({ kind: "done", offer: "undo" });
      expect(lines[0]!.text).toMatch(/^Done: A wilder look \(in the school2 vault; the laptop has vault-chat open, so it shows after he switches to school2/);
      expect(youLayer(A).text).toMatch(/Laptop vault: vault-chat is open on the laptop, not this chat's vault \(school2\)/);
      expect(youLayer(B).text).not.toMatch(/Laptop vault/);
      // The core is one per box: no note.
      await gateOutcome(A, { plugin: "app/core", version: "1", what: "core", asked: true, conv: "agent-chat", decision: "keep", reasons: [] });
      expect(lines[1]!.text).toBe("Done: core");
    } finally {
      app.close();
      _setChangeLineSink(null);
    }
  });
});
