// Record a short video of a scenario's flow (its open-steps run live, then a
// few seconds of the result). With --side both, before and after are recorded
// in the same scenario and joined side by side (ffmpeg hstack) with labels.
//   node preview/record.mjs <scenario> [--side before|after|both] [--surface desktop|phone] [--seconds 12]
// Output: preview/out/videos/<scenario>-<side>.webm (+ <scenario>-before-after.mp4)
import { mkdirSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { launch } from "./tools/browser.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const id = argv.find((a) => !a.startsWith("--") && !argv[argv.indexOf(a) - 1]?.startsWith("--")) ?? "chat-tools";
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const sideOpt = opt("side", "before");
const surface = opt("surface", "desktop");
const seconds = Number(opt("seconds", 12));
const ORIGINS = { before: process.env.PREVIEW_BEFORE ?? "http://127.0.0.1:1520", after: process.env.PREVIEW_AFTER ?? "http://127.0.0.1:1521" };
const OUT = join(HERE, "out", "videos");
mkdirSync(OUT, { recursive: true });

const size = surface === "phone" ? { width: 390, height: 844 } : { width: 1400, height: 900 };

async function recordOne(side) {
  const { browser, context, page } = await launch({ ...size, recordVideo: { dir: OUT, size }, isMobile: surface === "phone" });
  const url = surface === "phone" ? `${ORIGINS[side]}/phone?scenario=${id}` : `${ORIGINS[side]}/?scenario=${id}&side=${side}&overlay=0`;
  await page.goto(url);
  if (surface === "phone") await page.waitForFunction(() => window.__previewPhone?.ready, null, { timeout: 30000 }).catch(() => {});
  else await page.waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(seconds * 1000);
  const video = page.video();
  await context.close();
  await browser.close();
  const tmp = await video.path();
  const dest = join(OUT, `${id}-${side}.webm`);
  renameSync(tmp, dest);
  console.log(`recorded ${dest}`);
  return dest;
}

const sides = sideOpt === "both" ? ["before", "after"] : [sideOpt];
const files = await Promise.all(sides.map(recordOne));
if (files.length === 2 && existsSync(files[0]) && existsSync(files[1])) {
  const out = join(OUT, `${id}-before-after.mp4`);
  // drawtext needs an explicit font file where fontconfig isn't set up (Windows).
  const font = ["C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Helvetica.ttc"].find((f) => existsSync(f));
  const ff = font ? `fontfile='${font.replace(/:/g, "\\:")}':` : "";
  const label = (t) => `drawtext=${ff}text='${t}':x=16:y=12:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6`;
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", files[0], "-i", files[1], "-filter_complex", `[0:v]${label("Before")}[a];[1:v]${label("After")}[b];[a][b]hstack=inputs=2:shortest=1,scale=trunc(iw/4)*2:trunc(ih/4)*2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", out], { stdio: "inherit" });
  console.log(`side by side: ${out}`);
}
