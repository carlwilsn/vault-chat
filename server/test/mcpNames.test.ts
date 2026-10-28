import { describe, expect, it } from "vitest";
import { hostToolName } from "../../src/mcpNames";
import { answerOf, proofImagePath, reviewCard } from "../../src/review";
import { toolName } from "../../src/convlog/view";

describe("native MCP names and explicit proof identity", () => {
  it("shortens only vault-chat's native namespace, never another server's tools", () => {
    expect(hostToolName("mcp__vault_chat__AskUser")).toBe("AskUser");
    expect(hostToolName("mcp__other__AskUser")).toBe("mcp__other__AskUser");
    expect(toolName("mcp__vault_chat__PdfRead")).toBe("PdfRead");
    expect(answerOf("mcp__vault_chat__AskUser", "Carl answered: yes")).toBe("yes");
    expect(answerOf("mcp__other__AskUser", "Carl answered: yes")).toBeNull();
  });
  it("new proof cards are independent of model call IDs; historical cards remain readable", () => {
    const args = { title: "Change", proofId: "independent-proof-123", images: ["after.png", "demo.webm"] };
    const first = reviewCard("model-call-A", args).content;
    expect(first).toBe(reviewCard("unrelated-model-call-B", args).content);
    expect(first).toContain(proofImagePath(args.proofId, 0, "after.png"));
    expect(first).toContain(proofImagePath(args.proofId, 1, "demo.webm"));
    expect(first).not.toContain("model-call");
    expect(reviewCard("historical-call", { images: ["after.png"] }).content).toContain(proofImagePath("historical-call", 0, "after.png"));
  });
});
