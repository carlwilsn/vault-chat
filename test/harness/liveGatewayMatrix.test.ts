// Live pages: the gateway's whole allow/deny matrix (server/liveProxy.ts) and the manifest parser, against a snapshot
// recorded from the code before the service registry (src/liveServices.ts). Every row must come out exactly as it did:
// which token, method and path is allowed, what status it gets, what reaches the box's own routes or the voice lab, and
// which request headers get through. Regenerate only on purpose: LIVE_MATRIX_WRITE=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(HERE, "fixtures", "live-gateway-matrix.json");

type Seen = { to: string; method: string; url: string; headers: string[]; body: string };

function fake(to: string, seen: Seen[], answer: (req: IncomingMessage, body: string) => { status: number; type: string; body: string }) {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      // Only the headers a page could influence or the gateway adds on purpose (not host/connection).
      const headers = Object.keys(req.headers).filter((k) => !["host", "connection"].includes(k)).sort();
      seen.push({ to, method: req.method ?? "", url: req.url ?? "", headers, body });
      const a = answer(req, body);
      res.writeHead(a.status, { "content-type": a.type, "x-extra": "dropped" });
      res.end(a.body);
    });
  });
}

const listen = (s: ReturnType<typeof createServer>) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));

/** The manifests whose parse must not change (spellings real pages and tests use, and malformed ones). */
const MANIFESTS = [
  '<meta name="vc-capabilities" content="ask">',
  '<meta name="vc-capabilities" content="ask, mic">',
  '<meta name="vc-capabilities" content="mic, tool:voice-lab.*">',
  '<meta name="vc-capabilities" content="ask, mic, tool:voice-lab.*">',
  '<meta name="vc-capabilities" content="tool:voice-lab.tts">',
  '<meta name="vc-capabilities" content="tool:voice-lab.tts tool:voice-lab.stt,ask">',
  '<meta name="vc-capabilities" content="tool:*">',
  '<meta name="vc-capabilities" content="persist, ask">',
  '<meta name="vc-capabilities" content="ASK, Mic">',
  "<meta content='tool:voice-lab.* ask,ask' name=vc-capabilities>",
  '<meta name="vc-capabilities" content="ask, fs, tool:../x, tool:">',
  '<meta name="viewport" content="ask"><p>hi</p>',
  "<p>no manifest</p>",
  '<meta name="vc-capabilities" content="ask"><meta name="vc-capabilities" content="mic">',
  '<meta name="vc-capabilities" content="' + Array.from({ length: 30 }, (_, i) => `tool:voice-lab.op${String(i).padStart(2, "0")}`).join(",") + '">',
];

test("the gateway's allow/deny matrix and the manifest parser are unchanged", async () => {
  const seen: Seen[] = [];
  let sid = 0;
  const box = fake("box", seen, (req, body) => {
    if (req.method === "POST" && req.url?.startsWith("/api/v1/side?") || req.url === "/api/v1/side") return { status: 200, type: "application/json", body: JSON.stringify({ ok: true, id: `s${++sid}`, v: 1, echo: JSON.parse(body || "{}") }) };
    // (change 1.3) a conversation that does not exist.
    if (/^\/api\/v2\/conversations\/gone\//.test(req.url ?? "")) return { status: 404, type: "application/json", body: '{"error":"conversation not found"}' };
    if (/\/stop/.test(req.url ?? "")) return { status: 200, type: "application/json", body: '{"ok":true}' };
    return { status: 200, type: "application/json", body: JSON.stringify({ text: "reply", v: 2, done: true }) };
  });
  const lab = fake("lab", seen, (req) => (req.url === "/tts" ? { status: 200, type: "audio/wav", body: "RIFF" } : { status: 200, type: "application/json", body: "[]" }));
  const boxPort = await listen(box);
  const labPort = await listen(lab);
  const dir = mkdtempSync(join(tmpdir(), "live-matrix-"));
  const vault = join(dir, "v");
  mkdirSync(vault);
  // The loopback goes to this fake box, with a made-up app token (never the real one, never a live port).
  writeFileSync(join(dir, "token"), "test-app-token");
  // Hermetic: whatever VC_* the runner has (a ship gate sets ports, voice ports, state dirs) must not shape this config.
  for (const k of Object.keys(process.env)) if (k.startsWith("VC_")) delete process.env[k];
  process.env.VC_STATE_DIR = join(dir, "state");
  process.env.VC_VAULT = vault;
  process.env.VC_PORT = String(boxPort);
  process.env.VC_TOKEN_FILE = join(dir, "token");
  process.env.VC_VOICE_PORT = String(labPort); // never bound here; loadConfig wants one named off the live ports
  const { liveGateway, liveManifest, liveToken } = await import("../../server/liveProxy.ts");
  const { labTarget } = await import("../../server/labProxy.ts");
  const { parseLiveManifest, describeCap } = await import("../../src/liveBridge.ts");
  labTarget.port = labPort;
  const rows: string[] = [];
  try {
    for (const m of MANIFESTS) rows.push(`parse ${JSON.stringify(m.length > 200 ? m.slice(0, 60) + "…" : m)} -> ${JSON.stringify(parseLiveManifest(m))}`);
    for (const f of ["html-lab.html", "voice-chat.html"]) rows.push(`parse fixture ${f} -> ${JSON.stringify(parseLiveManifest(readFileSync(join(HERE, "fixtures", "live-pages", f), "utf8")))}`);
    for (const c of ["ask", "mic", "persist", "tool:voice-lab.*", "tool:voice-lab.tts", "tool:*"]) rows.push(`describe ${c} -> ${describeCap(c)}`);

    const tokens: Record<string, string> = {};
    const pages: Record<string, string> = {
      ask: "ask",
      ask2: "ask",
      mic: "mic",
      persist: "persist",
      askPersist: "ask, persist",
      labAll: "tool:voice-lab.*",
      labTts: "tool:voice-lab.tts",
      labStar: "tool:*",
      fixture: "ask, mic, tool:voice-lab.*",
    };
    for (const [name, caps] of Object.entries(pages)) {
      writeFileSync(join(vault, `${name}.html`), `<meta name="vc-capabilities" content="${caps}"><p>${name}</p>`);
      const m = liveManifest(vault, `${name}.html`)!;
      rows.push(`manifest ${name} -> ${JSON.stringify(m.caps)}`);
      rows.push(`token ${name} wrong hash -> ${liveToken(vault, { path: `${name}.html`, hash: "x", caps: m.caps }).status}`);
      rows.push(`token ${name} extra cap -> ${liveToken(vault, { path: `${name}.html`, hash: m.hash, caps: [...m.caps, "ask", "mic"] }).status}`);
      const t = liveToken(vault, { path: `${name}.html`, hash: m.hash, caps: m.caps });
      rows.push(`token ${name} -> ${t.status}`);
      tokens[name] = (t.body as { token: string }).token;
    }
    rows.push(`token no manifest -> ${liveToken(vault, { path: "none.html", hash: "x", caps: [] }).status}`);

    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const hdrs = { "content-type": "application/json", accept: "*/*", authorization: "Bearer x", "x-vault-token": "forged", cookie: "a=b", "x-evil": "1", "content-length": "5" };
    const call = async (label: string, token: string, method: string, path: string, body: string | null, headers: Record<string, string> = hdrs) => {
      const before = seen.length;
      const out = await liveGateway(vault, null, { token, path, method, headers, ...(body != null ? { bodyBase64: b64(body) } : {}) });
      const o = out.body as any;
      const inner = out.status === 200 ? `${o.status} ${JSON.stringify(o.headers)} ${Buffer.from(o.bodyBase64, "base64").toString("utf8").slice(0, 160)}` : JSON.stringify(o);
      const up = seen.slice(before).map((s) => `${s.to} ${s.method} ${s.url} [${s.headers.join(",")}] ${s.body.slice(0, 120)}`);
      rows.push(`${label} ${method} ${JSON.stringify(path)} -> ${out.status} ${inner} | ${up.join(" ; ") || "-"}`);
      return o;
    };
    const ask = '{"text":"hi","system":"s","persist":false,"kind":"edit","page":"forged","extra":1,"engine":"p"}';
    // Each ask-holding token starts one session first, so "own" paths exist.
    const own: Record<string, string> = {};
    for (const name of Object.keys(pages)) {
      const o = await call(`${name} start`, tokens[name]!, "POST", "/api/v1/side", ask);
      own[name] = o?.ok ? (JSON.parse(Buffer.from(o.bodyBase64, "base64").toString("utf8")).id ?? "none") : "none";
    }
    const paths = [
      "/api/v1/side", "/api/v1/side?x=1", "/api/v1/side/{own}", "/api/v1/side/{own}?after=0&wait=999999&evil=1", "/api/v1/side/{own}/stop",
      "/api/v1/side/{own}/stop?x=1", "/api/v1/side/{other}", "/api/v1/side/{other}/stop", "/api/v1/side/../intent", "/api/v1/side/a/b",
      "/api/v2/intent", "/api/v2/conversations", "/api/v1/vault/file?path=a", "/message", "/api/v2/live/fetch", "/",
      "/api/v2/lab/engines", "/api/v2/lab/tts", "/api/v2/lab/tts?fmt=mp3", "/api/v2/lab/stt?engine=x", "/api/v2/lab/stt", "/api/v2/lab/voices",
      "/api/v2/lab/health", "/api/v2/lab/TTS", "/api/v2/lab/", "/api/v2/lab/../x", "http://127.0.0.1:1/api/v2/lab/engines", "//evil/api/v1/side",
      "/api/v1/side\n", "/api/v1/side\\x",
    ];
    for (const name of Object.keys(pages)) {
      const other = Object.entries(own).find(([k, v]) => k !== name && v !== "none")?.[1] ?? "s0";
      for (const tpl of paths) {
        const p = tpl.replace("{own}", own[name] ?? "none").replace("{other}", other);
        for (const method of ["GET", "POST", "PUT"]) await call(`${name} ${tpl}`, tokens[name]!, method, p, method === "POST" ? ask : null);
      }
      await call(`${name} persist`, tokens[name]!, "POST", "/api/v1/side", '{"text":"hi","persist":true}');
      await call(`${name} blank`, tokens[name]!, "POST", "/api/v1/side", '{"text":"  "}');
      await call(`${name} bad json`, tokens[name]!, "POST", "/api/v1/side", "{");
      await call(`${name} too long`, tokens[name]!, "POST", "/api/v1/side", JSON.stringify({ text: "x".repeat(20_001) }));
      await call(`${name} get with body`, tokens[name]!, "GET", "/api/v2/lab/engines", "x");
      await call(`${name} big tts`, tokens[name]!, "POST", "/api/v2/lab/tts", "x".repeat(70 * 1024));
      await call(`${name} no headers`, tokens[name]!, "POST", "/api/v2/lab/tts", '{"engine":"p","text":"hi"}', {});
      await call(`${name} crlf header`, tokens[name]!, "POST", "/api/v2/lab/tts", '{"engine":"p","text":"hi"}', { "content-type": "a\r\nx-evil: 1" });
    }
    await call("bad token", "nope", "GET", "/api/v1/side", null);
    await call("forged token", tokens.ask!.slice(0, -2) + "xx", "POST", "/api/v1/side", ask);
    await call("bad path", tokens.ask!, "GET", 42 as unknown as string, null);
    await call("long path", tokens.ask!, "GET", "/" + "a".repeat(2000), null);
    // A page that changed: its token stops.
    writeFileSync(join(vault, "ask.html"), '<meta name="vc-capabilities" content="ask"><p>changed</p>');
    await call("changed page", tokens.ask!, "GET", `/api/v1/side/${own.ask}`, null);

    // ---- change 1.2 (state, log): rows added after the ones above, which stay exactly as they were ----
    for (const m of ['<meta name="vc-capabilities" content="state">', '<meta name="vc-capabilities" content="log, state, ask">', '<meta name="vc-capabilities" content="STATE, plugin.state, log:x">'])
      rows.push(`parse ${JSON.stringify(m)} -> ${JSON.stringify(parseLiveManifest(m))}`);
    for (const c of ["state", "log"]) rows.push(`describe ${c} -> ${describeCap(c)}`);
    const pluginPaths = [
      "/api/v2/plugin/state", "/api/v2/plugin/state?after=-1&wait=0", "/api/v2/plugin/state?after=x", "/api/v2/plugin/state/x", "/api/v2/plugin/states",
      "/api/v2/plugin/log", "/api/v2/plugin/log?x=1", "/api/v2/plugin/log/x", "/api/v2/plugin/", "/api/v2/plugin/state/../log",
    ];
    const setBody = '{"key":"count","value":1,"plugin":"forged.html"}';
    // Every page from before (ask, mic, persist, voice-lab): none of them reaches the new routes.
    for (const name of Object.keys(pages).filter((n) => n !== "ask"))
      for (const p of pluginPaths) for (const method of ["GET", "POST"]) await call(`${name} ${p}`, tokens[name]!, method, p, method === "POST" ? setBody : null);
    const newPages: Record<string, string> = { state: "state", log: "log", stateLog: "state, log", askState: "ask, state" };
    for (const [name, caps] of Object.entries(newPages)) {
      writeFileSync(join(vault, `${name}.html`), `<meta name="vc-capabilities" content="${caps}"><p>${name}</p>`);
      const m = liveManifest(vault, `${name}.html`)!;
      rows.push(`manifest ${name} -> ${JSON.stringify(m.caps)}`);
      const t = liveToken(vault, { path: `${name}.html`, hash: m.hash, caps: m.caps });
      rows.push(`token ${name} -> ${t.status}`);
      tokens[name] = (t.body as { token: string }).token;
    }
    for (const name of Object.keys(newPages)) {
      for (const p of pluginPaths) for (const method of ["GET", "POST", "PUT"]) await call(`${name} ${p}`, tokens[name]!, method, p, method === "POST" ? (p.includes("log") ? '{"did":"x"}' : setBody) : null);
      await call(`${name} side`, tokens[name]!, "POST", "/api/v1/side", ask);
      await call(`${name} lab`, tokens[name]!, "GET", "/api/v2/lab/engines", null);
      await call(`${name} bad json`, tokens[name]!, "POST", "/api/v2/plugin/state", "{");
      await call(`${name} no key`, tokens[name]!, "POST", "/api/v2/plugin/state", '{"value":1}');
      await call(`${name} remove`, tokens[name]!, "POST", "/api/v2/plugin/state", '{"key":"count","value":null}');
      await call(`${name} big value`, tokens[name]!, "POST", "/api/v2/plugin/state", JSON.stringify({ key: "k", value: "x".repeat(70 * 1024) }));
      await call(`${name} big record`, tokens[name]!, "POST", "/api/v2/plugin/log", JSON.stringify({ r: "x".repeat(70 * 1024) }));
      await call(`${name} read`, tokens[name]!, "GET", "/api/v2/plugin/state", null);
    }

    // ---- change 1.3 (converse): rows added after the ones above, which stay exactly as they were ----
    for (const m of ['<meta name="vc-capabilities" content="converse">', '<meta name="vc-capabilities" content="Converse, persist, ask">', '<meta name="vc-capabilities" content="converse:x, conversations">'])
      rows.push(`parse ${JSON.stringify(m)} -> ${JSON.stringify(parseLiveManifest(m))}`);
    rows.push(`describe converse -> ${describeCap("converse")}`);
    const conversePaths = [
      "/api/v2/intent", "/api/v2/intent?x=1", "/api/v2/conversations", "/api/v2/conversations?x=1", "/api/v2/conversations/main/events",
      "/api/v2/conversations/main/events?after=5&wait=9", "/api/v2/conversations/main/events?after=x", "/api/v2/conversations/main/checkpoint",
      "/api/v2/conversations/../events", "/api/v2/conversations/a.b/events", "/api/v2/conversations/main/events/x", "/message",
    ];
    const startBody = '{"type":"start","text":"hi from a page","convId":"main","via":"chat","context":"forged","clientId":"x"}';
    // Every page from before (ask, mic, persist, voice-lab, state, log): none of them reaches the converse routes.
    for (const name of Object.keys(tokens).filter((n) => n !== "ask"))
      for (const p of conversePaths) for (const method of ["GET", "POST"]) await call(`${name} ${p}`, tokens[name]!, method, p, method === "POST" ? startBody : null);
    const conversePages: Record<string, string> = { converse: "converse", askConverse: "ask, converse", persistConverse: "persist, converse" };
    for (const [name, caps] of Object.entries(conversePages)) {
      writeFileSync(join(vault, `${name}.html`), `<meta name="vc-capabilities" content="${caps}"><p>${name}</p>`);
      const m = liveManifest(vault, `${name}.html`)!;
      rows.push(`manifest ${name} -> ${JSON.stringify(m.caps)}`);
      const t = liveToken(vault, { path: `${name}.html`, hash: m.hash, caps: m.caps });
      rows.push(`token ${name} -> ${t.status}`);
      tokens[name] = (t.body as { token: string }).token;
    }
    // The box picks the new chat's id and the message's: masked so the rows stay comparable.
    const ids = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    const from = rows.length;
    for (const name of Object.keys(conversePages)) {
      for (const p of conversePaths) for (const method of ["GET", "POST", "PUT"]) await call(`${name} ${p}`, tokens[name]!, method, p, method === "POST" ? startBody : null);
      await call(`${name} send`, tokens[name]!, "POST", "/api/v2/intent", '{"type":"send","convId":"main","text":"more"}');
      await call(`${name} send gone`, tokens[name]!, "POST", "/api/v2/intent", '{"type":"send","convId":"gone","text":"more"}');
      await call(`${name} send no id`, tokens[name]!, "POST", "/api/v2/intent", '{"type":"send","text":"more"}');
      await call(`${name} send bad id`, tokens[name]!, "POST", "/api/v2/intent", '{"type":"send","convId":"../x","text":"more"}');
      for (const type of ["delete", "stop", "renameConversation", "deleteProject", "compact", "lines", "answer", "steer", "queue", "now"])
        await call(`${name} ${type}`, tokens[name]!, "POST", "/api/v2/intent", JSON.stringify({ type, convId: "main", text: "x", slug: "p" }));
      await call(`${name} blank`, tokens[name]!, "POST", "/api/v2/intent", '{"type":"start","text":"  "}');
      await call(`${name} bad json`, tokens[name]!, "POST", "/api/v2/intent", "{");
      await call(`${name} too long`, tokens[name]!, "POST", "/api/v2/intent", JSON.stringify({ type: "start", text: "x".repeat(20_001) }));
      // The ask stays ephemeral: persist is refused even with converse granted.
      await call(`${name} ask persist`, tokens[name]!, "POST", "/api/v1/side", '{"text":"hi","persist":true}');
      await call(`${name} state`, tokens[name]!, "GET", "/api/v2/plugin/state", null);
    }
    for (let i = from; i < rows.length; i++) rows[i] = rows[i]!.replace(ids, "<id>");

    if (process.env.LIVE_MATRIX_WRITE === "1") writeFileSync(SNAPSHOT, JSON.stringify(rows, null, 1) + "\n");
    const want = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as string[];
    assert.equal(rows.length, want.length, "same number of rows");
    for (let i = 0; i < rows.length; i++) assert.equal(rows[i], want[i], `row ${i}`);
  } finally {
    labTarget.port = 8871;
    box.close();
    lab.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
