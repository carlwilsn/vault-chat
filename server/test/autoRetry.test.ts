// A failed reply picks up where it left off by itself (Carl, 2026-11-08: "Do I
// need to tell you to pick up where you left off").
//
// End to end: the real server and the real Claude Code CLI against the scripted
// API. The API is overloaded (529) for the turn, so the turn fails after the
// runtime's own retries; the engine keeps one retry wake in wakes.json and says
// it will try again. The server is then handed over (stopped, a new one started
// on the same vault, as a box update does); when the retry comes due the new
// server runs it and the reply arrives, with no click and no message from Carl.
import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, type Running } from "./helpers";
import { fakeAnthropic, chatText, type FakeApi } from "./claudeFakeApi";

const homes: string[] = [];
afterAll(() => {
  for (const h of homes.splice(0)) cleanup(h);
});

const OVERLOADED = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });

describe("a failed reply", () => {
  it("is tried again by itself, after a hand-over of the server too, and the reply arrives", async () => {
    const home = tmp("vcretry-");
    homes.push(home);
    const vault = makeVault(join(home, "vault"));
    const secrets = await makeKeyStore(join(home, "secrets"), {});
    const api: FakeApi = await fakeAnthropic();
    api.respond = () => ({ status: 529, body: OVERLOADED });
    const wakesFile = join(vault, ".vault-chat", "local", "wakes.json");
    const wakes = (): any[] => (existsSync(wakesFile) ? JSON.parse(readFileSync(wakesFile, "utf8")) : []);
    // The runtime's own retries off: the turn fails on the first 529, as it would after its ten.
    const extra = { CLAUDE_CODE_MAX_RETRIES: "0" };
    let srv: Running | undefined = await startServer({ home, vault, secrets, anthropic: api.url, extra });
    try {
      const picture = async () => (await (await fetch(srv!.base + "/api/v2/conversations/main/checkpoint")).json()).picture;
      const send = (text: string, clientId: string) =>
        fetch(srv!.base + "/api/v2/intent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "send", convId: "main", clientId, text }) });

      expect((await (await send("Write the summary.", "c-retry-1")).json()).ok).toBe(true);
      let p: any;
      try {
        p = await waitFor(async () => {
          const x = await picture();
          return !x.meta.running && x.items.some((i: any) => /try again by itself in 1 min/.test(i.text ?? "")) ? x : null;
        }, 120_000);
      } catch (e) {
        const x = await picture();
        console.log(`RETRY-DEBUG calls=${api.calls.length} items=${JSON.stringify(x.items.map((i: any) => ({ kind: i.kind, text: String(i.text ?? "").slice(0, 200) })))}`);
        console.log(srv.logs().slice(-4000));
        throw e;
      }
      // One retry wake, about a minute on, durable in wakes.json; the chat says so (the line is last, so no Try again
      // is offered for a retry already on its way) and the conversation sleeps until then.
      const [w] = wakes().filter((x) => x.conv === "main");
      expect(w.retry).toEqual({ tries: 1 });
      expect(w.at - Date.now()).toBeGreaterThan(20_000);
      expect(w.at - Date.now()).toBeLessThanOrEqual(61_000);
      expect(p.meta.state).toBe("sleeping");
      expect(p.items.at(-1).text).toMatch(/try again by itself/);

      // Hand-over: this server goes, a new one comes up on the same vault while the API has recovered.
      await srv.stop();
      api.respond = null;
      api.reply = "RECOVERED-REPLY";
      srv = await startServer({ home, vault, secrets, anthropic: api.url, extra });
      expect(wakes().filter((x) => x.conv === "main" && x.retry)).toHaveLength(1);
      const calls = api.calls.length;
      // The minute has passed.
      writeFileSync(wakesFile, JSON.stringify(wakes().map((x) => (x.retry ? { ...x, at: Date.now() - 1 } : x))));
      p = await waitFor(async () => {
        const x = await picture();
        return !x.meta.running && x.items.some((i: any) => i.kind === "assistant" && /RECOVERED-REPLY/.test(i.text ?? "")) ? x : null;
      }, 120_000);
      // Carl did nothing: the retry is the host's line, the model was told why, and nothing is left waiting.
      expect(api.calls.length).toBeGreaterThan(calls);
      expect(chatText(api.calls.at(-1))).toMatch(/host is trying again by itself/);
      expect(p.items.some((i: any) => i.kind === "user" && /Trying again by itself/.test(i.text ?? ""))).toBe(true);
      expect(p.items.filter((i: any) => i.kind === "user" && i.via === "chat").map((i: any) => i.text)).toEqual(["Write the summary."]);
      expect(wakes().filter((x) => x.conv === "main")).toHaveLength(0);
      expect(p.meta.state).toBe("idle");
    } finally {
      if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
      await srv?.stop();
      await api.close();
    }
  }, 300_000);
});
