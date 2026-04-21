import { invoke } from "@tauri-apps/api/core";
import { useStore, type FileEntry } from "./store";
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

function resolveVaultPath(
  raw: string,
  vaultPath: string,
  files: FileEntry[],
): string {
  const primary = `${vaultPath}/${raw}`;
  if (files.some((f) => f.path === primary)) return primary;
  const suffixHit = files.find((f) => !f.is_dir && f.path.endsWith("/" + raw));
  if (suffixHit) return suffixHit.path;
  const wantedName = raw.split("/").pop() ?? raw;
  const nameHit = files.find((f) => !f.is_dir && f.name === wantedName);
  if (nameHit) return nameHit.path;
  return primary;
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

  // Other non-file schemes (tel:, ftp:, etc.) — leave to the webview
  // default so it can decide, but still preventDefault to avoid an
  // accidental refresh into nowhere.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.toLowerCase().startsWith("file:") && !href.toLowerCase().startsWith("vault:")) {
    return true;
  }

  const { vaultPath, files, currentFile, setCurrentFile } = useStore.getState();

  let target: string | null = null;

  if (href.startsWith("vault://")) {
    if (!vaultPath) return true;
    const raw = href.slice("vault://".length).split("#")[0].split("?")[0];
    target = resolveVaultPath(raw, vaultPath, files);
  } else {
    const cleaned = href.replace(/^file:\/\/\/?/, "").split("#")[0].split("?")[0];
    if (/^([a-zA-Z]:[\/\\]|[\/\\])/.test(cleaned)) {
      target = cleaned;
    } else if (currentFile) {
      target = resolveRelative(currentFile, cleaned);
    } else if (vaultPath) {
      // No active file (link from chat/tool output) — try vault-root
      // relative with a basename-search fallback.
      target = resolveVaultPath(cleaned, vaultPath, files);
    }
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
