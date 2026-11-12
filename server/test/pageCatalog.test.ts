// Stage 1.4 of the plugin refactor: the `catalog` service (src/pluginCatalog.ts, server/pluginCatalog.ts), on the real
// box. The box lists every registered service and the vault's plugins (pages with a vc-capabilities / vc-mount
// manifest) at GET /api/v2/plugin/catalog for the app and a loopback caller, and to a page granted `catalog` through
// the gateway; a page without the grant gets nothing. It is read-only: nothing else is reachable with it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, type Running } from "./helpers";

let home: string, vault: string, secrets: string;
let srv: Running;

const post = async (p: string, b: unknown) => {
  const r = await fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, json: (await r.json()) as any };
};

const put = (rel: string, html: string) => {
  mkdirSync(join(vault, rel, ".."), { recursive: true });
  writeFileSync(join(vault, rel), html);
};

/** Carl's Allow for a page, as the app gets its token. */
async function token(rel: string): Promise<string> {
  const m = await post("/api/v2/live/manifest", { path: rel });
  expect(m.status).toBe(200);
  const t = await post("/api/v2/live/token", { path: rel, hash: m.json.hash, caps: m.json.caps });
  expect(t.status).toBe(200);
  return t.json.token;
}

async function call(tok: string, method: "GET" | "POST", path: string, body?: string): Promise<{ status: number; json: any }> {
  const out = await post("/api/v2/live/fetch", { token: tok, method, path, ...(body !== undefined ? { bodyBase64: Buffer.from(body).toString("base64") } : {}) });
  if (out.status !== 200) return out;
  return { status: out.json.status, json: JSON.parse(Buffer.from(out.json.bodyBase64, "base64").toString("utf8")) };
}

beforeAll(async () => {
  home = tmp("vcpcat-");
  vault = makeVault(join(home, "vault"));
  secrets = await makeKeyStore(join(home, "secrets"), {});
  put(".vault-chat/visuals/html-lab.html", '<title>HTML lab</title><meta name="vc-capabilities" content="ask, mic, voice-lab">');
  put(".vault-chat/visuals/picture.html", "<p>an ordinary picture</p>");
  put("Apps/clock.html", '<meta name="vc-mount" content="in-process"><script type="module">export function mount(el){el.textContent="12:00"}</script>');
  put("Apps/browser.html", '<title>Plugin browser</title><meta name="vc-capabilities" content="catalog">');
  put("Apps/counter.html", '<meta name="vc-capabilities" content="state">');
  put("Apps/node_modules/x/x.html", '<meta name="vc-capabilities" content="ask">');
  srv = await startServer({ home, vault, secrets });
}, 90_000);

afterAll(async () => {
  if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
  await srv?.stop();
  cleanup(home);
});

const expected = [
  { id: ".vault-chat/visuals/html-lab.html", name: "HTML lab", mount: "iframe", needs: ["ask", "mic", "voice-lab"], refused: [] },
  { id: "Apps/browser.html", name: "Plugin browser", mount: "iframe", needs: ["catalog"], refused: [] },
  { id: "Apps/clock.html", name: "clock.html", mount: "in-process", needs: [], refused: [] },
  { id: "Apps/counter.html", name: "counter.html", mount: "iframe", needs: ["state"], refused: [] },
];

describe("the catalog", () => {
  it("the box lists every registered service and the vault's plugins (loopback, the app's way in)", async () => {
    const r = await fetch(srv.base + "/api/v2/plugin/catalog");
    expect(r.status).toBe(200);
    const c = (await r.json()) as any;
    expect(c.services.map((s: any) => s.name)).toEqual(["ask", "mic", "persist", "voice-lab", "theme", "state", "log", "converse", "catalog"]);
    expect(c.services.find((s: any) => s.name === "converse")).toMatchObject({ supplier: "box", grantable: true, always: false, call: "vc.converse" });
    expect(c.plugins).toEqual(expected);
    expect(c.truncated).toBeUndefined();
    // A page added now is in the next answer: the vault is read each time.
    put("late.html", '<meta name="vc-capabilities" content="log, fs">');
    const again = (await (await fetch(srv.base + "/api/v2/plugin/catalog")).json()) as any;
    expect(again.plugins.at(-1)).toEqual({ id: "late.html", name: "late.html", mount: "iframe", needs: ["log"], refused: ["fs"] });
    expect((await fetch(srv.base + "/api/v2/plugin/catalog", { method: "POST" })).status).not.toBe(200);
  });

  it("a page granted catalog reads the same through the gateway; a page without it gets nothing", async () => {
    const browser = await token("Apps/browser.html");
    const got = await call(browser, "GET", "/api/v2/plugin/catalog");
    expect(got.status).toBe(200);
    expect(got.json.plugins.slice(0, 4)).toEqual(expected);
    expect(got.json.services.at(-1).name).toBe("catalog");
    // Only that one read: nothing else of the box, and no write.
    expect((await call(browser, "POST", "/api/v2/plugin/catalog", "{}")).status).toBe(403);
    expect((await call(browser, "GET", "/api/v2/plugin/state")).status).toBe(403);
    expect((await call(browser, "GET", "/api/v2/conversations")).status).toBe(403);
    expect((await call(browser, "POST", "/api/v1/side", '{"text":"hi"}')).status).toBe(403);
    const counter = await token("Apps/counter.html");
    expect((await call(counter, "GET", "/api/v2/plugin/catalog")).status).toBe(403);
  });
});
