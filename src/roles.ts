// The model roles Settings → Models shows, one picker each. Machine-local
// (localStorage) like every model choice today; the shared settings.json is a
// later step (E1). Chat is today's chat-pane model (vault_chat_model) and also
// sets the phone assistant's (one Chat model for laptop and phone, decision 19).
// Background and Images & PDFs are new: stored here, read through roleModel(),
// and not yet wired into the hidden jobs or the image/PDF switch.
import { DEFAULT_BACKGROUND_MODEL_ID } from "./providers";

export type RoleId = "chat" | "background" | "vision" | "voice";

export const ROLE_LABEL: Record<RoleId, string> = {
  chat: "Chat",
  background: "Background",
  vision: "Images & PDFs",
  voice: "Voice",
};

export const DEFAULT_VISION_MODEL_ID = "google/gemini-3.5-flash";

export const BACKGROUND_MODEL_STORAGE = "vault_chat_background_model";
export const VISION_MODEL_STORAGE = "vault_chat_vision_model";

/** The model a background job (titles, compaction, summaries) should use. */
export function backgroundModel(): string {
  return read(BACKGROUND_MODEL_STORAGE) ?? DEFAULT_BACKGROUND_MODEL_ID;
}

/** The model a turn carrying an image or a PDF should switch to. */
export function visionModel(): string {
  return read(VISION_MODEL_STORAGE) ?? DEFAULT_VISION_MODEL_ID;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
