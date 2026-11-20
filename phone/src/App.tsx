// The phone shell: a notification center (Alerts) and a notes app (Notes), and the Box & settings drawer.
// React renders the page's fixed structure once; the app's behaviour (boot.ts) drives it by element id.
import { Header, OffBar, Menu } from "./shell/Header";
import { Pages } from "./shell/Pages";
import { ClaudeDrawer } from "./shell/ClaudeDrawer";
import { Sheet } from "./shell/Sheet";

export function App() {
  return (
    <>
      <Header />
      <OffBar />
      <Menu />
      <Pages />
      <ClaudeDrawer />
      <div id="toast"></div>
      <Sheet />
    </>
  );
}
