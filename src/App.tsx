import { useEffect, useMemo, useRef, useState } from "react";
import { Allotment, LayoutPriority } from "allotment";
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "./store";
import "allotment/dist/style.css";
import { FileTree } from "./FileTree";
import { MarkdownArea } from "./MarkdownArea";
import { ChatPane } from "./ChatPane";
import { SettingsPane } from "./SettingsPane";
import { Titlebar } from "./Titlebar";
import { useStore } from "./store";
import { gitInitIfNeeded } from "./git";
import { tryOpenLink } from "./linkNav";
import "./App.css";

export default function App() {
  const toggleMode = useStore((s) => s.toggleMode);
  const toggleLeft = useStore((s) => s.toggleLeft);
  const toggleRight = useStore((s) => s.toggleRight);
  const currentFile = useStore((s) => s.currentFile);
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setFiles = useStore((s) => s.setFiles);
  useEffect(() => {
    const saved = useStore.getState().vaultPath;
    if (!saved) return;
    let cancelled = false;
    (async () => {
      try {
        const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: saved });
        if (!cancelled) setFiles(listed);
        gitInitIfNeeded(saved).catch(() => {});
      } catch {
        if (!cancelled) {
          localStorage.removeItem("vault_chat_last_vault");
          useStore.setState({ vaultPath: null });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setFiles]);
  const leftCollapsed = useStore((s) => s.leftCollapsed);
  const rightCollapsed = useStore((s) => s.rightCollapsed);
  const popoutOpen = useStore((s) => s.popoutOpen);
  const showSettings = useStore((s) => s.showSettings);
  const chatHidden = rightCollapsed || popoutOpen;
  const files = useStore((s) => s.files);
  const vaultPath = useStore((s) => s.vaultPath);
  const fitWidth = useMemo(() => computeFitWidth(files), [files]);
  const leftMax = Math.max(fitWidth, 600);

  const [layoutKey, setLayoutKey] = useState<string>("empty");
  const lastVaultRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      vaultPath &&
      vaultPath !== lastVaultRef.current &&
      files.length > 0 &&
      files[0].path.startsWith(vaultPath)
    ) {
      lastVaultRef.current = vaultPath;
      setLayoutKey(vaultPath);
    }
  }, [vaultPath, files]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "e") {
        if (!currentFile) return;
        e.preventDefault();
        toggleMode();
      } else if (k === "b" && !e.shiftKey) {
        e.preventDefault();
        toggleLeft();
      } else if (k === "b" && e.shiftKey) {
        e.preventDefault();
        toggleRight();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMode, toggleLeft, toggleRight, currentFile]);

  // Suppress webview defaults that bleed through and make the app feel
  // like a browser tab: Ctrl+F (find bar), Ctrl+G (find-next), Ctrl+R /
  // F5 (reload), Ctrl+P (print), Ctrl+S (save-page), and the native
  // right-click context menu. Custom menus (file tree, PDF) install
  // their own contextmenu handlers that preventDefault locally.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && (k === "f" || k === "g" || k === "r" || k === "p" || k === "s")) {
        e.preventDefault();
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        return;
      }
    };
    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("contextmenu", onContext);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("contextmenu", onContext);
    };
  }, []);

  // Block stray file drops that miss our handlers — otherwise the webview
  // navigates to the dropped file's URL.
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  // Centralized anchor-click handler. Any click on an <a> anywhere in
  // the app runs through tryOpenLink: external URLs dispatch to the OS
  // browser, vault-relative / wiki / relative paths load into the
  // viewer, in-page anchors pass through. The webview never navigates
  // from under us (which would look like an app refresh).
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
    // Runs once on mount and again whenever the DOM mutates, so links
    // from chat messages, tool results, and agent-rendered HTML all get
    // sanitized — no matter which component emitted them.
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

  return (
    <div className="h-full w-full bg-background flex flex-col">
      <Titlebar />
      <div className="flex-1 min-h-0">
        <Allotment key={layoutKey} proportionalLayout={false}>
          <Allotment.Pane preferredSize={fitWidth} minSize={160} maxSize={leftMax} visible={!leftCollapsed} snap>
            <FileTree />
          </Allotment.Pane>
          <Allotment.Pane minSize={340} priority={LayoutPriority.High}>
            {showSettings && chatHidden ? <SettingsPane /> : <MarkdownArea />}
          </Allotment.Pane>
          <Allotment.Pane preferredSize={440} minSize={320} visible={!rightCollapsed && !popoutOpen} snap>
            <ChatPane />
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  );
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.font = "12.5px ui-sans-serif, system-ui, sans-serif";
  measureCtx = ctx;
  return ctx;
}

function computeFitWidth(files: FileEntry[]): number {
  if (!files.length) return 180;
  const ctx = getMeasureCtx();
  let max = 0;
  for (const f of files) {
    if (f.hidden) continue;
    if (f.depth !== 0) continue;
    const label = f.is_dir ? f.name : f.name.replace(/\.md$/, "");
    const indent = 8;
    const iconAndGap = 22;
    const text = ctx ? ctx.measureText(label).width : label.length * 7;
    const right = 16;
    const w = indent + iconAndGap + text + right;
    if (w > max) max = w;
  }
  return Math.max(160, Math.min(320, Math.round(max)));
}
