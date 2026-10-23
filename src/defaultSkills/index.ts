// Skills every vault has, built into the app. A vault's own
// `.vault-chat/skills/<name>/SKILL.md` with the same name overrides one.
// Plain TS strings (no `?raw` import) so the headless server bundle can
// include this module too.
import { RESOLVE_SYNC_CONFLICT } from "./resolveSyncConflict";
import { COMPACT } from "./compact";

export type DefaultSkill = { name: string; description: string; body: string };

export const DEFAULT_SKILLS: DefaultSkill[] = [RESOLVE_SYNC_CONFLICT, COMPACT];
