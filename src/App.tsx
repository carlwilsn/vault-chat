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
  const middleCollapsed = useStore((s) => s.middleCollapsed);
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

  return (
    <div className="h-full w-full bg-background flex flex-col">
      <Titlebar />
      <div className="flex-1 min-h-0">
        <Allotment
          key={layoutKey}
          proportionalLayout={false}
          onVisibleChange={(index, visible) => {
            // Sync snap-drag hides/shows back to the store so the
            // collapsed flags reflect what the user sees.
            if (index === 0) {
              if (visible === leftCollapsed) useStore.setState({ leftCollapsed: !visible });
            } else if (index === 1) {
              // Editor is force-visible when chat is hidden — ignore
              // Allotment's echo in that case.
              if (chatHidden) return;
              if (visible === middleCollapsed) useStore.setState({ middleCollapsed: !visible });
            } else if (index === 2) {
              // Chat is force-hidden while popped out — don't let the
              // popout state flip rightCollapsed.
              if (popoutOpen) return;
              if (visible === rightCollapsed) useStore.setState({ rightCollapsed: !visible });
            }
          }}
        >
          <Allotment.Pane preferredSize={fitWidth} minSize={160} maxSize={leftMax} visible={!leftCollapsed} snap>
            <FileTree />
          </Allotment.Pane>
          <Allotment.Pane minSize={340} priority={LayoutPriority.High} visible={!middleCollapsed || chatHidden} snap>
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
