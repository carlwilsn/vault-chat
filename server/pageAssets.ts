// A vault page's relative images, video and audio, read from beside it on the box (src/inlineHtml.ts): small ones
// embedded as data: URIs, too-big media left as hand-off placeholders the viewing surface (the phone) fills on request.
import { readFileSync, statSync } from "node:fs";
import { embedRelativeImages, joinPagePath, planPageAssets, relativeAssetRefs } from "../src/inlineHtml";
import { withinVault } from "./phoneData";

/** `page`: the page's vault path; `handoff: false` where nobody answers a hand-off (the /p/ link). */
export function embedPageAssets(vault: string, page: string, raw: string, opts: { handoff?: boolean } = {}): string {
  const dir = page.replace(/[?#].*$/, "").split("/").slice(0, -1).join("/");
  const files = new Map<string, string>();
  const sizes = new Map<string, number>();
  for (const ref of relativeAssetRefs(raw)) {
    const at = joinPagePath(dir, ref);
    const f = at === null ? null : withinVault(vault, at);
    try { if (f) { sizes.set(ref, statSync(f).size); files.set(ref, f); } } catch { /* missing */ }
  }
  const plan = planPageAssets(sizes, opts);
  const bytes = new Map<string, Buffer>();
  for (const ref of plan.inline) {
    try { bytes.set(ref, readFileSync(files.get(ref)!)); } catch { /* gone */ }
  }
  return embedRelativeImages(raw, bytes, plan.handoff);
}
