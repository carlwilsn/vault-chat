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
  shouldRoll,
  rollThreshold,
  buildRecap,
  verifyDone,
  formatVerdict,
  projectCost,
  ctxConfig,
  setModelWindow,
  readProject,
  ensureProject,
  projectDir,
  prepareProjects,
  type Verdict,
  type ThreadTokenUsage,
} from "../context";

export type EngineConv = Conversation & { model?: string };
