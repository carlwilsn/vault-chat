import { describe, expect, it } from "vitest";
import { hostToolName } from "../../src/mcpNames";
import { answerOf, proofImagePath, reviewCard } from "../../src/review";
import { toolName } from "../../src/convlog/view";
import { activityOf } from "../engine/pi/subagents";

describe("native MCP names and explicit proof identity", () => {
  it("shortens only vault-chat's native namespace, never another server's tools", () => {
    expect(hostToolName("mcp__vault_chat__AskUser")).toBe("AskUser");
    expect(hostToolName("mcp__other__AskUser")).toBe("mcp__other__AskUser");
    expect(toolName("mcp__vault_chat__PdfRead")).toBe("PdfRead");
    expect(answerOf("mcp__vault_chat__AskUser", "Carl answered: yes")).toBe("yes");
    expect(answerOf("mcp__other__AskUser", "Carl answered: yes")).toBeNull();
  });
  it("describes a child's native host calls without leaking the transport namespace", () => {
    expect(activityOf("mcp__vault_chat__WebSearch", { query: "compact operators" })).toBe("searching the web for compact operators");
    expect(activityOf("mcp__vault_chat__PdfRead", { path: "papers/exam.pdf" })).toBe("reading exam.pdf");
    expect(activityOf("mcp__vault_chat__BoardSend", {})).toBe("sending to the whiteboard");
    expect(activityOf("mcp__vault_chat__Notify", {})).toBe("notifying Carl");
    expect(activityOf("mcp__other__WebSearch", { query: "unrelated" })).toBe("mcp__other__WebSearch");
    expect(activityOf("write", { path: "notes/result.md" })).toBe("writing result.md");
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
