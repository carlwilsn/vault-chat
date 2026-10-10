// The phone shell. React renders the page's fixed structure once, in the same
// order and markup phone.html had; the app's behaviour (boot.ts) then drives it
// by element id, as it always did. Nothing here re-renders.
import { Header, OffBar, Menu } from "./shell/Header";
import { ConvDrawer } from "./shell/ConvDrawer";
import { Pages } from "./shell/Pages";
import { ClaudeDrawer } from "./shell/ClaudeDrawer";
import { Sheet } from "./shell/Sheet";
import { Voice } from "./shell/Voice";

export function App() {
  return (
    <>
      <Header />
      <OffBar />
      <Menu />
      <ConvDrawer />
      <Pages />
      <ClaudeDrawer />
      <div id="toast"></div>
      <Sheet />
      <Voice />
    </>
  );
}
