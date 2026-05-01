import { useEffect } from "react";
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

// Centralized anchor-click handler. Any click on an <a> anywhere in the
// window runs through tryOpenLink: external URLs dispatch to the OS
// browser, vault-relative / wiki / relative paths load into the viewer,
// in-page anchors pass through. Mounted in both the main window (App)
// and the chat popout (ChatWindow) so behavior is identical regardless
// of where the link is rendered.
export function useGlobalAnchorClickHandler(): void {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      if (e.button !== 0 && e.button !== 1) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
      if (!href) return;
      if (href.startsWith("#")) return;
      e.preventDefault();
      e.stopPropagation();
      tryOpenLink(href).catch((err) => console.error("[link] failed:", err));
    };
    const onAuxClick = (e: MouseEvent) => {
      if (e.button === 1) onClick(e);
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("click", onClick, true);
    window.addEventListener("auxclick", onAuxClick, true);
    window.addEventListener("beforeunload", onBeforeUnload);

    // Nuclear option: walk the DOM and strip `href` from every anchor
    // whose target is an internal link (vault:// / relative path / file:).
    // External http/https/mailto keep their href so hover tooltips work.
    const isExternal = (h: string) =>
      /^(https?:|mailto:|tel:)/i.test(h) || h.startsWith("#");
    const sanitize = (root: ParentNode) => {
      const anchors = root.querySelectorAll?.("a[href]");
      if (!anchors) return;
      anchors.forEach((a) => {
        const h = a.getAttribute("href");
        if (!h || isExternal(h)) return;
        if (!a.getAttribute("data-href")) a.setAttribute("data-href", h);
        a.removeAttribute("href");
      });
    };
    sanitize(document);
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) sanitize(n as ParentNode);
        }
        if (m.type === "attributes" && m.target.nodeType === 1) {
          sanitize((m.target as ParentNode).parentNode as ParentNode);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });

    return () => {
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("auxclick", onAuxClick, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
      observer.disconnect();
    };
  }, []);
}
