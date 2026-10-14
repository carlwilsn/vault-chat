// CONTEXT (Order C): projects, memory tools, the developer-instructions builder,
// rolling sessions, the Done verifier and cost by project. See README.md.
export { configureContext, resetContextConfig, ctxConfig, withVault, type ContextConfig } from "./config";
export type {
  ContextConv,
  ContextMessage,
  RolloverInfo,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  DynamicToolSpec,
  DynamicToolCallResponse,
  ToolContext,
  Verdict,
} from "./types";
export {
  listProjects,
  readProject,
  findProject,
  createProject,
  ensureProject,
  projectDir,
  readGlobalRules,
  type Project,
  type ProjectInfo,
} from "./projects";
export { contextToolSpecs, handleContextTool, isContextTool, CONTEXT_TOOL_NAMES } from "./tools";
export { buildDeveloperInstructions, rulesPrefixForTurn, latestRollover, machineText, agentWorkArea, ROLE_PROMPT, RECHECK_RULE } from "./builder";
export { shouldRoll, rollThreshold, buildRecap, ROLLOVER_TEXT, type Recap } from "./rollover";
export { verifyDone, verifierModelFor, formatVerdict, parseVerdict } from "./verifier";
export { projectCost, type ProjectCost } from "./cost";
export { loadCatalog, setModelWindow, modelWindow, callResponses, FALLBACK_WINDOW } from "./model";
