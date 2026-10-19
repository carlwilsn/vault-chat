// CONTEXT (Order C): projects (plain groupings), the developer-instructions builder
// and cost by project. See README.md. (Long sessions: pi's own compaction.)
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
} from "./types";
export {
  listProjects,
  readProject,
  findProject,
  createProject,
  ensureProject,
  projectDir,
  projectsPath,
  prepareProjects,
  migrateLegacyProjects,
  ensureProjectsHidden,
  readGlobalRules,
  projectNotesPath,
  PROJECT_NOTES_FILE,
  type Project,
  type ProjectInfo,
} from "./projects";
export { contextToolSpecs, handleContextTool, isContextTool, listProjectsText, CONTEXT_TOOL_NAMES } from "./tools";
export { buildDeveloperInstructions, rulesPrefixForTurn, latestRollover, machineText, agentWorkArea, ROLE_PROMPT, RECHECK_RULE, WORK_RULES, PROJECTS_RULE } from "./builder";
export { projectCost, type ProjectCost } from "./cost";
