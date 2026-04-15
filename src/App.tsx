import { useEffect } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { FileTree } from "./FileTree";
import { MarkdownView } from "./MarkdownView";
import { ChatPane } from "./ChatPane";
import { Titlebar } from "./Titlebar";
import { useStore } from "./store";
import "./App.css";

export default function App() {
  const toggleMode = useStore((s) => s.toggleMode);
  const currentFile = useStore((s) => s.currentFile);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
        if (!currentFile) return;
        e.preventDefault();
        toggleMode();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMode, currentFile]);

  return (
    <div className="h-full w-full bg-background flex flex-col">
      <Titlebar />
      <div className="flex-1 min-h-0">
      <Allotment>
        <Allotment.Pane preferredSize={260} minSize={180}>
          <FileTree />
        </Allotment.Pane>
        <Allotment.Pane minSize={340}>
          <MarkdownView />
        </Allotment.Pane>
        <Allotment.Pane preferredSize={440} minSize={320}>
          <ChatPane />
        </Allotment.Pane>
      </Allotment>
      </div>
    </div>
  );
}
