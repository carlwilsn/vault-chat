import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { FileTree } from "./FileTree";
import { MarkdownView } from "./MarkdownView";
import { ChatPane } from "./ChatPane";
import "./App.css";

export default function App() {
  return (
    <div className="h-full w-full bg-background">
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
  );
}
