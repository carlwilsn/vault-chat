// Shapes shared with ENGINE (Order A). See README.md.

/** One message as stored in `.vault-chat/conversations/<id>.jsonl` (src/store.ts ChatMessage, the parts CONTEXT reads). */
export type ContextMessage = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: { id?: string; name: string; input: any; result?: string }[];
  system?: boolean;
  hidden?: boolean;
  costUsd?: number;
  /** Set on the quiet roll-over marker (see buildRecap). */
  rollover?: RolloverInfo;
  [k: string]: unknown;
};

/** What CONTEXT needs of a conversation: its meta line plus messages. Extra fields are ignored. */
export type ContextConv = {
  id: string;
  title?: string;
  project?: string;
  /** The agent's model for this conversation (default: ContextConfig.agentModel). */
  model?: string;
  codexThreadId?: string;
  messages?: ContextMessage[];
  costUsd?: number;
  costMissingCalls?: number;
  [k: string]: unknown;
};

export type RolloverInfo = {
  at: number;
  /** The Codex thread that was retired. */
  fromThread?: string;
  recap: string;
};

/** Codex `thread/tokenUsage/updated` → params.tokenUsage (ThreadTokenUsage). */
export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
};
export type ThreadTokenUsage = {
  total?: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow?: number | null;
};

/** Codex DynamicToolSpec ({type:"function"} & DynamicToolFunctionSpec). */
export type DynamicToolSpec = {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** Codex DynamicToolCallResponse — the reply to `item/tool/call`. */
export type DynamicToolCallResponse = {
  success: boolean;
  contentItems: { type: "inputText"; text: string }[];
};

/** What a tool handler gets besides its arguments. */
export type ToolContext = {
  conv: ContextConv;
  /** ENGINE persists `project` on the conversation meta (and its in-memory copy). */
  setConversationProject: (slug: string) => void | Promise<void>;
};

export type Verdict = {
  verdict: "pass" | "fail" | "unsure";
  notes: string[];
  model: string;
  at: number;
  costUsd: number | null;
};
