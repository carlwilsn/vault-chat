// The one place pdf.js gets its worker. A webview without Map.prototype.getOrInsertComputed (macOS 15's WebKit) gets
// the method on this thread (src/upsertPolyfill.ts) and pdf.js's legacy worker, which carries its own polyfills; any
// other webview keeps the modern worker. Same pdf.js version either way, so the API and the worker match.
import * as pdfjs from "pdfjs-dist";
import modernWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import legacyWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { installUpsert, lacksUpsert } from "./upsertPolyfill";

const legacy = lacksUpsert();
if (legacy) installUpsert();
pdfjs.GlobalWorkerOptions.workerSrc = legacy ? legacyWorker : modernWorker;

export { pdfjs };
