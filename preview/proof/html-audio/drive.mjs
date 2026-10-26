// Drives the real vault-chat (a test instance, CDP on :9333, WebView2 --mute-audio):
// opens a vault HTML page in the app's own viewer, presses Play with a real
// mouse click, and reads the page's audio state. Usage: node drive.mjs <label>
//
// How these proofs were made (Windows, the real Tauri app, never Carl's instance):
//   npx tauri build --debug --no-bundle --config '{"identifier":"com.vault-chat.htmlaudiotest","build":{"beforeBuildCommand":"npm run build"}}'
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333 --mute-audio" src-tauri/target/debug/vault-chat.exe
//   OUT_DIR=... TEST_VAULT=<a scratch vault: "Physics 135/" (the lesson + electricity-audio/),
//     media-test/media.html (this folder) + assets/{tone.mp3,clip.mp4,mono.ttf,data.json,mod.js},
//     shared/pic.png, .secret/hidden.txt> node drive.mjs before|after
// before = origin/main 61af67aa, after = the vcpage fix.
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
const require = createRequire("C:/Users/wada2/github/vc-html-audio/preview/package.json");
const { chromium } = require("playwright-core");

const label = process.argv[2] ?? "run";
const OUT = process.env.OUT_DIR;
mkdirSync(OUT, { recursive: true });
const VAULT = process.env.TEST_VAULT;
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages()[0];
const net = [];
page.on("response", (r) => { if (/\.(mp3|mp4|png|ttf|json|js)(\?|$)/.test(r.url()) && !/tauri\.localhost\/assets\//.test(r.url())) net.push({ url: r.url(), status: r.status(), type: r.headers()["content-type"] }); });
page.on("requestfailed", (r) => net.push({ url: r.url(), failed: r.failure()?.errorText }));
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300)));

await page.evaluate((v) => localStorage.setItem("vault_chat_last_vault", v), VAULT);
await page.reload();
await page.waitForTimeout(4000);

async function open(dir, file) {
  if (dir) {
    const d = page.getByText(dir, { exact: true }).first();
    await d.click();
    await page.waitForTimeout(600);
  }
  await page.getByText(file, { exact: true }).first().click();
  await page.waitForTimeout(2500);
  const handle = await page.waitForSelector('iframe[title="HTML preview"]', { timeout: 15000 });
  const frame = await handle.contentFrame();
  return { handle, frame };
}

async function clickIn(handle, frame, selector) {
  const box = await handle.boundingBox();
  const el = await frame.$(selector);
  const b = await el.boundingBox();
  // A real pointer click at the element (a user gesture inside the iframe).
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  return { iframe: box, target: b };
}

const result = { label };
// 1) The lesson.
{
  const { handle, frame } = await open("Physics 135", "electricity-connected.html");
  result.lessonBase = await frame.evaluate(() => document.baseURI);
  await page.screenshot({ path: `${OUT}/${label}-lesson-before-play.png` });
  await clickIn(handle, frame, "#begin");
  const samples = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1000);
    samples.push(await frame.evaluate(() => {
      // `audio` is the lesson's own top-level `let`.
      // eslint-disable-next-line no-undef
      const a = typeof audio !== "undefined" ? audio : null;
      return a ? { src: a.currentSrc, currentTime: +a.currentTime.toFixed(2), paused: a.paused, readyState: a.readyState, error: a.error && a.error.code, status: document.getElementById("status")?.textContent ?? null } : { none: true };
    }));
  }
  result.lesson = samples;
  await page.screenshot({ path: `${OUT}/${label}-lesson-playing.png` });
  // Pause it so nothing keeps playing in the background.
  await frame.evaluate(() => { try { /* eslint-disable-next-line no-undef */ audio && audio.pause(); } catch {} });
}
// 2) The synthetic page: audio, video, images, font, module, fetch, the wall.
{
  const { handle, frame } = await open("media-test", "media.html");
  result.mediaBase = await frame.evaluate(() => document.baseURI);
  await clickIn(handle, frame, "#play");
  await page.waitForTimeout(5500);
  result.media = await frame.evaluate(() => window.__media);
  await page.screenshot({ path: `${OUT}/${label}-media.png` });
}
result.net = net;
result.console = consoleLines.filter((l) => !/^debug|^log: \[boot/.test(l)).slice(-40);
writeFileSync(`${OUT}/${label}-result.json`, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1).slice(0, 6000));
await browser.close().catch(() => {});
process.exit(0);
