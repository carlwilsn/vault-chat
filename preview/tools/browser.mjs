// Shared Playwright launcher for the self-test, recorder and probes. Uses the
// Playwright Chromium build when present, else the installed Edge/Chrome.
// Every request that leaves 127.0.0.1/localhost is logged as outbound and
// aborted at the network layer — a second wall behind the page's own guard.
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";

const CANDIDATES = [
  process.env.PREVIEW_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export function browserPath() {
  const p = CANDIDATES.find((c) => existsSync(c));
  if (!p) throw new Error("no Chromium-family browser found; set PREVIEW_BROWSER");
  return p;
}

export function isLocal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return true;
    return u.hostname === "127.0.0.1" || u.hostname === "localhost";
  } catch {
    return true;
  }
}

export async function launch({ width = 1400, height = 900, headless = true, recordVideo, deviceScaleFactor = 1, isMobile = false } = {}) {
  // Playwright's own Chromium if it is installed (npx playwright-core install
  // chromium), else the system Edge/Chrome.
  let browser;
  try {
    browser = await chromium.launch({ headless });
  } catch {
    browser = await chromium.launch({ executablePath: browserPath(), headless });
  }
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, isMobile, hasTouch: isMobile, recordVideo });
  const log = { console: [], outbound: [], pageErrors: [] };
  await context.route("**/*", (route) => {
    const u = route.request().url();
    if (isLocal(u)) return route.continue();
    log.outbound.push(u);
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  const attach = (p) => {
    p.on("console", (m) => log.console.push({ type: m.type(), text: m.text(), url: p.url() }));
    p.on("pageerror", (e) => log.pageErrors.push({ text: String(e?.stack ?? e), url: p.url() }));
  };
  attach(page);
  context.on("page", attach);
  return { browser, context, page, log };
}
