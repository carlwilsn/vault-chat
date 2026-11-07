// The models Claude Code runs, as Carl picks them.
//
// Claude Code names a model by what it is for — opus, sonnet, haiku — and
// resolves the alias itself, so vault-chat does not need a catalog for them.
// The OpenRouter picker's `provider/model` ids stay valid while pi does.

/** What the picker offers for a conversation on Claude Code. */
export const CLAUDE_MODEL_ALIASES = ["opus", "sonnet", "haiku"] as const;

/** A Claude Code model: one of its aliases, or a pinned id like claude-opus-5. */
export function isClaudeModel(m: string): boolean {
  return (CLAUDE_MODEL_ALIASES as readonly string[]).includes(m) || /^claude[A-Za-z0-9_.-]*$/.test(m);
}

/** A model id vault-chat will set: an OpenRouter provider/model, or a Claude one. */
export function validModel(m: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/.test(m) || isClaudeModel(m);
}
