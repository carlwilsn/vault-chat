import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { isUnreadableAsText } from "./fileKind";
import { openUrl, isExternalHref } from "./opener";

function resolveRelative(baseFile: string, rel: string): string {
  const sep = baseFile.includes("\\") ? "\\" : "/";
  const baseParts = baseFile.slice(0, baseFile.lastIndexOf(sep)).split(sep);
  const relParts = rel.replace(/^\.\/+/, "").split(/[\/\\]/);
  for (const p of relParts) {
    if (p === "..") baseParts.pop();
    else if (p && p !== ".") baseParts.push(p);
  }
  return baseParts.join(sep);
}

// Resolve a link href and open it in the viewer. Returns true if the
// link was handled (caller should preventDefault); false if it's a
// non-navigation href (in-page anchor, empty) that the caller should
// leave alone.
export async function tryOpenLink(href: string | null | undefined): Promise<boolean> {
  if (!href) return false;
  if (href.startsWith("#")) return false;

  if (isExternalHref(href)) {
    try {
      await openUrl(href);
    } catch (err) {
      console.error("[link] openUrl failed:", err);
    }
    return true;
  }

  // Other non-file schemes (tel:, ftp:, etc.) — preventDefault without
  // doing anything so the webview doesn't refresh.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.toLowerCase().startsWith("file:")) {
    return true;
  }

  const { vaultPath, currentFile, setCurrentFile } = useStore.getState();

  const cleaned = href.replace(/^file:\/\/\/?/, "").split("#")[0].split("?")[0];
  let target: string | null = null;
  if (/^([a-zA-Z]:[\/\\]|[\/\\])/.test(cleaned)) {
    target = cleaned;
  } else if (currentFile) {
    target = resolveRelative(currentFile, cleaned);
  } else if (vaultPath) {
    target = `${vaultPath}/${cleaned}`;
  }

  if (!target) return true;

  try {
    const content = isUnreadableAsText(target)
      ? ""
      : await invoke<string>("read_text_file", { path: target });
    setCurrentFile(target, content);
  } catch (err) {
    console.error("[link] failed to open:", target, err);
  }
  return true;
}
