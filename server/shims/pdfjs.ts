// `pdfjs-dist` for the headless server: DOM stubs first, then the legacy
// (node) build, with its worker bundled and handed over as
// globalThis.pdfjsWorker so pdf.js runs it on the main thread — there is no
// worker file to load next to the bundle (tools.ts sets workerSrc to an asset
// URL that does not exist headless).
import "./domStubs";
import * as worker from "../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
export * from "../../node_modules/pdfjs-dist/legacy/build/pdf.mjs";

(globalThis as any).pdfjsWorker ??= worker;
