// Test doubles for running the mission harness under node:
//  - installFakeTauri(): a file-backed `invoke` (the Tauri IPC the webview code
//    calls) + localStorage/window stubs, enough for agent.ts / offVaultRun.ts;
//  - startFakeOpenRouter(): a scripted OpenAI-compatible chat-completions
//    server that streams SSE (text and tool calls) and reports `usage.cost`
//    like OpenRouter does. It records every request body.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type FakeTauri = {
  root: string;
  vault: string;
  calls: { cmd: string; args: any }[];
  unknown: string[];
  notifications: any[];
  conversations: Map<string, any>;
  schedules: any[];
  setHandler(cmd: string, fn: (args: any) => any): void;
};

export function makeTempVault(prefix = "vc-harness-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, ".vault-chat"), { recursive: true });
  return dir.replace(/\\/g, "/");
}

export function installFakeTauri(vault: string): FakeTauri {
  const g = globalThis as any;
  // Tests must never reach a real provider: only loopback fetches are allowed.
  if (!g.__vcFetchGuard) {
    const realFetch = g.fetch;
    g.__vcFetchGuard = true;
    g.fetch = (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
        return Promise.reject(new Error(`test fetch guard: refusing non-loopback request to ${url}`));
      }
      return realFetch(input, init);
    };
  }
  const ls = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => (ls.has(k) ? ls.get(k)! : null),
    setItem: (k: string, v: string) => void ls.set(k, String(v)),
    removeItem: (k: string) => void ls.delete(k),
    clear: () => ls.clear(),
    key: (i: number) => [...ls.keys()][i] ?? null,
    get length() {
      return ls.size;
    },
  };
  if (!g.window) g.window = g;
  const state: FakeTauri = {
    root: vault,
    vault,
    calls: [],
    unknown: [],
    notifications: [],
    conversations: new Map(),
    schedules: [],
    setHandler(cmd, fn) {
      handlers[cmd] = fn;
    },
  };
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(vault, p));
  const handlers: Record<string, (a: any) => any> = {
    read_text_file: ({ path: p }) => {
      const f = abs(p);
      if (!fs.existsSync(f)) throw `No such file: ${p}`;
      return fs.readFileSync(f, "utf8");
    },
    write_text_file: ({ path: p, contents }) => {
      const f = abs(p);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, contents);
      return null;
    },
    list_dir: () => [],
    glob_files: () => [],
    grep_files: () => [],
    conversations_read: () => [...state.conversations.values()].map((c) => JSON.stringify(c)),
    conversations_write_all: ({ lines }) => {
      for (const l of lines as string[]) {
        const c = JSON.parse(l);
        state.conversations.set(c.id, c);
      }
      return null;
    },
    schedules_read: () => state.schedules.map((x) => JSON.stringify(x)),
    schedules_write_all: () => null,
    notification_add: ({ json }) => {
      state.notifications.push(JSON.parse(json));
      return null;
    },
    notifications_read: () => state.notifications.map((n) => JSON.stringify(n)),
    append_debug_log: () => null,
    client_event_append: () => null,
    phone_broadcast: () => null,
    push_post: () => null,
    phone_push_subs: () => [],
    keychain_get: () => null,
    bash_shell_kind: () => ({ kind: "bash", path: null }),
    "plugin:event|listen": () => 1,
    "plugin:event|emit": () => null,
    "plugin:event|unlisten": () => null,
  };
  g.__TAURI_INTERNALS__ = {
    transformCallback: () => Math.floor(Math.random() * 1e9),
    invoke: async (cmd: string, args: any) => {
      state.calls.push({ cmd, args });
      const h = handlers[cmd];
      if (!h) {
        state.unknown.push(cmd);
        throw `fake tauri: unhandled command ${cmd}`;
      }
      return h(args ?? {});
    },
  };
  return state;
}

// ---------------------------------------------------------------------------

export type ScriptedReply = {
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
  cost?: number | null; // null → no usage.cost in the response
  promptTokens?: number;
  completionTokens?: number;
  status?: number; // non-200 → error response
  errorBody?: unknown;
};

export type FakeOpenRouter = {
  url: string;
  requests: any[];
  close(): Promise<void>;
};

export async function startFakeOpenRouter(
  script: ScriptedReply[] | ((body: any, n: number) => ScriptedReply),
): Promise<FakeOpenRouter> {
  const requests: any[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* */
      }
      requests.push(body);
      const i = n++;
      const r: ScriptedReply =
        typeof script === "function" ? script(body, i) : script[Math.min(i, script.length - 1)] ?? { text: "(end of script)" };
      if (r.status && r.status !== 200) {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.errorBody ?? { error: { message: `scripted ${r.status}` } }));
        return;
      }
      const id = `gen-fake-${i + 1}`;
      const model = body.model ?? "fake/model";
      const usage: any = {
        prompt_tokens: r.promptTokens ?? 100,
        completion_tokens: r.completionTokens ?? 20,
        total_tokens: (r.promptTokens ?? 100) + (r.completionTokens ?? 20),
      };
      if (r.cost !== null) usage.cost = r.cost ?? 0.001;
      const finish = r.toolCalls?.length ? "tool_calls" : "stop";
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: r.text ?? "",
                  ...(r.toolCalls?.length
                    ? {
                        tool_calls: r.toolCalls.map((t, k) => ({
                          id: `call_${i}_${k}`,
                          type: "function",
                          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
                        })),
                      }
                    : {}),
                },
                finish_reason: finish,
              },
            ],
            usage,
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
      res.write(": OPENROUTER PROCESSING\n\n");
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
      if (r.text) {
        for (const piece of r.text.match(/.{1,12}/gs) ?? []) {
          send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
        }
      }
      (r.toolCalls ?? []).forEach((t, k) => {
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: k, id: `call_${i}_${k}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
      send({ ...base, choices: [], usage });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
