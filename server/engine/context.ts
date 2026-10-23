// The seam to Order C (CONTEXT, server/context/**): ENGINE calls CONTEXT only
// through what this file re-exports.
import type { Conversation } from "../../src/conversations";

export {
  configureContext,
  withVault,
  contextToolSpecs,
  handleContextTool,
  isContextTool,
  buildDeveloperInstructions,
  rulesPrefixForTurn,
  turnSections,
  projectFolder,
  memoryPath,
  MEMORY_REL,
  listProjects,
  type TurnSection,
  projectCost,
  ctxConfig,
  readProject,
  ensureProject,
  projectDir,
  prepareProjects,
  type ThreadTokenUsage,
} from "../context";

export type EngineConv = Conversation & { model?: string };
