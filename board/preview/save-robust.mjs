// Nothing written on a board is lost — in WebKit as Carl's iPad (Mac UA, touch, the Pencil), against the real built
// server (dist-server with the board app: `npm run build:server`) on a throwaway vault, which this script starts,
// kills and restarts itself. The incident (2026-10-22): a self-update restarted the box while a save was in flight;
// that request never settled, every later save queued behind it, "saving" showed nothing, and 24 minutes of ink
// were gone when the app was reopened. Each case below writes with the Pencil and then reads the box's board.json:
//
//   1. hang: the save request never answers (held open). "Not saved · retrying" shows within ~10 s and `save.stall`
//      is logged; the Pencil keeps writing; the page is reloaded (no save ever answered) — every stroke is on screen
//      and on the box (the iPad's copy, IndexedDB, sent on open).
//   2. restart: the box is killed mid-save (a 3 MB board), the Pencil writes on while it is down, it comes back on
//      the same port: everything reaches the box, no "changed elsewhere".
//   3. lost answer: the save reaches the box but its answer never reaches the iPad; the resend from the same base is
//      taken (the box knows the rev is this page's own), no conflict.
//   4. fail: the box answers 500: "Not saved · retrying" at once, then saved by the retry once it answers again.
//   5. reload with unsaved work: the Pencil writes and the page reloads within 0.3 s (nothing saved): recovered.
//   6. conflict: unsaved work on the iPad and another device saved the board since: Carl is asked; "keep this
//      iPad's" puts it on the box.
//   7. geometry: a size change is logged (`view.resize`) and the canvases follow the stage.
//
//   npm run build:server
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/save-robust.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import { ipadPage, checker, touchScript } from "./ipad.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT, { recursive: true });
const { check, failed } = checker();
const { Encrypter } = await import("age-encryption");

// ---- the box: the built server on a throwaway vault (as board/preview/box.ts), killed and restarted at will.
const home = mkdtempSync(join(tmpdir(), "vc-board-save-"));
const vault = join(home, "vault");
mkdirSync(join(vault, "notes"), { recursive: true });
writeFileSync(join(vault, "README.md"), "# Preview vault\n");
const git = (...a) => spawnSync("git", ["-c", "user.name=Preview", "-c", "user.email=preview@example.com", ...a], { cwd: vault });
git("init", "-q", "-b", "box");
git("add", "-A");
git("commit", "-q", "-m", "init");
const secrets = join(home, "secrets");
mkdirSync(secrets, { recursive: true });
const pass = "preview-passphrase-not-a-secret";
const enc = new Encrypter();
enc.setPassphrase(pass);
enc.setScryptWorkFactor(10);
writeFileSync(join(secrets, "fallback.key"), pass);
writeFileSync(join(secrets, "secrets.age"), Buffer.from(await enc.encrypt(JSON.stringify({ "api.openrouter": "preview-placeholder" }))).toString("base64"));
const port = Number(process.env.PORT) || (await new Promise((res) => {
  const srv = createNetServer().listen(0, "127.0.0.1", () => {
    const p = srv.address().port;
    srv.close(() => res(p));
  });
}));
const BASE = `http://127.0.0.1:${port}`;
let proc = null;
async function startBox() {
  const bundle = join(ROOT, "dist-server", "vault-chat-server.mjs");
  proc = spawn(process.execPath, [bundle], {
    cwd: dirname(bundle),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, HOME: home, USERPROFILE: home, VC_HOST: "127.0.0.1", VC_PORT: String(port), VC_VAULT: vault, VC_BARE_REPO: join(home, "none.git"), VC_SECRETS_DIR: secrets, VC_LOCALSTORAGE: join(home, "ls.json"), VC_PUSH_SUBS: join(home, "subs.json"), VC_TOKEN_FILE: join(home, "phone-token"), VC_STATE_DIR: join(home, "state"), VC_SYNC: "0", VC_ENGINE: "0" },
  });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  const t0 = Date.now();
  while (!out.includes("listening on")) {
    if (proc.exitCode !== null || Date.now() - t0 > 60_000) throw new Error(`the box did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const down = () => proc.exitCode !== null || proc.signalCode !== null;
const stopBox = async () => {
  if (!proc || down()) return;
  const p = proc;
  const gone = new Promise((r) => p.on("exit", r));
  p.kill("SIGKILL");
  await gone;
};
await startBox();

const boxBoard = async (slug) => (await fetch(`${BASE}/api/v1/boards/${slug}`)).json();
const boxIds = async (slug) => new Set((await boxBoard(slug)).strokes.map((s) => s.id));

// ---- the iPad
const { browser, ctx, page: first } = await ipadPage();
let page = first;
const logs = [];
// (WebKit reports a request cut off — the box killed, a held request dropped at a reload — as "… due to access
// control checks": the network failures these cases cause on purpose, not errors in the page.)
const watchErrors = (p) => p.on("pageerror", (e) => /due to access control checks/.test(e.message) || check(false, "no page error", e.message));
watchErrors(page);
// The board's log, read here (what the box's board.jsonl would get).
await ctx.route("**/api/v1/board/log", async (route) => {
  try {
    logs.push(...JSON.parse(route.request().postData() ?? "{}").events);
  } catch {}
  return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' });
});
const logged = async (ev, since = 0) => {
  await page.evaluate(() => window.__flushLog?.());
  return logs.slice(since).filter((e) => e.ev === ev);
};
await ctx.addInitScript(touchScript());
const url = `${BASE}/board`;
await page.goto(url);
const mk = (name) => page.evaluate(async (n) => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) })).json()).slug, name);
const open = async (s) => {
  await page.goto("about:blank");
  await page.goto(`${url}#/b/${s}`);
  await page.waitForFunction(() => !!window.__board?.debug, null, { timeout: 30_000 });
  await page.waitForTimeout(300);
};
const dbg = () => page.evaluate(() => window.__board.debug());
const ids = async () => new Set((await dbg()).strokesList.map((s) => s.id));
const saved = (timeout = 30_000) => page.waitForFunction(() => window.__board?.debug().status === "saved" && !window.__board.debug().dirty, null, { timeout });
let row = 0;
/** One Pencil stroke, each on its own line of the sheet. */
const pen = async () => {
  const y = 120 + (row % 22) * 26, x = 80 + Math.floor(row / 22) * 40;
  row++;
  await page.evaluate(([a, b]) => window.__pen(a, b, 120, 8), [[x, y], [x + 260, y + 6]]);
};
const statusText = () => page.evaluate(() => (document.querySelector(".tb-status")?.classList.contains("hidden") ? "" : document.querySelector(".tb-status")?.textContent ?? ""));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const SAVE_RE = /\/api\/v1\/boards\/[a-z0-9-]+(\?.*)?$/;
const isSave = (req) => req.method() === "POST" && SAVE_RE.test(new URL(req.url()).pathname);

// ======================================================================= 1. a save that never answers
{
  const slug = await mk(`Hang ${Date.now() % 100000}`);
  await open(slug);
  await pen();
  await saved();
  const before = logs.length;
  // From here every save is held open: never answered, never failed (the incident's request).
  const held = [];
  await page.route(SAVE_RE, (route) => (isSave(route.request()) ? held.push(route) : route.continue()));
  const t0 = Date.now();
  await pen();
  // The status while it hangs, every 0.5 s, until it shows.
  let shownAt = null;
  for (let i = 0; i < 30 && shownAt === null; i++) {
    await page.waitForTimeout(500);
    if ((await statusText()).includes("Not saved")) shownAt = Date.now() - t0;
  }
  check(shownAt !== null && shownAt >= 9_000 && shownAt <= 12_500, "hang: \"Not saved · retrying\" shows ~10 s after the change the box never acknowledged", `after ${shownAt} ms; status ${(await dbg()).status}`);
  await page.screenshot({ path: join(OUT, "save-robust-1-stalled.png") });
  check((await logged("save.stall", before)).length === 1, "hang: one save.stall logged", JSON.stringify((await logged("save.stall", before))[0] ?? null));
  // Writing goes on while the box never answers (the 24 minutes, in miniature): past the 20 s stall cut-off too.
  for (let i = 0; i < 12; i++) {
    await pen();
    await page.waitForTimeout(1500);
  }
  const fails = await logged("save.fail", before);
  check(fails.length >= 1 && fails.every((f) => f.status === 0), "hang: the held request is cut off as a failure after 20 s without progress, and retried", `${fails.length} save.fail, ${held.length} requests held; first: ${JSON.stringify(fails[0] ?? null)}`);
  check((await statusText()).includes("Not saved"), "hang: still \"Not saved · retrying\" while it never answers");
  const onPage = await ids();
  const d = await dbg();
  check(d.localGen === d.gen, "hang: the iPad's copy (IndexedDB) holds the newest edit", `gen ${d.gen}, on the device ${d.localGen}`);
  // The app is killed (iPadOS, or Carl exiting it) with the save still held, and opened again: a new page, the box
  // answering again. Nothing from the old page reached the box after the first stroke.
  check((await boxIds(slug)).size === 1, "hang: the box still has only the first stroke", `${(await boxIds(slug)).size}`);
  await page.close({ runBeforeUnload: false });
  page = await ctx.newPage();
  watchErrors(page);
  await page.goto(`${url}#/b/${slug}`);
  await page.waitForFunction(() => !!window.__board?.debug, null, { timeout: 30_000 });
  await saved();
  const after = await ids();
  const box = await boxIds(slug);
  check(sameSet(after, onPage) && onPage.size === 14, "hang: reopened, all 14 strokes on screen", `${after.size} of ${onPage.size}`);
  check(sameSet(box, onPage), "hang: and all 14 on the box", `${box.size} of ${onPage.size}`);
  check((await logged("local.recovered", before)).length === 1, "hang: the iPad's copy was sent on open (local.recovered)", JSON.stringify((await logged("local.recovered", before))[0] ?? null));
  await page.screenshot({ path: join(OUT, "save-robust-1-reopened.png") });
}

// ======================================================================= 2. the box restarts mid-save
{
  const slug = await mk(`Restart ${Date.now() % 100000}`);
  // A big board (like Carl's: thousands of strokes, MBs of JSON), so the save is in flight long enough to cut.
  const b = await boxBoard(slug);
  for (let i = 0; i < 9000; i++) {
    const xy = [];
    for (let k = 0; k < 24; k++) xy.push(2000 + (i % 90) * 12 + k * 0.7, 3000 + Math.floor(i / 90) * 14 + Math.sin(k) * 3);
    b.strokes.push({ id: `bulk${i}`, tool: "pen", color: "#1f1f24", w: 2.4, xy: xy.map((v) => Math.round(v * 100) / 100) });
  }
  const r = await fetch(`${BASE}/api/v1/boards/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board: b, base: b.rev }) });
  check(r.ok, "restart: a board of 9000 strokes on the box", `${(JSON.stringify(b).length / 1e6).toFixed(1)} MB`);
  await open(slug);
  await pen();
  await saved(60_000);
  const before = logs.length;
  // Kill the box the moment the next save's request goes out (its body still uploading or being written).
  let killed = false;
  const onReq = (req) => {
    if (!killed && isSave(req)) {
      killed = true;
      void stopBox();
    }
  };
  page.on("request", onReq);
  await pen();
  for (let i = 0; i < 300 && !(killed && down()); i++) await page.waitForTimeout(100);
  page.off("request", onReq);
  check(killed && down(), "restart: the box was killed while the save was in flight");
  // Writing on while it is down.
  for (let i = 0; i < 5; i++) {
    await pen();
    await page.waitForTimeout(700);
  }
  await startBox();
  await saved(60_000);
  const onPage = await ids();
  const box = await boxIds(slug);
  const d = await dbg();
  check(sameSet(box, onPage) && onPage.size === 9007, "restart: every stroke (9000 + 7) reached the box once it was back", `${box.size} on the box, ${onPage.size} on the iPad`);
  check(d.status === "saved" && (await logged("save.conflict", before)).length === 0, "restart: saved, no \"changed elsewhere\"", d.status);
  console.log(`     restart: ${(await logged("save.fail", before)).length} failed tries while it was down`);
}

// ======================================================================= 3. the save lands, its answer is lost
{
  const slug = await mk(`Lost ${Date.now() % 100000}`);
  await open(slug);
  await pen();
  await saved();
  const before = logs.length;
  let n = 0;
  await page.route(SAVE_RE, async (route) => {
    if (!isSave(route.request()) || n++ > 0) return route.continue();
    await route.fetch(); // the box writes it…
    return route.abort("connectionreset"); // …and the answer never arrives
  });
  await pen();
  await page.waitForTimeout(800);
  await pen();
  await saved(20_000);
  await page.unroute(SAVE_RE);
  const box = await boxIds(slug);
  check(sameSet(box, await ids()) && box.size === 3, "lost answer: the resend from the same base is taken, all 3 strokes on the box", `${box.size}`);
  check((await logged("save.conflict", before)).length === 0 && (await dbg()).status === "saved", "lost answer: no \"changed elsewhere\" for the iPad's own save");
}

// ======================================================================= 4. a save that fails outright
{
  const slug = await mk(`Fail ${Date.now() % 100000}`);
  await open(slug);
  const before = logs.length;
  await page.route(SAVE_RE, (route) => (isSave(route.request()) ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"disk full"}' }) : route.continue()));
  const t0 = Date.now();
  await pen();
  await page.waitForFunction(() => /Not saved/.test(document.querySelector(".tb-status")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
  const failAt = Date.now() - t0;
  check((await statusText()).includes("Not saved") && failAt < 3000, "fail: a 500 shows \"Not saved · retrying\" at once", `${await statusText()} after ${failAt} ms`);
  await page.screenshot({ path: join(OUT, "save-robust-4-failed.png") });
  await page.unroute(SAVE_RE);
  await saved(15_000);
  check((await boxIds(slug)).size === 1 && (await statusText()) === "", "fail: the retry saves it once the box answers, the status goes", `${(await logged("save.fail", before)).length} save.fail`);
}

// ======================================================================= 5. reload with unsaved work
{
  const slug = await mk(`Reload ${Date.now() % 100000}`);
  await open(slug);
  await pen();
  await saved();
  // Saves held open, so nothing reaches the box; reload 0.4 s after the pen lifts (the iPad's copy is that quick).
  await page.route(SAVE_RE, (route) => (isSave(route.request()) ? undefined : route.continue()));
  await pen();
  await pen();
  await page.waitForTimeout(450);
  const onPage = await ids();
  check((await boxIds(slug)).size === 1, "reload: the box has 1 of 3 strokes before the reload");
  await page.unroute(SAVE_RE);
  await page.reload();
  await page.waitForFunction(() => !!window.__board?.debug, null, { timeout: 30_000 });
  await saved();
  check(sameSet(await ids(), onPage) && sameSet(await boxIds(slug), onPage), "reload: all 3 strokes back on screen and on the box", `${(await boxIds(slug)).size}`);
}

// ======================================================================= 6. unsaved work and a change elsewhere
{
  const slug = await mk(`Conflict ${Date.now() % 100000}`);
  await open(slug);
  await pen();
  await saved();
  await page.route(SAVE_RE, (route) => (isSave(route.request()) ? undefined : route.continue()));
  await pen();
  await page.waitForTimeout(700);
  const mine = await ids();
  // Another device saves the board meanwhile (one stroke of its own).
  const b = await boxBoard(slug);
  b.strokes.push({ id: "other", tool: "pen", color: "#d00", w: 3, xy: [10, 10, 400, 400] });
  await fetch(`${BASE}/api/v1/boards/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board: b, base: b.rev }) });
  await page.unroute(SAVE_RE);
  let asked = "";
  page.once("dialog", (d) => ((asked = d.message()), d.accept()));
  await page.reload();
  await page.waitForFunction(() => !!window.__board?.debug, null, { timeout: 30_000 });
  await saved();
  check(/never reached the box/.test(asked), "conflict: Carl is asked which version to keep", asked.split("\n")[0]);
  check(sameSet(await boxIds(slug), mine), "conflict: \"keep this iPad's\" puts the iPad's 2 strokes on the box");
}

// ======================================================================= 7. geometry
{
  const before = logs.length;
  await page.setViewportSize({ width: 834, height: 1194 }); // turned upright
  await page.waitForTimeout(500);
  const g = await page.evaluate(() => {
    const st = document.querySelector(".stage").getBoundingClientRect(), c = document.querySelector("canvas.base");
    return { stage: [st.width, st.height], canvas: [c.width, c.height], dpr: devicePixelRatio };
  });
  const lines = await logged("view.resize", before);
  check(lines.length >= 1 && lines.at(-1).W === g.stage[0] && lines.at(-1).H === g.stage[1], "geometry: a size change is logged (view.resize: W, H, dpr, cam, visualViewport)", JSON.stringify(lines.at(-1) ?? null));
  check(g.canvas[0] === Math.round(g.stage[0] * g.dpr) && g.canvas[1] === Math.round(g.stage[1] * g.dpr), "geometry: the canvases follow the stage", JSON.stringify(g));
}

await browser.close();
await stopBox();
try {
  rmSync(home, { recursive: true, force: true });
} catch {}
console.log(failed() ? `${failed()} FAILED` : "all passed");
process.exit(failed() ? 1 : 0);
