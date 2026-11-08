import { describe, expect, it } from "vitest";
import { hostToolName } from "../../src/mcpNames";
import { answerOf, ASK_TOOLS } from "../../src/review";
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
    expect(ASK_TOOLS.has("ReadyForReview")).toBe(false);
    expect(answerOf("mcp__vault_chat__ReadyForReview", "Carl answered: Keep")).toBe("Keep");
    expect(ASK_TOOLS.has("ReadyForReview")).toBe(false);
  });
});
