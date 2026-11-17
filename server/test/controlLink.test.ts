// The agent's control link to the laptop app (server/deviceLink.ts) across a vault switch. 2026-11-17: an agent in a
// chat of vault school2 drove Carl's app with Act; one step switched the app's vault to vault-chat. The app's feed then
// followed vault-chat: the next Act's signal, written to school2's log, was never carried to it (90 s "did not
// answer"), and from then on Act, Screen, Layout, PluginRead and LaptopBuild all said "offline" (presence was per
// vault) while Carl kept chatting from the same app. Control signals now ride every vault's feed and the link is
// tracked per device; when it is down the tools say since when and why.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConvLogs, convLog, globalFeed, setFeedVaults, signal } from "../convlog/log";
import { ackShow, feedOpened, resetPresence } from "../show";
import { chatSeen, controlDown, linkState, linkStates, noteAnswer, resetLinks } from "../deviceLink";
import { actTool } from "../actTool";
import { screenTool } from "../screenTool";
import { layoutTool, LAYOUT_DESCRIPTION } from "../layoutTool";
import { ACT_DESCRIPTION } from "../actTool";

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
  it("Act from a chat in school2 reaches the app after it switched to vault-chat (the 2026-11-17 wedge)", async () => {
    const app = laptopOn(B, (s) => (s.type === "act" ? actAck : s.type === "capture" ? { ok: false, error: "not drawn in this test" } : null));
    try {
      const r = await actTool({ vault: A, emit: (ev) => signal(A, ev), ackMs: 3000 }, { steps: [{ wait: 1 }], force: true });
      expect(r.text).not.toMatch(/isn't online|did not answer/);
      expect(r.ok).toBe(true);
      expect(app.seen.map((s) => s.type)).toEqual(["act"]);
      // Screen too: the same channel.
      const shot = await screenTool({ vault: A, emit: (ev) => signal(A, ev), ackMs: 3000 }, {});
      expect(shot.text).toMatch(/could not draw its screen: not drawn in this test/);
      expect(app.seen.map((s) => s.type)).toEqual(["act", "capture"]);
    } finally {
      app.close();
    }
  });

  it("each control signal reaches the app once, from its own vault's feed too; Show stays the open vault's", () => {
    const before = globalFeed(B).latest();
    signal(A, { type: "plugin", id: "p1", to: "laptop", op: "list" });
    signal(A, { type: "show", id: "s1", to: "laptop", path: "notes.md" });
    signal(A, { type: "file_changed", path: "notes.md" });
    const carried = globalFeed(B).after(before).events.map((r) => (r as { signal?: Sig }).signal?.type);
    expect(carried).toEqual(["plugin"]);
    const own = globalFeed(A).after(before).events.map((r) => (r as { signal?: Sig }).signal?.type);
    expect(own).toEqual(["plugin", "show", "file_changed"]);
  });

  it("down: the tools say since when and why, with the chat link beside it", async () => {
    const t0 = Date.now();
    resetLinks(t0 - 60_000);
    expect(controlDown("laptop", t0)).toMatch(/^The laptop isn't online: control link down since .*has not connected since the box started/);
    const r = await actTool({ vault: A, emit: () => {}, ackMs: 200 }, { steps: [{ wait: 1 }], force: true });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/isn't online: control link down since .*So nothing was done there/);
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
      const r1 = await actTool({ vault: A, emit: (ev) => signal(A, ev), ackMs: 150 }, { steps: [{ wait: 1 }], force: true });
      const r2 = await actTool({ vault: A, emit: (ev) => signal(A, ev), ackMs: 150 }, { steps: [{ wait: 1 }], force: true });
      expect(r1.text).toMatch(/did not answer/);
      expect(r2.text).toMatch(/has not answered 2 requests in a row since/);
      expect(linkState("laptop")).toMatchObject({ control: "up", unanswered: 2, lastUnanswered: { type: "act" } });
      noteAnswer("laptop", "act", true);
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
      expect(r.text).toMatch(/another vault open \(vault-chat\)/);
      expect(app.seen).toEqual([]);
    } finally {
      app.close();
    }
  });

  it("the tool descriptions point at openChat, not clicks", () => {
    expect(LAYOUT_DESCRIPTION).toMatch(/openChat \{id\}/);
    expect(ACT_DESCRIPTION).toMatch(/To switch chats use Layout \{action: "openChat", id\}/);
    expect(ACT_DESCRIPTION).toMatch(/a place's bar \(Main or a project\) only shows or hides its chats/);
  });
});
