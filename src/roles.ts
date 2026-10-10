// Which model each small surface runs on, by Settings role — never "whatever
// the chat pane's picker happens to be on".
//
// Roles (Settings → Models): Chat (the chat pane picker, `vault_chat_model`)
// and Background (`vault_chat_background_model`). Ctrl+K inline edit and
// Ctrl+L ask each map to a role. Images and PDFs go to that role's model; only
// when it can't read images does the call quietly move to a built-in vision
// model (DEFAULT_VISION_MODEL_ID — not a setting, Carl's call).
//
// The surface → role mapping is Carl's call; three options are built and
// picked with `vault_chat_inline_roles` (the preview switches it per scenario):
//   A — Ctrl+K and Ctrl+L on Chat
//   B — Ctrl+K on Background, Ctrl+L on Chat           (default)
//   C — Ctrl+K and Ctrl+L on Background
import {
  AUTO_MODEL_ID,
  DEFAULT_BACKGROUND_MODEL_ID,
  DEFAULT_MODEL_ID,
  findModel,
  getLiveCatalog,
  resolveAutoModel,
  supportsVision,
  type ModelSpec,
  type ProviderId,
} from "./providers";

/** "vision" is internal: the built-in fallback for an image the role model
 *  can't read. It has no Settings row. */
export type Role = "chat" | "background" | "vision";
/** Every role Settings → Models shows a picker for (Voice is the voice agent's
 *  LLM, stored by the voice code, not here). */
export type RoleId = "chat" | "background" | "voice";
export type InlineSurface = "inlineEdit" | "inlineAsk";

export const DEFAULT_VISION_MODEL_ID = "google/gemini-3.5-flash";

export const ROLE_STORAGE: Record<Exclude<Role, "vision">, string> = {
  chat: "vault_chat_model",
  background: "vault_chat_background_model",
};
const ROLE_DEFAULT: Record<Role, string> = {
  chat: DEFAULT_MODEL_ID,
  background: DEFAULT_BACKGROUND_MODEL_ID,
  vision: DEFAULT_VISION_MODEL_ID,
};
export const ROLE_LABEL: Record<RoleId | Role, string> = {
  chat: "Chat",
  background: "Background",
  vision: "Built-in vision",
  voice: "Voice",
};

// Settings (store.ts) reads and writes the Background role through this; the
// key is the one roleModelId() reads, so a pick in Settings is what Ctrl+K /
// Ctrl+L run on.
export const BACKGROUND_MODEL_STORAGE = ROLE_STORAGE.background;

/** The model a background job (titles, compaction, summaries) should use. */
export function backgroundModel(): string {
  return roleModelId("background");
}

/** The built-in model an image or a PDF moves to when the model it was sent
 *  to can't read it. Fixed; not a setting. */
export function visionModel(): string {
  return DEFAULT_VISION_MODEL_ID;
}

export const INLINE_ROLE_OPTIONS = {
  A: { inlineEdit: "chat", inlineAsk: "chat" },
  B: { inlineEdit: "background", inlineAsk: "chat" },
  C: { inlineEdit: "background", inlineAsk: "background" },
} as const satisfies Record<string, Record<InlineSurface, Role>>;
export type InlineRoleOption = keyof typeof INLINE_ROLE_OPTIONS;
const INLINE_ROLES_KEY = "vault_chat_inline_roles";

function ls(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function inlineRoleOption(): InlineRoleOption {
  const v = ls(INLINE_ROLES_KEY);
  return v === "A" || v === "B" || v === "C" ? v : "B";
}

/** The model id a role is set to (Settings), or its default. */
export function roleModelId(role: Role): string {
  if (role === "vision") return visionModel();
  return ls(ROLE_STORAGE[role]) || ROLE_DEFAULT[role];
}

export type SurfaceModel = {
  spec: ModelSpec | null;
  /** The id the role is set to (may be "auto"). */
  id: string;
  role: Role;
  /** Set when an image moved the call off its role's model. */
  switchedFrom?: Role;
};

/** The model a Ctrl+K / Ctrl+L call runs on. */
export function inlineModel(
  surface: InlineSurface,
  opts: { hasImage?: boolean; prompt?: string; apiKeys: Partial<Record<ProviderId, string>> },
): SurfaceModel {
  let role: Role = INLINE_ROLE_OPTIONS[inlineRoleOption()][surface];
  let spec = resolve(roleModelId(role), opts);
  let switchedFrom: Role | undefined;
  if (opts.hasImage && spec && !supportsVision(spec)) {
    switchedFrom = role;
    role = "vision";
    spec = resolve(roleModelId(role), opts);
  }
  return { spec, id: roleModelId(role), role, ...(switchedFrom ? { switchedFrom } : {}) };
}

/** A role's id → a concrete model. "auto" resolves the way a chat turn does
 *  (it used to fail Ctrl+K outright: "No API key for auto"). */
function resolve(id: string, opts: { prompt?: string; apiKeys: Partial<Record<ProviderId, string>> }): ModelSpec | null {
  if (id === AUTO_MODEL_ID) return resolveAutoModel(opts.prompt ?? "", opts.apiKeys, getLiveCatalog(), 0);
  return findModel(id) ?? null;
}
