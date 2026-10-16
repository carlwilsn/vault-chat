// highlight.js theme stylesheets — loaded as URLs and swapped at runtime
// based on the active theme. Importing one as a side effect (the way it
// used to be) painted code blocks dark even in light mode. Its own module, not
// main.tsx: App and ChatWindow importing the entry made a cycle, and after an
// HMR edit Vite re-ran main.tsx under a ?t= URL — a second createRoot.
import hljsDarkUrl from "highlight.js/styles/github-dark.css?url";
import hljsLightUrl from "highlight.js/styles/github.css?url";

export function applyHljsTheme(theme: string) {
  let link = document.getElementById("vault-chat-hljs") as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = "vault-chat-hljs";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  link.href = theme === "light" ? hljsLightUrl : hljsDarkUrl;
}
