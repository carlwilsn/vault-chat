// Another AI drives vault-chat: the real Claude Code CLI (the pinned one, as Carl
// runs it on his laptop) is configured with the exact setup line the docs give
// (server/mcp/README.md, "Claude Code on the laptop") and calls vault-chat's tools
// through the built server's normal /mcp mount. The model is the scripted stand-in
// API; Tailscale Serve is a loopback proxy that sets the identity headers as Serve
// does (and drops any a client sends). Isolated synthetic credential; not live HTTPS.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { claudeCli, cleanup, makeVault, startServer, tmp, type Running } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";

const HOST = "thinkbox.tailbb647d.ts.net";
const TOKEN = "isolated-claude-code-client-test-only";

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(claudeCli(), args, { env, cwd, timeout: 120_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as any).code ?? 1) : 0, out: `${stdout}\n${stderr}` }));
  });
}

/** Every file under a directory, for "the credential was never written down". */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...filesUnder(p));
    else if (st.isFile() && st.size < 4 << 20) out.push(p);
  }
  return out;
}

describe("Claude Code as an outside MCP client of vault-chat", () => {
  let home: string;
  let vault: string;
  let client: string;
  let srv: Running;
  let proxy: Server;
  let model: FakeApi;
  let url: string;
  let env: NodeJS.ProcessEnv;
  beforeAll(async () => {
    vi.stubEnv("VC_MCP_HOSTS", undefined);
    home = tmp();
    vault = makeVault(join(home, "notes"));
    const ts = join(home, "tailscale-status.cjs");
    writeFileSync(ts, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== 'status --json') process.exit(1);\nconsole.log(JSON.stringify({Self:{DNSName:'${HOST}.'}}));\n`, { mode: 0o700 });
    srv = await startServer({ home, vault, secrets: join(home, "no-key-store"), token: TOKEN, extra: { VC_TAILSCALE: ts, VC_VAULT_NAME: "notes" } });
    // Serve: the private Host, HTTPS, and the tailnet login it vouched for — never one the client sent.
    proxy = createServer((req, res) => {
      const forwarded: Record<string, any> = { ...req.headers, host: HOST, "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.7", "tailscale-user-login": "carwilson0929@gmail.com" };
      const upstream = request(srv.base + req.url, { method: req.method, headers: forwarded }, (answer) => {
        res.writeHead(answer.statusCode!, answer.headers);
        answer.pipe(res);
      });
      upstream.on("error", () => res.writeHead(502).end());
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/mcp?vault=notes&device=laptop&conversation=none`;
    model = await fakeAnthropic();
    // The laptop's own Claude Code: its own home and config, nothing of the box's.
    client = join(home, "laptop");
    mkdirSync(join(client, "work"), { recursive: true });
    env = {
      PATH: process.env.PATH, HOME: client, USERPROFILE: client, CLAUDE_CONFIG_DIR: join(client, ".claude"),
      ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
      DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1",
      // The credential as the docs have Carl supply it: an environment variable, never in the config.
      VAULT_CHAT_TOKEN: TOKEN,
    };
  }, 120_000);
  afterAll(async () => {
    if (proxy) await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await srv?.stop();
    await model?.close();
    if (home) cleanup(home);
    vi.unstubAllEnvs();
  });

  it("is added with the documented line, lists vault-chat's tools and calls one that changes the vault", async () => {
    // The documented setup line, verbatim but for the URL (single quotes: the
    // shell leaves ${VAULT_CHAT_TOKEN} for Claude Code to expand at connect time).
    const added = await run(["mcp", "add", "--transport", "http", "--scope", "user", "vault_chat", url, "--header", "X-Vault-Token: ${VAULT_CHAT_TOKEN}"], env, join(client, "work"));
    expect(added.code, added.out).toBe(0);
    for (const f of filesUnder(client)) expect(readFileSync(f, "utf8").includes(TOKEN), f).toBe(false);

    const listed = await run(["mcp", "list"], env, join(client, "work"));
    expect(listed.out).toMatch(/vault_chat[\s\S]*Connected/);

    // One turn, as a model drives it: Claude Code defers MCP tools behind its
    // ToolSearch, so the model loads PluginAct first, then adds the note to box:notes over MCP.
    const turn = await run(["-p", [
      "Leave Carl a note.",
      'CALL ToolSearch {"query":"select:mcp__vault_chat__PluginAct","max_results":1}',
      'CALL mcp__vault_chat__PluginAct {"plugin":"box:notes","action":"add","args":{"text":"from an outside Claude Code"}}',
    ].join("\n"), "--allowedTools", "mcp__vault_chat__PluginAct", "--output-format", "json"], env, join(client, "work"));
    expect(turn.code, turn.out).toBe(0);
    // What the CLI told the model it can reach (as deferred tool names or tool definitions).
    const offered = JSON.stringify(model.calls[0] ?? {});
    for (const name of ["Show", "Screen", "PluginRead", "PluginAct", "RecentActivity", "ListConversations"])
      expect(offered, name).toContain(`mcp__vault_chat__${name}`);
    // A tool that needs an owning vault-chat turn is not offered to an outside client.
    for (const name of ["AskUser", "StartJob", "ScheduleWake", "TodoWrite"]) expect(offered, name).not.toMatch(new RegExp(`mcp__vault_chat__${name}\\b`));
    const notes = readFileSync(join(vault, ".vault-chat", "notes.jsonl"), "utf8");
    expect(notes).toContain("from an outside Claude Code");
    expect(JSON.stringify(model.calls.at(-1)?.messages ?? [])).toMatch(/tool_result[\s\S]*(Noted|note)/i);
    expect(srv.logs()).not.toContain(TOKEN);
  }, 300_000);

  it("is refused without the credential, and the same credential works as a standard bearer token", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } } };
    const post = (headers: Record<string, string>) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });
    expect((await post({})).status).toBe(401);
    expect((await post({ "X-Vault-Token": "wrong" })).status).toBe(401);
    expect((await post({ Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post({ Authorization: `Basic ${TOKEN}` })).status).toBe(401);
    expect((await post({ Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });
});
