// The app's real stylesheet (server/appCssGen.mjs, built into the bundle as
// "vc:app-css"): served at /app-styles.css and inlined into the .html pages the
// chat shows inline (src/inlineHtml.ts, serveVaultFile's `inline=1`).
import css from "vc:app-css";

export function appCss(): string {
  return css;
}
