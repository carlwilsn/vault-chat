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
  deleteProjectFiles,
  restoreProjectFiles,
  listDeletedProjects,
  renameProject,
  makeProject,
  allProjects,
  folderName,
  projectNotesPath,
  PROJECT_NOTES_FILE,
  type Project,
  type ProjectInfo,
} from "./projects";
export { contextToolSpecs, handleContextTool, isContextTool, listProjectsText, CONTEXT_TOOL_NAMES } from "./tools";
export { turnSections, MEMORY_RULE, type TurnSection } from "./builder";
export { MEMORY_REL, memoryPath, projectFolder, loadedMemory, memoryNote, projectMemoryNote, projectMemoryLines, folderOf } from "./memory";
export { buildDeveloperInstructions, rulesPrefixForTurn, latestRollover, machineText, agentWorkArea, ROLE_PROMPT, RECHECK_RULE, WORK_RULES, PROJECTS_RULE } from "./builder";
export { projectCost, type ProjectCost } from "./cost";
