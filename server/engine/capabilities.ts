// What the engine's model can do.
//
// There is one engine and it is Claude Code, so there is one answer: its models
// take tools, run subagents, see images and read PDFs. This used to be a
// question — pi ran whatever OpenRouter offered, and a model that could not see
// had to be found out from the catalog or from a rejected request, or a turn
// carrying a picture went to the wrong model. Claude Code resolves its own
// models and every one of them can do the work, so the catalog, the learned
// entries and the per-model note are gone with the engine that needed them.
import { isClaudeModel } from "./claude/models";

export type Capabilities = { tools: boolean; subagents: boolean; images: boolean; pdf: boolean; caching: boolean; context: number };

/** Kept for the one caller that still names a file (server/engine/index.ts): nothing is stored now. */
export function initCapabilities(_statePath: string, _runtimeVersion: string): void {
  /* nothing is learned any more */
}

/**
 * `context: 0` means "not stated": the model's window comes from the runtime
 * itself, on the first turn (the result message's contextWindow), which is what
 * the context bar reads.
 */
export function capabilitiesOf(model: string): Capabilities & { source: "runtime"; status: "tested"; checkedAt: null } {
  // A model id that is not Claude's cannot run here at all (validModel refuses
  // it), so the honest answer for one is the same: this engine's abilities.
  void isClaudeModel(model);
  return { tools: true, subagents: true, images: true, pdf: true, caching: true, context: 0, source: "runtime", status: "tested", checkedAt: null };
}

/** The developer-instruction note so the agent never promises what it can't do: there is nothing to warn about. */
export function capabilityNote(_model: string): string {
  return "";
}
