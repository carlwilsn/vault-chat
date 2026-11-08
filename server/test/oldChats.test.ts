// Carl's existing chats, after pi.
//
// Every conversation he already has points at a pi thread — a thread id and a
// transcript no runtime on the box can resume any more. His chats kept failing
// on exactly this: signed in, Claude Code up, and the next turn still went
// looking for the engine that was gone. So the first thing a turn on an old
// conversation must do is start a fresh Claude Code session for it and hand it
// what was said, without losing the transcript Carl reads.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, type Running } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { ConvLog } from "../convlog/log";

const homes: string[] = [];
afterAll(() => {
  for (const h of homes.splice(0)) cleanup(h);
});

/** A conversation as pi left it: its transcript in pi's own sessions folder, and
 *  the feed pointing at it with pi's thread id. */
function oldChat(home: string, vault: string): { threadId: string; session: string } {
  const threadId = "01JPIOLDTHREAD0000000000";
  const sessions = join(home, "state", "pi", "sessions");
  mkdirSync(sessions, { recursive: true });
  const session = join(sessions, `2026-10-01_${threadId}.jsonl`);
  const user = { type: "message", id: "u1", parentId: null, timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "OLD-MARKER we agreed the deadline is the 9th." }] } };
  const assistant = { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-01T10:00:02.000Z", message: { role: "assistant", timestamp: 1790000000000, content: [{ type: "text", text: "OLD-REPLY noted, the 9th." }], stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } };
  writeFileSync(session, [{ type: "session", version: 3, id: threadId, timestamp: "2026-10-01T10:00:00.000Z", cwd: vault }, user, assistant].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const log = new ConvLog(vault);
  log.emit("main", { type: "meta", patch: { kind: "main", source: "main", title: "Main", createdAt: Date.now(), lastActivityAt: Date.now() } });
  log.emit("main", { type: "entry", file: session, entry: user as never });
  log.emit("main", { type: "entry", file: session, entry: assistant as never });
  log.emit("main", { type: "meta", patch: { threadId, threadPath: session, sessionFrom: { file: session, after: null } } });
  log.checkpointNow("main");
  log.close();
  return { threadId, session };
}

describe("a chat pi left behind", () => {
  it("runs its next turn on Claude Code, with what was said handed over and the old transcript still readable", async () => {
    const home = tmp("vcold-");
    homes.push(home);
    const vault = makeVault(join(home, "vault"));
    const secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary-not-real" });
    const api: FakeApi = await fakeAnthropic("The 9th it is.");
    const old = oldChat(home, vault);
    let srv: Running | undefined;
    try {
      srv = await startServer({ home, vault, secrets, anthropic: api.url });
      const get = async (p: string) => (await fetch(srv!.base + p)).json();
      const picture = async () => (await get("/api/v2/conversations/main/checkpoint")).picture;
      // What Carl has before he says anything: his old chat, as it was.
      const before = await picture();
      expect(before.meta.threadId).toBe(old.threadId);
      expect(before.items.map((x: any) => x.text)).toEqual(expect.arrayContaining(["OLD-MARKER we agreed the deadline is the 9th.", "OLD-REPLY noted, the 9th."]));

      const r = await fetch(srv.base + "/api/v2/intent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "send", convId: "main", clientId: "c-old-1", text: "Is that still right?" }) });
      expect((await r.json()).ok).toBe(true);
      const after = await waitFor(async () => {
        const p = await picture();
        return !p.meta.running && p.items.some((x: any) => x.kind === "assistant" && x.text === "The 9th it is.") ? p : null;
      }, 60_000);

      // It ran on Claude Code, on a session of its own: the thread is a new one
      // and the transcript it writes is the feed's, not pi's.
      expect(String(after.meta.threadId).startsWith("cc-")).toBe(true);
      expect(after.meta.threadId).not.toBe(old.threadId);
      expect(String(after.meta.threadPath)).toContain(join(".vault-chat", "events", "sessions"));
      // The new session was told what was already said (it cannot resume pi's).
      const sent = JSON.stringify(api.calls.at(-1));
      expect(sent).toContain("OLD-MARKER we agreed the deadline is the 9th.");
      expect(sent).toContain("Is that still right?");
      // And nothing of the old chat is lost: both are still in front of him,
      // and pi's own file is untouched.
      const texts = after.items.map((x: any) => x.text);
      expect(texts).toEqual(expect.arrayContaining(["OLD-MARKER we agreed the deadline is the 9th.", "OLD-REPLY noted, the 9th.", "Is that still right?", "The 9th it is."]));
      expect(readFileSync(old.session, "utf8")).toContain("OLD-REPLY noted, the 9th.");
    } finally {
      if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
      await srv?.stop();
      await api.close();
    }
  }, 120_000);
});
