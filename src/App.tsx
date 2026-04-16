import { useEffect } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { FileTree } from "./FileTree";
import { MarkdownView } from "./MarkdownView";
import { ChatPane } from "./ChatPane";
import { SettingsPane } from "./SettingsPane";
import { Titlebar } from "./Titlebar";
import { useStore } from "./store";
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
  const leftCollapsed = useStore((s) => s.leftCollapsed);
  const rightCollapsed = useStore((s) => s.rightCollapsed);
  const popoutOpen = useStore((s) => s.popoutOpen);
  const showSettings = useStore((s) => s.showSettings);
  const chatHidden = rightCollapsed || popoutOpen;
  const files = useStore((s) => s.files);
  const maxDepth = files.reduce((m, f) => Math.max(m, f.depth), 0);
  const leftMax = Math.max(420, 120 + maxDepth * 14 + 200);

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
        <Allotment>
          <Allotment.Pane preferredSize={200} minSize={160} maxSize={leftMax} visible={!leftCollapsed} snap>
            <FileTree />
          </Allotment.Pane>
          <Allotment.Pane minSize={340}>
            {showSettings && chatHidden ? <SettingsPane /> : <MarkdownView />}
          </Allotment.Pane>
          <Allotment.Pane preferredSize={440} minSize={320} visible={!rightCollapsed && !popoutOpen} snap>
            <ChatPane />
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  );
}
