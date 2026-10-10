import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDeveloperInstructions, buildRecap, configureContext, createProject, handleContextTool, loadCatalog, rollThreshold, shouldRoll } from "../index";
import type { ContextConv, ThreadTokenUsage } from "../types";
import { inputText, startFakeModel, tempVault, type FakeModel } from "./helpers";

let cleanup: () => void;
let fake: FakeModel;

beforeEach(async () => {
  fake = await startFakeModel(
    () => ({ text: "RECAP: training run 7 is in tmux `coconut`; next, check mAP at 18:00.", cost: 0.0042 }),
    [
      { id: "openai/gpt-6.1-sol", context_length: 1_050_000 },
      { id: "deepseek/deepseek-v4.1-flash", context_length: 128_000 },
    ],
  );
  ({ cleanup } = tempVault(fake.base));
});
afterEach(async () => {
  cleanup();
  await fake.close();
});

const usage = (total: number, window: number | null = null): ThreadTokenUsage => ({
  last: { totalTokens: total, inputTokens: total - 100, outputTokens: 100 },
  modelContextWindow: window,
});

describe("shouldRoll", () => {
  it("rolls past min(window × 0.6, 300k), per model, from the catalog or the engine's window", async () => {
    await loadCatalog();
    expect(rollThreshold("openai/gpt-6.1-sol")).toBe(300_000);
    expect(rollThreshold("deepseek/deepseek-v4.1-flash")).toBe(76_800);
    expect(rollThreshold("unknown/model")).toBe(Math.floor(258_400 * 0.6));

    const sol: ContextConv = { id: "c", model: "openai/gpt-6.1-sol" };
    expect(shouldRoll(sol, usage(299_000))).toBe(false);
    expect(shouldRoll(sol, usage(301_000))).toBe(true);
    const ds: ContextConv = { id: "c", model: "deepseek/deepseek-v4.1-flash" };
    expect(shouldRoll(ds, usage(70_000))).toBe(false);
    expect(shouldRoll(ds, usage(80_000))).toBe(true);
    // The engine's reported window wins over the catalog.
    expect(shouldRoll(ds, usage(80_000, 1_000_000))).toBe(false);
    // No model on the conversation → the default agent model.
    expect(shouldRoll({ id: "c" }, usage(301_000))).toBe(true);
    expect(shouldRoll(sol, null)).toBe(false);

    configureContext({ rollFraction: 0.5, rollMaxTokens: 10_000 });
    expect(shouldRoll(sol, usage(10_001))).toBe(true);
  });
});

describe("buildRecap", () => {
  it("summarises with a cheap model, includes the project memory, and keeps the conversation id", async () => {
    createProject("Coconut");
    const conv: ContextConv = {
      id: "conv-42",
      title: "Train the coconut detector",
      project: "coconut",
      threadId: "thread-old",
      model: "openai/gpt-6.1-sol",
      messages: [
        { role: "user", content: "Train the coconut detector overnight." },
        { role: "assistant", content: "Started.", toolCalls: [{ name: "shell", input: { cmd: "tmux new -d -s coconut python train.py" }, result: "ok" }] },
      ],
    };
    const tag = { conv, setConversationProject: () => {} };
    await handleContextTool("ProjectMemory", { action: "append", section: "Decisions", text: "- YOLOv12, batch 64" }, tag);

    const r = await buildRecap(conv);
    expect(r.fallback).toBe(false);
    expect(r.costUsd).toBe(0.0042);
    expect(r.model).toBe("google/gemini-3.8-flash");
    // The cheap model saw the conversation and the project memory.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.model).toBe("google/gemini-3.8-flash");
    const seen = inputText(fake.requests[0]!);
    expect(seen).toContain("Carl: Train the coconut detector overnight.");
    expect(seen).toContain("tmux new -d -s coconut");
    expect(seen).toContain("- YOLOv12, batch 64");
    expect(fake.auth[0]).toBe("Bearer sk-test-not-a-key");
    // The recap = the summary + the project memory.
    expect(r.recap).toContain("RECAP: training run 7 is in tmux `coconut`");
    expect(r.recap).toContain("## Project memory at roll-over (Coconut)");
    expect(r.recap).toContain("- YOLOv12, batch 64");
    // The quiet marker: a system divider carrying the recap.
    expect(r.marker).toMatchObject({ role: "assistant", system: true, content: "Rolled over to a fresh session" });
    expect(r.marker.rollover).toMatchObject({ fromThread: "thread-old", recap: r.recap });

    // ENGINE appends the marker to the SAME conversation and starts a new thread with the builder's output.
    const after: ContextConv = { ...conv, messages: [...conv.messages!, r.marker], threadId: undefined };
    expect(after.id).toBe("conv-42");
    const instr = buildDeveloperInstructions(after);
    expect(instr).toContain("RECAP: training run 7");
    expect(instr).toContain("- YOLOv12, batch 64");

    // A second roll-over summarises only what came after, plus the earlier recap.
    after.messages!.push({ role: "user", content: "How is the run?" }, { role: "assistant", content: "mAP 0.71 at epoch 40." });
    await buildRecap(after);
    const seen2 = inputText(fake.requests[1]!);
    expect(seen2).toContain("## The recap from the session before");
    expect(seen2).toContain("Carl: How is the run?");
    expect(seen2).not.toContain("Carl: Train the coconut detector overnight.");
  });

  it("falls back to a verbatim excerpt when the model fails", async () => {
    fake.script = () => ({ status: 500 });
    const conv: ContextConv = { id: "c", messages: [{ role: "user", content: "remember MANGO" }, { role: "assistant", content: "ok" }] };
    const r = await buildRecap(conv);
    expect(r.fallback).toBe(true);
    expect(r.recap).toContain("Carl: remember MANGO");
    expect(r.marker.rollover?.recap).toBe(r.recap);
  });
});
