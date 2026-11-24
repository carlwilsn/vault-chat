// The phone shell: a notification center (Alerts) and a notes app (Notes), the tab bar between them, Settings
// behind the gear and the full-screen note editor. React renders the page's fixed structure once; the app's
// behaviour (boot.ts) drives it by element id.
import { Header } from "./shell/Header";
import { Pages } from "./shell/Pages";
import { Tabs } from "./shell/Tabs";
import { Settings } from "./shell/Settings";
import { Editor } from "./shell/Editor";

export function App() {
  return (
    <>
      <Header />
      <Pages />
      <Tabs />
      <Settings />
      <Editor />
      <div id="toast"></div>
    </>
  );
}
