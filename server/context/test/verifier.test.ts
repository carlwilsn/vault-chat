import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureContext, formatVerdict, verifierModelFor, verifyDone } from "../index";
import type { ContextConv } from "../types";
import { startFakeModel, tempVault, type FakeModel, type FakeReq } from "./helpers";

let vault: string;
let cleanup: () => void;
let fake: FakeModel;

/**
 * A fake verifier model that really reads: turn 1 asks for the file named in the
 * evidence; turn 2 passes only if the tool output contains what the summary claims.
 */
function readingVerifier(req: FakeReq, n: number) {
  const items = Array.isArray(req.input) ? req.input : [];
  const outputs = items.filter((i: any) => i.type === "function_call_output");
  if (!outputs.length) {
    const ev = JSON.stringify(req.input).match(/file: ([^\s"\\]+)/);
    return { calls: [{ name: "read_file", arguments: { path: ev ? ev[1] : "missing.txt" } }] };
  }
  const out = String(outputs[0].output);
  const claim = JSON.stringify(req.input).match(/contains (\w+)/)?.[1] ?? "";
  return out.includes(claim)
    ? { text: `{"verdict":"pass","notes":["result.txt contains ${claim}"]}`, cost: 0.01 }
    : { text: `Here you go:\n{"verdict":"fail","notes":["result.txt says ${out.trim().slice(0, 40)}, not ${claim}"]}`, cost: 0.01 };
}

beforeEach(async () => {
  fake = await startFakeModel(readingVerifier);
  ({ vault, cleanup } = tempVault(fake.base));
  mkdirSync(join(vault, "out"), { recursive: true });
  writeFileSync(join(vault, "out", "result.txt"), "banana\n");
});
afterEach(async () => {
  cleanup();
  await fake.close();
});

const conv: ContextConv = { id: "c", model: "openai/gpt-6.1-sol", messages: [{ role: "user", content: "Write banana to out/result.txt" }] };

describe("verifyDone", () => {
  it("uses a model from a different family than the agent's", () => {
    expect(verifierModelFor("openai/gpt-6.1-sol")).toBe("anthropic/claude-sonnet-5.5");
    expect(verifierModelFor("deepseek/deepseek-v4.1-flash")).toBe("anthropic/claude-sonnet-5.5");
    expect(verifierModelFor("anthropic/claude-sonnet-5.5")).toBe("openai/gpt-6.1-sol");
  });

  it("passes a true claim after reading the file itself", async () => {
    const v = await verifyDone({ conv, summary: "out/result.txt contains banana", evidence: ["file: out/result.txt"] });
    expect(v.verdict).toBe("pass");
    expect(v.notes).toEqual(["result.txt contains banana"]);
    expect(v.model).toBe("anthropic/claude-sonnet-5.5");
    expect(v.costUsd).toBeCloseTo(0.011, 6); // 0.001 for the tool round + 0.01
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]!.model).toBe("anthropic/claude-sonnet-5.5");
    expect(fake.requests[0]!.tools!.map((t: any) => t.name)).toEqual(["read_file", "list_dir", "grep"]);
    // The tool round-trip went back to the model with the real file contents.
    const out = (fake.requests[1]!.input as any[]).find((i) => i.type === "function_call_output");
    expect(out.output).toContain("banana");
    expect(JSON.stringify(fake.requests[0]!.input)).toContain("Write banana to out/result.txt");
    expect(formatVerdict(v)).toBe("Verifier (anthropic/claude-sonnet-5.5): pass — result.txt contains banana");
  });

  it("fails a false claim", async () => {
    const v = await verifyDone({ conv, summary: "out/result.txt contains cherry", evidence: ["file: out/result.txt"] });
    expect(v.verdict).toBe("fail");
    expect(v.notes[0]).toContain("not cherry");
    expect(formatVerdict(v)).toMatch(/: FAIL — /);
  });

  it("is unsure when the model's reply is not a verdict, or the model is down", async () => {
    fake.script = () => ({ text: "Looks fine to me!" });
    let v = await verifyDone({ conv, summary: "x", evidence: [] });
    expect(v.verdict).toBe("unsure");
    fake.script = () => ({ status: 502 });
    v = await verifyDone({ conv, summary: "x", evidence: [] });
    expect(v.verdict).toBe("unsure");
    expect(v.notes[0]).toContain("could not run");
  });

  it("answers unsure within its time limit", async () => {
    configureContext({ verifierTimeoutMs: 300 });
    fake.script = () => ({ text: '{"verdict":"pass","notes":[]}', delayMs: 3_000 });
    const t0 = Date.now();
    const v = await verifyDone({ conv, summary: "x", evidence: [] });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(v.verdict).toBe("unsure");
    expect(v.notes[0]).toContain("ran out of time");
  });

  it("cannot read the key store or .git", async () => {
    const secrets = join(vault, "fake-secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "fallback.key"), "do-not-read");
    mkdirSync(join(vault, ".git"));
    writeFileSync(join(vault, ".git", "config"), "do-not-read");
    configureContext({ verifierDeny: [secrets] });
    const paths = [join(secrets, "fallback.key"), ".git/config"];
    for (const p of paths) {
      fake.requests.length = 0;
      fake.script = (req) =>
        (req.input as any[]).some((i) => i.type === "function_call_output")
          ? { text: '{"verdict":"unsure","notes":["could not read"]}' }
          : { calls: [{ name: "read_file", arguments: { path: p } }] };
      await verifyDone({ conv, summary: "x", evidence: [] });
      const out = (fake.requests[1]!.input as any[]).find((i) => i.type === "function_call_output");
      expect(out.output).toMatch(/^error: .*off-limits/);
      expect(out.output).not.toContain("do-not-read");
    }
  });
});
