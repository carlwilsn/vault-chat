// Entry. Styles first (KaTeX's, then the page's own), KaTeX auto-render on
// window as the CDN script used to put it, then the shell, then the app.
import "katex/dist/katex.min.css";
import "./styles/phone.css";
import renderMathInElement from "katex/contrib/auto-render";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { App } from "./App";
import { boot } from "./boot";

window.renderMathInElement = renderMathInElement as Window["renderMathInElement"];

// The shell is committed synchronously, then the app boots against it — the
// same order as phone.html (markup, then the end-of-body script), and an
// error in the app leaves the shell standing as it did there.
flushSync(() => createRoot(document.getElementById("root")!).render(<App />));
boot();
