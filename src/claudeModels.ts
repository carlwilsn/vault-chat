// The models the picker offers: Claude's, and only Claude's.
//
// GET /api/v1/models still answers with the whole catalog — every OpenRouter
// `provider/model` id the box knows plus Claude Code's aliases (server/engine/
// capabilities.ts modelsList) — because the box keeps pi working while another
// lane takes it out. The UI must not show that: Carl, on the release, "I still
// see openrouter and old pi stuff". So every list the app draws goes through
// here first.
//
// The aliases themselves are Claude Code's (server/engine/claude/models.ts
// CLAUDE_MODEL_ALIASES); test/harness/claudeOnlyUi.test.ts pins this list
// against that one so the two cannot drift.

/** What the picker offers, in the order it shows them: most capable first. */
export const CLAUDE_MODELS = ["opus", "sonnet", "haiku"] as const;

/** A Claude model id: one of the aliases, or a pinned id like claude-opus-5. */
export function isClaudeModelId(id: string): boolean {
  return (CLAUDE_MODELS as readonly string[]).includes(id) || /^claude[A-Za-z0-9_.-]*$/.test(id);
}

/**
 * The box's list, as the picker shows it: Claude's models in CLAUDE_MODELS
 * order, then any other Claude id the box offers (a pinned release), and
 * nothing else. A box that offers none leaves the list empty — the picker then
 * shows nothing rather than falling back to the catalog.
 */
export function claudeModelsOnly(ids: readonly string[]): string[] {
  const claude = ids.filter(isClaudeModelId);
  const rank = (id: string) => {
    const i = (CLAUDE_MODELS as readonly string[]).indexOf(id);
    return i === -1 ? CLAUDE_MODELS.length : i;
  };
  return [...new Set(claude)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * A model id as Carl reads it: "Opus", "Sonnet", "Haiku". Anything else (a
 * pinned claude-* id) keeps its own name — it is still a Claude name, so it is
 * still readable. Not a Claude id at all (the box is still on pi): null, so the
 * caller shows its own placeholder instead of an OpenRouter id.
 */
export function claudeModelLabel(id: string | null | undefined): string | null {
  if (!id || !isClaudeModelId(id)) return null;
  return (CLAUDE_MODELS as readonly string[]).includes(id) ? id[0]!.toUpperCase() + id.slice(1) : id;
}
