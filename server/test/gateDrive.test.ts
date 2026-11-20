// The gate's UI runner on the real app (scripts/gate.ts judgeOnLaptop): an app plugin's draft judged in the laptop app's
// hidden Drive copy (POST /api/v2/gate/drive), and every case where that can't be relied on handed to the harness.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

type Reply = Record<string, unknown>;
let replies: ((body: any) => Reply)[] = [];
const seen: any[] = [];

describe("the gate's Drive runner", () => {
  let srv: Server;
  let box = "";
  beforeAll(async () => {
    srv = createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        const body = JSON.parse(b || "{}");
        seen.push({ path: req.url, body });
        const r = replies.shift()?.(body) ?? { unavailable: "no reply scripted" };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r));
      });
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    box = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((ok) => srv.close(() => ok())));

  const steps = (text: string, errors: string[] = [], firstOk = true) => ({ ok: firstOk, steps: [{ ok: firstOk, ...(firstOk ? {} : { error: "never appeared" }) }, { ok: true }], errors, text });
  const run = async () => (await import("../../scripts/gate.ts")).judgeOnLaptop("app/notes", "0123abcd", { vault: "/x/vaults/school2", box });

  it("judges on the real app when the laptop runs the draft: the same is a pass, a new error a fail", async () => {
    replies = [() => ({ ok: true, tries: null, steps: steps("Notes\nhi") }), (b) => ({ ok: true, tries: b.tries, steps: steps("Notes\nhi") })];
    const ok = await run();
    expect("v" in ok && ok.v.verdict).toBe("pass");
    expect(seen.at(-1)).toMatchObject({ path: "/api/v2/gate/drive?vault=school2", body: { tries: { "app/notes": "0123abcd" }, steps: [{ waitFor: '[data-vc-plugin="app/notes"][data-vc-copy="draft"]' }, { wait: 3000 }] } });
    replies = [() => ({ ok: true, tries: null, steps: steps("Notes") }), (b) => ({ ok: true, tries: b.tries, steps: steps("Notes", ["TypeError: boom"]) })];
    const bad = await run();
    expect("v" in bad && bad.v.verdict).toBe("fail");
    expect("v" in bad && bad.v.reasons.join(" ")).toMatch(/errors only with the draft: TypeError: boom/);
  });

  it("hands it to the harness when the laptop is away or busy, its app knows no tries, or the draft never mounted there", async () => {
    replies = [() => ({ unavailable: "Carl is using the laptop" })];
    expect(await run()).toEqual({ skip: "Carl is using the laptop" });
    replies = [() => ({ ok: true, tries: null, steps: steps("a") }), () => ({ ok: true, steps: steps("a") })];
    expect(await run()).toMatchObject({ skip: expect.stringMatching(/does not run a gate's tries/) });
    replies = [() => ({ ok: true, tries: null, steps: steps("a") }), (b) => ({ ok: false, tries: b.tries, steps: steps("a", [], false) })];
    expect(await run()).toMatchObject({ skip: expect.stringMatching(/never mounted on the laptop \(never appeared\)/) });
    expect(await (await import("../../scripts/gate.ts")).judgeOnLaptop(".vault-chat/plugins/pen.js", "0123abcd", { vault: "/x", box })).toMatchObject({ skip: expect.stringMatching(/only app plugins/) });
  });
});
