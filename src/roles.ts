// Which model each small surface runs on, by Settings role — never "whatever
// the chat pane's picker happens to be on".
//
// Roles (Settings → Models): Chat (the chat pane picker, `vault_chat_model`),
// Background (`vault_chat_background_model`) and Images & PDFs
// (`vault_chat_vision_model`). Ctrl+K inline edit and Ctrl+L ask each map to a
// role; an ask that carries an image (a PDF region, an image viewer, a pasted
// capture) whose role model can't see images runs on Images & PDFs instead.
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

export type Role = "chat" | "background" | "vision";
export type InlineSurface = "inlineEdit" | "inlineAsk";

export const DEFAULT_VISION_MODEL_ID = "google/gemini-3.5-flash";

export const ROLE_STORAGE: Record<Role, string> = {
  chat: "vault_chat_model",
  background: "vault_chat_background_model",
  vision: "vault_chat_vision_model",
};
const ROLE_DEFAULT: Record<Role, string> = {
  chat: DEFAULT_MODEL_ID,
  background: DEFAULT_BACKGROUND_MODEL_ID,
  vision: DEFAULT_VISION_MODEL_ID,
};
export const ROLE_LABEL: Record<Role, string> = {
  chat: "Chat",
  background: "Background",
  vision: "Images & PDFs",
};

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
