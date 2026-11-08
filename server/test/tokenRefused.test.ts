// A sign-in Claude will not take.
//
// Carl pasted a token that had been captured mid-chunk. It was stored, pushed to
// the box, and every surface said "signed in" — while every turn came back
// "401 OAuth access token is invalid", in his chat, in bursts. What he asked for:
// a rejected token must never surface as a raw API error, and after a sign-in
// the box must find out whether the token actually works and say so plainly.
//
// So this drives a real turn against an endpoint that refuses it, and pins what
// Carl sees: the sentence that tells him what to do, health saying the API said
// no, and the next turn not sent at all.
import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, type Running } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { authRefused, SIGN_IN_AGAIN } from "../engine/claude/auth";

const homes: string[] = [];
afterAll(() => {
  for (const h of homes.splice(0)) cleanup(h);
});

const REFUSED = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "OAuth access token is invalid" } });

describe("a token the API refuses", () => {
  it("tells it apart from a bad moment", () => {
    // What it must catch: the API's own words for a refused credential.
    for (const s of [
      "401 OAuth access token is invalid",
      "API Error: 403 permission_error",
      '{"type":"error","error":{"type":"authentication_error","message":"x"}}',
      "invalid x-api-key",
      "Your credentials are expired. Please run `claude login`.",
    ]) {
      expect(authRefused(s), s).toBe(true);
    }
    // What it must NOT: a blip, a limit, or a model the subscription cannot run
    // — signing Carl out over one of these would take his chat away for nothing.
    for (const s of [
      "500 internal server error",
      "fetch failed",
      "socket hang up",
      "429 rate_limit_error",
      "400 opus is not a valid model ID",
      "the engine could not start this turn",
      "",
      null,
      undefined,
    ]) {
      expect(authRefused(s), String(s)).toBe(false);
    }
  });

  it("shows Carl one sentence, reports it in health, and does not send the next turn", async () => {
    const home = tmp("vctok-");
    homes.push(home);
    const vault = makeVault(join(home, "vault"));
    // A sign-in the box HAS: the point of this test is that the API refuses it,
    // not that there is none (that is the other state, and the other sentence).
    const secrets = await makeKeyStore(join(home, "secrets"), { "service.claude-code": "sk-ant-oat01-stored-but-refused" });
    const api: FakeApi = await fakeAnthropic();
    // Every turn request is refused the way the real API refuses a bad token.
    api.respond = () => ({ status: 401, body: REFUSED });
    let srv: Running | undefined;
    try {
      srv = await startServer({ home, vault, secrets, anthropic: api.url });
      const get = async (p: string) => (await fetch(srv!.base + p)).json();
      const picture = async () => (await get("/api/v2/conversations/main/checkpoint")).picture;
      const send = (text: string, clientId: string) =>
        fetch(srv!.base + "/api/v2/intent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "send", convId: "main", clientId, text }) });

      expect((await (await send("Anything.", "c-tok-1")).json()).ok).toBe(true);
      let after: any;
      try {
        after = await waitFor(async () => {
          const p = await picture();
          return !p.meta.running && p.items.some((x: any) => (x.text ?? "").includes("would not take")) ? p : null;
        }, 90_000);
      } catch (e) {
        const p = await picture();
        console.log(`TOKEN-DEBUG requests=${api.requests.length} turns=${api.calls.length} running=${JSON.stringify(p.meta.running)}`);
        console.log(`TOKEN-DEBUG items=${JSON.stringify(p.items.map((x: any) => ({ kind: x.kind, text: String(x.text ?? "").slice(0, 200) })))}`);
        console.log(`TOKEN-DEBUG log tail:\n${srv!.logs().slice(-3000)}`);
        throw e;
      }

      // The sentence, and nothing of the API's own wording.
      const said = after.items.map((x: any) => x.text ?? "").join("\n");
      expect(said).toContain(SIGN_IN_AGAIN);
      expect(said).not.toContain("authentication_failed");
      expect(said).not.toContain("401");

      // Health says the API refused it, so every client shows the sign-in state
      // again (src/claudeAuth.ts reads tokenOk).
      const h = await get("/api/v1/health");
      expect(h.engine.claude.tokenOk).toBe(false);
      // What the runtime reports for a 401 (measured): its own words, not the
      // API's body. Settings shows this in a tooltip; the chat never does.
      expect(String(h.engine.claude.tokenError)).toContain("401");
      expect(String(h.engine.claude.tokenError)).toContain("authentication_failed");

      // And the next turn is not sent at all: a token that is refused refuses
      // everything, so the chat asks him to sign in instead of asking the API.
      const calls = api.calls.length;
      expect((await (await send("And again.", "c-tok-2")).json()).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 2_500));
      expect(api.calls.length, "a refused sign-in must not be asked again").toBe(calls);
      const second = await picture();
      expect(second.meta.running ?? null).toBe(null);
      // The line is already the last thing he was told, so it is not repeated:
      // what matters is that it is still what the chat says, and that nothing
      // was sent (sayCannotRun does not stack the same notice).
      expect(second.items.at(-1)?.text ?? "", JSON.stringify(second.items.slice(-2))).toContain("Sign in with Claude");
    } finally {
      if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
      await srv?.stop();
      await api.close();
    }
  }, 150_000);
});
