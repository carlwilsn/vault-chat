// The pi extension's pure helpers (server/engine/pi/ext/policy.mjs): no pi, no server.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
// @ts-ignore — plain JS module shared with the extension
import { scrubEnv, guardToolCall, resolveList, addCacheMarkers, toTypebox, costFromStreamEvent, shq } from "../engine/pi/ext/policy.mjs";

describe("pi extension policy", () => {
  let home: string;
  beforeAll(() => {
    home = tmp("vcpol-");
    mkdirSync(join(home, ".config", "vault-chat"), { recursive: true });
    writeFileSync(join(home, ".config", "vault-chat", "fallback.key"), "x");
    mkdirSync(join(home, "vault"));
    mkdirSync(join(home, "state"));
    symlinkSync(join(home, ".config", "vault-chat"), join(home, "vault", "link"), "junction");
  });
  afterAll(() => cleanup(home));

  it("scrubs keys and vault-chat's own env from the agent's shell", () => {
    const e = scrubEnv({ PATH: "/bin", OPENROUTER_API_KEY: "k", ANTHROPIC_API_KEY: "k", VC_KEY_FD: "3", GITHUB_TOKEN: "t", HOME: "/h", MY_SECRET: "s" });
    expect(Object.keys(e).sort()).toEqual(["HOME", "PATH"]);
  });

  it("guards pi's in-process tools: direct, ~, relative symlink, write-only areas", () => {
    const opts = { cwd: join(home, "vault"), home, denyRead: resolveList([join(home, ".config", "vault-chat"), "/proc"], home), denyWrite: resolveList([join(home, "state")], home) };
    expect(guardToolCall("read", { path: join(home, ".config", "vault-chat", "fallback.key") }, opts)).toMatch(/protected/);
    expect(guardToolCall("read", { path: "~/.config/vault-chat/secrets.age" }, opts)).toMatch(/protected/);
    expect(guardToolCall("read", { path: "link/fallback.key" }, opts)).toMatch(/protected/);
    expect(guardToolCall("grep", { pattern: "x", path: "link" }, opts)).toMatch(/protected/);
    expect(guardToolCall("read", { path: "/proc/self/environ" }, opts)).toMatch(/protected/);
    expect(guardToolCall("write", { path: join(home, "state", "x"), content: "" }, opts)).toMatch(/read-only/);
    expect(guardToolCall("read", { path: join(home, "state", "x") }, opts)).toBeNull();
    expect(guardToolCall("read", { path: "notes.md" }, opts)).toBeNull();
    expect(guardToolCall("bash", { command: "cat ~/.config/vault-chat/x" }, opts)).toBeNull(); // bash is sandboxed instead
  });

  it("marks Gemini requests for caching, leaves others alone", () => {
    const p = { model: "google/gemini-3.8-flash", messages: [{ role: "system", content: "sys" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: [{ type: "text", text: "c" }, { type: "image_url", image_url: { url: "x" } }] }] };
    const out = addCacheMarkers(p);
    expect(out.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(out.messages[3].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(out.messages[1].content).toBe("a");
    expect(p.messages[0].content).toBe("sys"); // not mutated
    expect(addCacheMarkers({ model: "anthropic/claude-sonnet-5.5", messages: [] })).toBeUndefined();
  });

  it("reads OpenRouter's cost from either API's stream events", () => {
    expect(costFromStreamEvent({ id: "gen-1", choices: [], usage: { cost: 0.002 } })).toEqual({ cost: 0.002, id: "gen-1" });
    expect(costFromStreamEvent({ type: "message_delta", usage: { output_tokens: 3, cost: 0.01 } })).toEqual({ cost: 0.01, id: null });
    expect(costFromStreamEvent({ choices: [{ delta: { content: "x" } }] })).toBeNull();
  });

  it("turns the JSON-schema tool specs into TypeBox", () => {
    const T: any = {
      String: (d: any) => ({ t: "s", ...d }),
      Number: (d: any) => ({ t: "n", ...d }),
      Boolean: (d: any) => ({ t: "b", ...d }),
      Array: (i: any, d: any) => ({ t: "a", i, ...d }),
      Object: (p: any, d: any) => ({ t: "o", p, ...d }),
      Optional: (x: any) => ({ ...x, opt: true }),
      Union: (xs: any[], d: any) => ({ t: "u", xs, ...d }),
      Literal: (v: any) => ({ t: "l", v }),
      Any: (d: any) => ({ t: "any", ...d }),
    };
    const s = toTypebox(T, { type: "object", properties: { q: { type: "string" }, o: { type: "array", items: { type: "string" } }, a: { enum: ["read", "update"] } }, required: ["q"] });
    expect(s.p.q).toEqual({ t: "s" });
    expect(s.p.o.opt).toBe(true);
    expect(s.p.a.t).toBe("u");
    expect(shq("it's")).toBe(["'it'", "\\", "''s'"].join(""));
  });
});
