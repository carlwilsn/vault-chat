// A headless Chromium for the board inbox's checks (server/inbox.ts): a
// widget must mount without throwing, and a widget or a typeset math part gets
// a PNG snapshot (what the agent sees, and what the board's overview draws).
//
// The page is a local file with CSP `default-src 'none'` (inline script and
// style only): nothing it runs can reach the network. One warm browser serves
// every check (a fresh browser context and tab each, driven over the DevTools
// protocol; it stops after 2 min idle and with this process), and a browser of
// its own per check is the fallback: the page's verdict (the harness writes it
// into #vc-result) and a 2× PNG.
//
// The browser: $VC_HEADLESS_BROWSER, else chromium / google-chrome / chrome /
// msedge on PATH, the Nix store, or the usual Windows and macOS locations.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

let found: string | null | undefined;
/** The browser binary, or null when there is none (cached; `fresh` looks again). */
export function findBrowser(fresh = false): string | null {
  if (found !== undefined && !fresh) return found;
  const env = process.env.VC_HEADLESS_BROWSER;
  if (env !== undefined) return (found = env && isFile(env) ? env : null);
  const names = process.platform === "win32" ? ["chrome.exe", "msedge.exe", "chromium.exe"] : ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "chrome", "microsoft-edge"];
  for (const d of (process.env.PATH ?? "").split(delimiter)) for (const n of names) if (d && isFile(join(d, n))) return (found = join(d, n));
  const fixed =
    process.platform === "win32"
      ? [
          join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
          join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        : ["/run/current-system/sw/bin/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
  for (const p of fixed) if (isFile(p)) return (found = p);
  if (process.platform === "linux") {
    try {
      const hit = readdirSync("/nix/store")
        .filter((n) => /-chromium-\d[\d.]*$/.test(n))
        .map((n) => join("/nix/store", n, "bin", "chromium"))
        .filter(isFile)
        .sort()
        .pop();
      if (hit) return (found = hit);
    } catch {
      /* no store */
    }
  }
  return (found = null);
}

function flags(profile: string, w: number, h: number): string[] {
  return [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--mute-audio",
    "--hide-scrollbars",
    ...(process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    `--user-data-dir=${profile}`,
    `--window-size=${Math.round(w)},${Math.round(h)}`,
    "--remote-debugging-port=0",
    "about:blank",
  ];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The browser, started; a failed spawn shows up as a DevTools port that never comes, never as a crash. */
function launch(bin: string, profile: string, w: number, h: number): ChildProcess {
  const p = spawn(bin, flags(profile, w, h), { windowsHide: true, stdio: "ignore" });
  p.on("error", () => {});
  return p;
}

/** The DevTools port (and the browser's websocket path) a browser started with `--remote-debugging-port=0` wrote into its profile. */
async function devtoolsPort(profile: string, deadline: number): Promise<{ port: number; path: string }> {
  for (;;) {
    // Looked at before the deadline is: a wait that overran (this process was busy) still sees a port
    // the browser wrote in time, instead of killing a browser that started fine and launching another.
    try {
      const [p, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/);
      if (Number(p)) return { port: Number(p), path: path ?? "" };
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error("the headless browser did not start");
    await sleep(100);
  }
}

/** One DevTools websocket: calls (each bounded by `deadline`), events, and flat sessions on a browser-level socket. */
class Conn {
  private seq = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private listeners = new Map<string, ((p: any) => void)[]>();
  closed = false;
  /** Called once when the socket closes (the browser went away). */
  onClosed: (() => void) | null = null;
  private constructor(private ws: WebSocket) {
    ws.onmessage = (m) => {
      let msg: any;
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
      } else if (msg.method) for (const fn of this.listeners.get(`${msg.sessionId ?? ""}|${msg.method}`) ?? []) fn(msg.params);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.rej(new Error("the headless browser went away"));
      this.pending.clear();
      this.onClosed?.();
    };
  }
  static open(url: string): Promise<Conn> {
    const ws = new WebSocket(url);
    return new Promise((res, rej) => {
      ws.onopen = () => res(new Conn(ws));
      ws.onerror = () => rej(new Error("could not reach the headless browser"));
    });
  }
  call(method: string, params: object = {}, sessionId?: string, deadline = Date.now() + 45_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("the headless browser went away"));
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`the page did not answer in time (${method})`));
      }, Math.max(1, deadline - Date.now()));
      t.unref?.();
      this.pending.set(id, { res: (v) => (clearTimeout(t), res(v)), rej: (e) => (clearTimeout(t), rej(e)) });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(ev: string, fn: (p: any) => void, sessionId?: string): void {
    const k = `${sessionId ?? ""}|${ev}`;
    this.listeners.set(k, [...(this.listeners.get(k) ?? []), fn]);
  }
  /** Drop a session's listeners (its target is gone). */
  forget(sessionId: string): void {
    for (const k of [...this.listeners.keys()]) if (k.startsWith(`${sessionId}|`)) this.listeners.delete(k);
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* gone */
    }
  }
}

type Page = { call: (method: string, params?: object) => Promise<any>; on: (ev: string, fn: (p: any) => void) => void };

export type HeadlessResult = { verdict: string | null; png: Buffer | null };
export type HeadlessOpts = { w: number; h: number; budgetMs?: number; shot?: boolean | ((verdict: string | null) => number | null); timeoutMs?: number };

/** Load the page file in `page` (a tab): its #vc-result verdict and, unless `shot` says not, a 2× PNG. */
async function runPage(page: Page, file: string, o: HeadlessOpts): Promise<HeadlessResult> {
  await page.call("Emulation.setDeviceMetricsOverride", { width: Math.round(o.w), height: Math.round(o.h), deviceScaleFactor: 2, mobile: false });
  await page.call("Page.enable");
  const loaded = new Promise<void>((res) => page.on("Page.loadEventFired", () => res()));
  await page.call("Page.navigate", { url: pathToFileURL(file).href });
  await Promise.race([loaded, sleep(10_000)]);
  const read = async () => (await page.call("Runtime.evaluate", { expression: "(function(){var e=document.getElementById('vc-result');return e&&e.textContent?e.textContent:null})()", returnByValue: true }))?.result?.value ?? null;
  const until = Date.now() + (o.budgetMs ?? 1500);
  let verdict: string | null = await read();
  while (verdict === null && Date.now() < until) {
    await sleep(50);
    verdict = await read();
  }
  if (verdict !== null) {
    await sleep(250); // an error thrown on the first frames after mount
    verdict = await read();
  }
  let png: Buffer | null = null;
  const shotH = typeof o.shot === "function" ? o.shot(verdict) : o.shot === false ? null : o.h;
  if (shotH) {
    await page.call("Emulation.setDeviceMetricsOverride", { width: Math.round(o.w), height: Math.round(shotH), deviceScaleFactor: 2, mobile: false });
    await sleep(60);
    const r = await page.call("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: Math.round(o.w), height: Math.round(shotH), scale: 1 } });
    png = r?.data ? Buffer.from(r.data, "base64") : null;
  }
  return { verdict, png };
}

// ---------------------------------------------------------------- the warm browser
//
// One long-lived browser, started on the first check and reused: each check is
// a fresh browser context (its own storage) with one tab, disposed after. It
// stops after WARM_IDLE_MS without a check, and with this process; one that
// dies is started again on the next check. When the warm path fails, the check
// runs on a browser of its own (the one-shot path below).

/** `pid`: the browser's own process (on Windows the launcher we started may have handed off to it and exited). */
type Warm = { proc: ChildProcess; pid: number | null; conn: Conn; dir: string; active: number; idle: ReturnType<typeof setTimeout> | null };

/**
 * Kill a process and everything it started: `taskkill /F /T` on Windows (a browser is a tree of processes, and a
 * signal reaches only the one), SIGKILL elsewhere. A process already gone (ESRCH, taskkill's "not found") is fine.
 * Not waited for: taskkill /T takes seconds on Windows (7 s measured under the server tests), and waiting on it
 * stalled this whole process — a new browser's DevTools port then went unread past its deadline, and a browser
 * that had started fine was killed and launched again.
 */
export function killProcessTree(pid: number | null | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    const k = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    k.on("error", () => {});
    k.unref();
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}

/** The same, waited for: only where nothing runs afterwards (this process exiting). */
function killProcessTreeSync(pid: number | null | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
  else killProcessTree(pid);
}
let warmP: Promise<Warm> | null = null;
let warmNow: Warm | null = null;
let pageSeq = 0;
/** The warm browser's window (each check sets its own viewport). */
const WIDGET_W = 640, WIDGET_H = 480;
/** How long the warm browser outlives its last check (ms). */
const WARM_IDLE_MS = Number(process.env.VC_HEADLESS_IDLE_MS) || 120_000;
/** Launches and checks since this process started (the tests read them). */
/** `retries`: second launches after a first start that never opened its DevTools port (counted in `launches` too). */
export const headlessStats = { launches: 0, retries: 0, warmChecks: 0, oneShotChecks: 0, warmFailures: 0 };

function killWarm(w: Warm): void {
  if (w.idle) clearTimeout(w.idle);
  if (warmNow === w) {
    warmNow = null;
    warmP = null;
  }
  w.conn.call("Browser.close", {}, undefined, Date.now() + 1000).catch(() => {});
  setTimeout(() => {
    w.conn.close();
    try {
      w.proc.kill("SIGKILL");
    } catch {
      /* gone */
    }
    // The browser itself (on Windows not the launcher we started), and its helpers.
    if (w.pid && w.pid !== w.proc.pid) {
      try {
        killProcessTree(w.pid);
      } catch {
        /* gone */
      }
    }
    // Not rmSync: a browser profile is hundreds of files, and this process serves requests meanwhile.
    void rm(w.dir, { recursive: true, force: true }).catch(() => {});
  }, 300).unref?.();
}

let exitHooked = false;
async function startWarm(bin: string): Promise<Warm> {
  const dir = mkdtempSync(join(tmpdir(), "vc-headless-warm-"));
  headlessStats.launches++;
  let proc = launch(bin, join(dir, "profile"), WIDGET_W, WIDGET_H);
  try {
    // A cold first start sometimes never opens its DevTools port (seen on Windows): one more launch, on a fresh
    // profile, after a few seconds rather than the whole wait.
    let found: { port: number; path: string };
    try {
      found = await devtoolsPort(join(dir, "profile"), Date.now() + 6_000);
    } catch {
      proc.kill("SIGKILL");
      headlessStats.launches++;
      headlessStats.retries++;
      proc = launch(bin, join(dir, "profile2"), WIDGET_W, WIDGET_H);
      found = await devtoolsPort(join(dir, "profile2"), Date.now() + 15_000);
    }
    const { port, path } = found;
    const url = path ? `ws://127.0.0.1:${port}${path}` : (((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as any).webSocketDebuggerUrl as string);
    const conn = await Conn.open(url);
    // The browser's own process id (SystemInfo: the "browser" process), else the one we started.
    let pid: number | null = proc.pid ?? null;
    try {
      const info = await conn.call("SystemInfo.getProcessInfo", {}, undefined, Date.now() + 3000);
      const b = (info?.processInfo ?? []).find((p: { type?: string; id?: number }) => p.type === "browser");
      if (typeof b?.id === "number" && b.id > 0) pid = b.id;
    } catch {
      /* an older browser: the launcher's */
    }
    const w: Warm = { proc, pid, conn, dir, active: 0, idle: null };
    // On Windows the launcher may hand off and exit 0: the socket closing is what says the browser is gone.
    const gone = () => {
      if (warmNow === w) killWarm(w);
    };
    proc.on("exit", (code) => code !== 0 && gone());
    conn.onClosed = gone;
    if (!exitHooked) {
      exitHooked = true;
      process.on("exit", () => {
        try {
          warmNow?.proc.kill("SIGKILL");
          if (warmNow?.pid && warmNow.pid !== warmNow.proc.pid) killProcessTreeSync(warmNow.pid);
        } catch {
          /* gone */
        }
      });
    }
    return w;
  } catch (e) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* gone */
    }
    setTimeout(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS cleans tmp */
      }
    }, 500).unref?.();
    throw e;
  }
}

function warmBrowser(bin: string): Promise<Warm> {
  if (warmNow && warmNow.conn.closed) killWarm(warmNow);
  return (warmP ??= startWarm(bin).then(
    (w) => (warmNow = w),
    (e) => {
      warmP = null;
      throw e;
    },
  ));
}

/** Start the warm browser ahead of a check that is coming (a make began, a send arrived); its idle clock runs. */
export function warmUp(): void {
  const bin = findBrowser();
  if (!bin || process.env.VC_HEADLESS_WARM === "0") return;
  warmBrowser(bin).then(
    (w) => {
      if (w.active === 0 && !w.idle && warmNow === w) {
        w.idle = setTimeout(() => killWarm(w), WARM_IDLE_MS);
        w.idle.unref?.();
      }
    },
    () => {},
  );
}

/** Stop the warm browser now (tests; a server that wants it gone). */
export function stopWarmBrowser(): void {
  if (warmNow) killWarm(warmNow);
}

/** The warm browser's process id, or null (tests). */
export const warmBrowserPid = (): number | null => warmNow?.pid ?? warmNow?.proc.pid ?? null;

async function warmCheck(bin: string, html: string, o: HeadlessOpts): Promise<HeadlessResult> {
  const w = await warmBrowser(bin);
  w.active++;
  if (w.idle) clearTimeout(w.idle);
  w.idle = null;
  const deadline = Date.now() + (o.timeoutMs ?? 45_000);
  const file = join(w.dir, `page-${++pageSeq}.html`);
  let ctxId: string | null = null;
  let sessionId: string | null = null;
  try {
    writeFileSync(file, html);
    ctxId = (await w.conn.call("Target.createBrowserContext", {}, undefined, deadline)).browserContextId;
    const { targetId } = await w.conn.call("Target.createTarget", { url: "about:blank", browserContextId: ctxId, width: Math.round(o.w), height: Math.round(o.h) }, undefined, deadline);
    sessionId = (await w.conn.call("Target.attachToTarget", { targetId, flatten: true }, undefined, deadline)).sessionId as string;
    const sid = sessionId;
    const r = await runPage({ call: (m, p) => w.conn.call(m, p, sid, deadline), on: (ev, fn) => w.conn.on(ev, fn, sid) }, file, o);
    headlessStats.warmChecks++;
    return r;
  } finally {
    if (sessionId) w.conn.forget(sessionId);
    if (ctxId) await w.conn.call("Target.disposeBrowserContext", { browserContextId: ctxId }, undefined, Date.now() + 3000).catch(() => {});
    try {
      rmSync(file, { force: true });
    } catch {
      /* tmp */
    }
    w.active--;
    if (w.active === 0 && warmNow === w) {
      w.idle = setTimeout(() => killWarm(w), WARM_IDLE_MS);
      w.idle.unref?.();
    }
  }
}

// ---------------------------------------------------------------- one browser per check (the fallback)

/** A DevTools connection to the first page of a browser started on `profile`. */
async function connectPage(profile: string, deadline: number): Promise<Conn> {
  const { port } = await devtoolsPort(profile, deadline);
  let page: any = null;
  while (!page) {
    if (Date.now() > deadline) throw new Error("the headless browser has no page");
    try {
      page = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]).find((t) => t.type === "page");
    } catch {
      /* not yet */
    }
    if (!page) await sleep(100);
  }
  return Conn.open(page.webSocketDebuggerUrl);
}

async function oneShot(bin: string, html: string, o: HeadlessOpts): Promise<HeadlessResult> {
  const dir = mkdtempSync(join(tmpdir(), "vc-headless-"));
  const deadline = Date.now() + (o.timeoutMs ?? 45_000);
  headlessStats.launches++;
  let proc = launch(bin, join(dir, "profile"), o.w, o.h);
  let cdp: Conn | null = null;
  try {
    const page = join(dir, "page.html");
    writeFileSync(page, html);
    // Not raced against the launcher exiting: on Windows msedge.exe hands off to its browser process and exits 0.
    // A cold first start sometimes never opens its DevTools port: one more launch, on a fresh profile.
    try {
      cdp = await connectPage(join(dir, "profile"), Math.min(deadline, Date.now() + 15_000));
    } catch {
      proc.kill("SIGKILL");
      headlessStats.launches++;
      headlessStats.retries++;
      proc = launch(bin, join(dir, "profile2"), o.w, o.h);
      cdp = await connectPage(join(dir, "profile2"), deadline);
    }
    const c = cdp;
    const r = await runPage({ call: (m, p) => c.call(m, p, undefined, deadline), on: (ev, fn) => c.on(ev, fn) }, page, o);
    headlessStats.oneShotChecks++;
    return r;
  } finally {
    await cdp?.call("Browser.close", {}, undefined, Date.now() + 1000).catch(() => {});
    cdp?.close();
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* gone */
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS cleans tmp */
      }
    }, 500).unref?.();
  }
}

/**
 * Load `html` (a whole document) at w×h css px: the text of its #vc-result
 * element once it reports (up to `budgetMs`, plus a moment for errors that
 * come right after mount), and (unless `shot` is false) a PNG at 2× of the
 * first `shotH` px (default h). On the warm browser; on one of its own when
 * that fails (or `VC_HEADLESS_WARM=0`). Throws when there is no browser.
 */
export async function headless(html: string, o: HeadlessOpts): Promise<HeadlessResult> {
  const bin = findBrowser();
  if (!bin) throw new Error("no headless browser on this box (install Chromium, or set VC_HEADLESS_BROWSER)");
  if (process.env.VC_HEADLESS_WARM !== "0") {
    try {
      return await warmCheck(bin, html, o);
    } catch (e) {
      // A page that hangs is the page's fault: no second browser for it.
      if (/did not answer in time/.test(String((e as Error)?.message)) && !warmNow?.conn.closed) throw e;
      headlessStats.warmFailures++;
      // A browser that went away is started afresh next time; this check runs on one of its own.
      if (warmNow?.conn.closed) killWarm(warmNow);
    }
  }
  return oneShot(bin, html, o);
}

/**
 * A browser of its own with one page, for a caller that drives the page itself (server/recordUI.ts): `call` and
 * `on` speak to that page over the DevTools protocol; `close` ends the browser and removes its profile. Muted,
 * headless, the same flags as every check here.
 */
export async function openPage(w: number, h: number, timeoutMs = 30_000): Promise<{ call: (method: string, params?: object, deadlineMs?: number) => Promise<any>; on: (ev: string, fn: (p: any) => void) => void; close: () => Promise<void> }> {
  const bin = findBrowser();
  if (!bin) throw new Error("no headless browser on this machine (install Chromium, or set VC_HEADLESS_BROWSER)");
  const dir = mkdtempSync(join(tmpdir(), "vc-page-"));
  const deadline = Date.now() + timeoutMs;
  let proc = launch(bin, join(dir, "profile"), w, h);
  let cdp: Conn;
  try {
    try {
      cdp = await connectPage(join(dir, "profile"), Math.min(deadline, Date.now() + 15_000));
    } catch {
      proc.kill("SIGKILL");
      proc = launch(bin, join(dir, "profile2"), w, h);
      cdp = await connectPage(join(dir, "profile2"), deadline);
    }
  } catch (e) {
    proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const c = cdp;
  return {
    call: (m, p, ms = 45_000) => c.call(m, p ?? {}, undefined, Date.now() + ms),
    on: (ev, fn) => c.on(ev, fn),
    close: async () => {
      await c.call("Browser.close", {}, undefined, Date.now() + 1000).catch(() => {});
      c.close();
      try {
        proc.kill("SIGKILL");
      } catch {
        /* gone */
      }
      await sleep(300);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
