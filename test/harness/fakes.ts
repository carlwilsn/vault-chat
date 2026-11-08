// Test doubles for running the mission harness under node:
//  - installFakeTauri(): a file-backed `invoke` (the Tauri IPC the webview code
//    calls) + localStorage/window stubs, enough for agent.ts / offVaultRun.ts;
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { prepareAgentProjects } from "../../server/context/layout.ts";

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
      // A data: URL is not the network (the AI SDK reads an image part given as one through fetch).
      if (!/^data:/.test(url) && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
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
    // lib.rs prepare_agent_projects — the same moves (server/context/layout.ts), on the temp vault.
    prepare_agent_projects: ({ vault: v }) => prepareAgentProjects(v),
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
