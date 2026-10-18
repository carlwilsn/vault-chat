// One-shot calls (POST /api/v1/complete, src/complete.ts): one user message with
// its images, on the agent's model or (fast) the recap model; the text back.
import { describe, it, expect } from "vitest";
import { configureContext } from "../context/config";
import { completeOnce } from "../context/model";

describe("completeOnce", () => {
  it("sends one user message with its images to the right model and returns the text", async () => {
    const sent: any[] = [];
    const fakeKey = "sk-or-v1-" + "x".repeat(64);
    configureContext({
      vault: "/tmp/v",
      apiKey: () => fakeKey,
      agentModel: "agent/model",
      recapModel: "fast/model",
      fetch: (async (_url: string, init: any) => {
        sent.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "r1", output: [{ type: "message", content: [{ type: "output_text", text: "the answer" }] }] }), { status: 200 });
      }) as typeof fetch,
    });
    const png = "data:image/png;base64,AAAA";
    expect(await completeOnce({ instructions: "be brief", text: "what is this?", images: [png, "file:///x.png"] })).toBe("the answer");
    expect(sent[0].model).toBe("agent/model");
    expect(sent[0].instructions).toBe("be brief");
    expect(sent[0].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "what is this?" }, { type: "input_image", image_url: png, detail: "auto" }] }]);
    await completeOnce({ instructions: "title it", text: "a note", fast: true, maxOutputTokens: 200 });
    expect(sent[1].model).toBe("fast/model");
    expect(sent[1].max_output_tokens).toBe(200);
  });

  it("a refusal from OpenRouter is an error, not an empty answer", async () => {
    configureContext({ apiKey: () => "k", fetch: (async () => new Response("bad", { status: 500 })) as typeof fetch });
    await expect(completeOnce({ instructions: "x", text: "y" })).rejects.toThrow(/OpenRouter 500/);
  });
});
