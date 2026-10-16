// Entry. Styles first (KaTeX's, then the page's own), then the shell, then
// the app. (Math is rendered by the markdown pipeline, phone/src/markdown.ts;
// no KaTeX auto-render pass runs over the page.)
import "katex/dist/katex.min.css";
import "./styles/phone.css";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { App } from "./App";
import { boot } from "./boot";

// The shell is committed synchronously, then the app boots against it — the
// same order as phone.html (markup, then the end-of-body script), and an
// error in the app leaves the shell standing as it did there.
flushSync(() => createRoot(document.getElementById("root")!).render(<App />));
boot();
