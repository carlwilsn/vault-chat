import { useEffect, useState } from "react";
import { modeOf, type PageMode } from "./pageTheme";

/** The app's current mode, following changes (for an iframe's own `color-scheme`). */
export function useAppMode(): PageMode {
  const [mode, setMode] = useState<PageMode>(() => modeOf(document.documentElement.dataset.theme));
  useEffect(() => {
    const mo = new MutationObserver(() => setMode(modeOf(document.documentElement.dataset.theme)));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return mode;
}
