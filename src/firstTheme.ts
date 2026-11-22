// The theme the window's first frame is painted in, before the box's settings arrive (src/settings.ts). index.html has
// the same lookup inline (it runs before any module): keep the two in step.
//
// Kept twice: in sessionStorage (its own quota, and it survives the reload of a core swap, src/coreSwap.ts) and in
// localStorage (it survives a restart). A full localStorage (the box-log replica once filled it) used to lose the
// copy, and a light-theme window then painted its first frame dark: the flash on every core swap.
export type Theme = "graphite" | "light";
/** sessionStorage key; index.html reads it by name. */
export const THEME_SESSION = "vc.theme";
/** localStorage key (the setting's old home); index.html reads it by name. */
export const THEME_LOCAL = "vault_chat_theme";

const norm = (t: unknown): Theme | null => (t === "light" ? "light" : t === "graphite" ? "graphite" : null);

/** The theme to paint first: this window's own copy, else the laptop's, else graphite. Never throws. */
export function firstPaintTheme(): Theme {
  try {
    const s = norm(globalThis.sessionStorage?.getItem(THEME_SESSION));
    if (s) return s;
  } catch {
    /* no session storage */
  }
  try {
    const l = norm(globalThis.localStorage?.getItem(THEME_LOCAL));
    if (l) return l;
  } catch {
    /* no local storage */
  }
  return "graphite";
}

/** Keep the theme for the next first frame (both copies; either may be full). Never throws. */
export function keepTheme(t: Theme): void {
  try {
    globalThis.sessionStorage?.setItem(THEME_SESSION, t);
  } catch {
    /* full or absent */
  }
  try {
    globalThis.localStorage?.setItem(THEME_LOCAL, t);
  } catch {
    /* full or absent: the session copy carries a swap */
  }
}
