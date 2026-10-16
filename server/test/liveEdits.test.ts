// An agent's edit reaches the laptop's open file in seconds, not at the end
// of its turn: a successful Write/Edit (engine, on a fake pi) names the file;
// a burst of them is one debounced sync cycle that commits and publishes box
// to the bare repo, and only then the clients hear /poll "vault_changed".
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, sh } from "./helpers";
import { BoxSync } from "../sync";
import { LiveEdits, writtenPath } from "../liveEdits";

const root = tmp("vcle-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

class FakeBackend extends EventEmitter {
  readonly name = "pi";
  h: any = null;
  turns: any[] = [];
  private n = 0;
  setHandlers(h: any) {
    this.h = h;
  }
  async ready() {
    return true;
  }
  health() {
    return {};
  }
  async startThread() {
    this.n += 1;
    return { threadId: `t${this.n}`, ref: undefined };
  }
  async resumeThread() {}
  async startTurn(threadId: string, o: any) {
    this.turns.push({ threadId, ...o });
    return { turnId: `pt-${this.turns.length}` };
  }
  async steer() {}
  async interrupt() {}
  usageCalls() {
    return [];
  }
  childUsageCalls() {
    return [];
  }
  async subagentControl() {
    return { ok: true };
  }
  ev(threadId: string, e: any) {
    this.emit("event", { threadId, ...e });
  }
}

const until = async (fn: () => Promise<boolean> | boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

let engine: any;
let backend: FakeBackend;
const written: string[][] = [];
/** main.ts wires the engine's onFilesWritten to LiveEdits.note; a test plugs in here. */
let onWritten: ((paths: string[]) => void) | null = null;

beforeAll(async () => {
  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  const { conversationCommands } = await import("../commands/conversations");
  const { fsCommands } = await import("../commands/fs");
  registerAll(fsCommands);
  registerAll(conversationCommands);
  const store = (await import("../../src/store")).useStore;
  store.setState({ vaultPath: vault, conversationsLoaded: true });
  const { configureContext } = await import("../context");
  configureContext({ vault, agentModel: "openai/gpt-6.1-sol", apiKey: () => null, verifierDeny: [] } as any);
  const { Engine } = await import("../engine/engine");
  backend = new FakeBackend();
  engine = new Engine({
    vault,
    backend: backend as any,
    ledger: { settle: async () => ({ calls: 0, usd: 0, missing: 0, byId: {} }), has: () => false } as any,
    jobEnv: { logDir: join(root, "jobs"), wrap: null, env: {} } as any,
    model: () => "openai/gpt-6.1-sol",
    webSearchModel: "x",
    apiKey: () => null,
    notify: async () => "sent",
    broadcast: () => {},
    log: () => {},
    onFilesWritten: (paths) => {
      written.push(paths);
      onWritten?.(paths);
    },
  });
  engine.start();
});

afterAll(() => {
  engine?.stop();
  cleanup(root);
});

describe("live edits", () => {
  it("the engine names each file a successful Write/Edit/NotebookEdit changed (not a failed one, not a read)", async () => {
    await engine.message({ text: "Fix the typo in my note." });
    await until(() => backend.turns.length === 1);
    const tid = backend.turns[0].threadId;
    const tool = (id: string, name: string, input: any, result: string) => {
      backend.ev(tid, { kind: "tool", itemId: id, name, input });
      backend.ev(tid, { kind: "tool", itemId: id, name, input: undefined, result });
    };
    tool("c1", "Read", { path: "notes/ideas.md" }, "- an idea");
    tool("c2", "Edit", { path: "notes/ideas.md", oldText: "idea", newText: "idea!" }, "Successfully replaced text in notes/ideas.md.");
    tool("c3", "Write", { path: join(vault, "notes", "new.md"), content: "x" }, "Successfully wrote 1 bytes");
    tool("c4", "Write", { path: "notes/denied.md", content: "x" }, "[error] read-only");
    tool("c5", "Write", { path: "../outside.md", content: "x" }, "Successfully wrote 1 bytes");
    tool("c6", "NotebookEdit", { path: "nb/a.ipynb" }, "replaced cell 0");
    await until(() => written.length >= 3);
    expect(written).toEqual([["notes/ideas.md"], ["notes/new.md"], ["nb/a.ipynb"]]);
  });

  it("writtenPath: vault-relative, forward slashes, null outside the vault", () => {
    expect(writtenPath(vault, { path: "a/b.md" })).toBe("a/b.md");
    expect(writtenPath(vault, { file_path: join(vault, "c", "d.md") })).toBe("c/d.md");
    expect(writtenPath(vault, { path: join(root, "elsewhere.md") })).toBeNull();
    expect(writtenPath(vault, {})).toBeNull();
  });

  it("a burst of writes is one debounced cycle: committed and pushed to the bare repo before vault_changed goes out", async () => {
    const r2 = tmp("vcle-sync-");
    const bare = join(r2, "v.git");
    sh(r2, "git", ["init", "--bare", "-q", "-b", "master", bare]);
    const box = makeVault(join(r2, "v"));
    const sync = new BoxSync(box, bare, 60_000, async () => {}, 0);
    await sync.ensure(false);
    const events: any[] = [];
    let publishedAtEvent = "";
    const live = new LiveEdits({
      delayMs: 300,
      flush: () => sync.flush(),
      broadcast: (ev) => {
        if (ev.type !== "vault_changed") return; // file_changed goes out at once (below)
        // What a laptop fetching now would get.
        publishedAtEvent = sh(bare, "git", ["show", "box:notes/ideas.md"]);
        events.push(ev);
      },
    });
    try {
      writeFileSync(join(box, "notes", "ideas.md"), "- an idea, edited by the agent\n");
      live.note("v", ["notes/ideas.md"]);
      await new Promise((r) => setTimeout(r, 100));
      writeFileSync(join(box, "notes", "b.md"), "second\n");
      live.note("v", ["notes/b.md"]);
      await new Promise((r) => setTimeout(r, 150));
      expect(events).toHaveLength(0); // still inside the debounce
      await until(() => events.length === 1, 15_000);
      expect(events[0]).toEqual({ vault: "v", type: "vault_changed", paths: ["notes/b.md", "notes/ideas.md"] });
      expect(publishedAtEvent).toBe("- an idea, edited by the agent\n");
      expect(sh(bare, "git", ["log", "-1", "--format=%s", "box"]).trim()).toMatch(/^\[agent\] box autosave: 2 file/);
      // The event carries the vault's name first, as /poll scopes events (http.ts eventVault).
      expect(JSON.stringify(events[0]).startsWith('{"vault":"v"')).toBe(true);
      await new Promise((r) => setTimeout(r, 500));
      expect(events).toHaveLength(1);
    } finally {
      live.stop();
      sync.stop();
      cleanup(r2);
    }
  });
});

describe("file_changed: the open pane hears of a write at once", () => {
  const recorder = () => {
    const events: { at: number; ev: any }[] = [];
    let flushed = 0;
    const live = new LiveEdits({ delayMs: 10_000, flush: async () => void flushed++, broadcast: (ev) => events.push({ at: Date.now(), ev }) });
    return { events, live, flushed: () => flushed };
  };

  it("a voice-route Edit emits file_changed immediately (no debounce, no commit first)", async () => {
    const { events, live, flushed } = recorder();
    try {
      writeFileSync(join(vault, "dog.svg"), '<svg><rect fill="gold"/></svg>');
      const voice = await import("../voice");
      const t0 = Date.now();
      const r = await voice.voiceTool({ vault, name: "v", main: true, shell: null, onWrite: (paths) => paths?.length && live.note("v", paths) }, {
        name: "Edit",
        args: { path: "dog.svg", old_string: "gold", new_string: "purple" },
      });
      expect(String(r.result)).toContain("edited");
      const fc = events.filter((e) => e.ev.type === "file_changed");
      expect(fc.map((e) => e.ev)).toEqual([{ vault: "v", type: "file_changed", path: "dog.svg" }]);
      expect(fc[0]!.at - t0).toBeLessThan(500);
      expect(flushed()).toBe(0); // the sync cycle is still debounced behind it
      expect(JSON.stringify(fc[0]!.ev).startsWith('{"vault":"v"')).toBe(true); // /poll scopes by it
    } finally {
      live.stop();
    }
  });

  it("an engine Write emits file_changed immediately", async () => {
    const { events, live } = recorder();
    onWritten = (paths) => live.note("v", paths);
    try {
      const at = written.length;
      await engine.message({ text: "Draw a dog." });
      await until(() => backend.turns.length >= 2);
      const tid = backend.turns.at(-1).threadId;
      backend.ev(tid, { kind: "tool", itemId: "w1", name: "Write", input: { path: "pics/dog.svg", content: "<svg/>" } });
      backend.ev(tid, { kind: "tool", itemId: "w1", name: "Write", input: undefined, result: "Successfully wrote 6 bytes" });
      await until(() => written.length > at);
      expect(events.map((e) => e.ev)).toEqual([{ vault: "v", type: "file_changed", path: "pics/dog.svg" }]);
    } finally {
      onWritten = null;
      live.stop();
    }
  });
});
