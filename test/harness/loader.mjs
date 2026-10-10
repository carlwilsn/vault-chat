// Node module hooks so the webview's TypeScript modules can be imported under
// `node --test` (no Vite, no DOM):
// - `foo?url` (Vite asset-URL imports) resolve to a stub string module;
// - `*.css` imports resolve to an empty module;
// - `pdfjs-dist` (needs DOMMatrix/canvas at import time) resolves to a stub —
//   the harness tests never render PDFs.
const stub = (src) => ({ url: "data:text/javascript," + encodeURIComponent(src), shortCircuit: true });

export async function resolve(specifier, context, next) {
  if (specifier.endsWith("?url")) return stub("export default 'stub-url';");
  if (specifier.endsWith(".css")) return stub("export default '';");
  if (specifier === "pdfjs-dist" || specifier.startsWith("pdfjs-dist/")) {
    return stub(
      "export const GlobalWorkerOptions = {};" +
        "export function getDocument() { throw new Error('pdfjs is stubbed in tests'); }" +
        "export default {};",
    );
  }
  return next(specifier, context);
}

// Vite's `import.meta.env` doesn't exist under node — give every app module a
// minimal one (production-like) so `import.meta.env.DEV` reads false.
export async function load(url, context, next) {
  const out = await next(url, context);
  if (url.includes("/src/") && !url.includes("/node_modules/") && out.source != null) {
    const src = typeof out.source === "string" ? out.source : new TextDecoder().decode(out.source);
    return {
      ...out,
      source: `if (!import.meta.env) import.meta.env = { DEV: false, PROD: true, MODE: "test" };\n${src}`,
    };
  }
  return out;
}
