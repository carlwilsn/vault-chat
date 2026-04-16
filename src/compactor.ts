import { generateText } from "ai";
import { buildModel, findModel, MODELS, type ProviderId } from "./providers";
import type { ChatMessage } from "./store";

const COMPACT_SYSTEM = `You compact a long agent conversation so it can continue with less context.

Preserve, in compressed form:
- The user's overall goal and any standing instructions
- File paths and decisions made about them
- Concrete facts and findings the agent or user established
- Open questions or pending tasks

Drop:
- Verbose tool outputs (file dumps, grep listings) — keep only the conclusions drawn from them
- Repeated information
- Casual chitchat

Output a tight summary, around 400-800 words, written so the agent can pick up where it left off.`;

export async function compactConversation(params: {
  provider: ProviderId;
  apiKey: string;
  messages: ChatMessage[];
}): Promise<string> {
  const { provider, apiKey, messages } = params;

  // Pick a fast/cheap model for the same provider when possible.
  const fast =
    MODELS.find((m) => m.provider === provider && /haiku|mini|flash/i.test(m.id)) ??
    MODELS.find((m) => m.provider === provider) ??
    findModel("claude-haiku-4-5-20251001");
  if (!fast) throw new Error("no compaction model available");

  const model = buildModel(fast, apiKey);

  const transcript = messages
    .filter((m) => !m.system)
    .map((m) => {
      const tools = m.toolCalls?.length
        ? `\n[tools: ${m.toolCalls.map((t) => t.name).join(", ")}]`
        : "";
      return `=== ${m.role} ===\n${m.content}${tools}`;
    })
    .join("\n\n");

  const result = await generateText({
    model,
    system: COMPACT_SYSTEM,
    prompt: `Compact this conversation:\n\n${transcript}`,
  });

  return result.text.trim();
}
