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
  threadId?: string;
  messages?: ContextMessage[];
  costUsd?: number;
  costMissingCalls?: number;
  [k: string]: unknown;
};

export type RolloverInfo = {
  at: number;
  /** The engine thread (pi session) that was retired. */
  fromThread?: string;
  recap: string;
};

/** A thread's token usage (the engine's last model call). */
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

/** A tool spec: {type:"function", name, description, inputSchema (JSON schema)}. */
export type DynamicToolSpec = {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** A tool call's reply. */
export type DynamicToolCallResponse = {
  success: boolean;
  contentItems: { type: "inputText"; text: string }[];
};

/** What a tool handler gets besides its arguments. */
export type ToolContext = {
  conv: ContextConv;
  /** Every conversation, as ENGINE holds them (ListProjects); default: read from the vault. */
  convs?: ContextConv[];
};

export type Verdict = {
  verdict: "pass" | "fail" | "unsure";
  notes: string[];
  model: string;
  at: number;
  costUsd: number | null;
};
