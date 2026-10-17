// A headless Chromium for the board inbox's checks (server/inbox.ts): a
// widget must mount without throwing, and a widget or a typeset math part gets
// a PNG snapshot (what the agent sees, and what the board's overview draws).
//
// The page is a local file with CSP `default-src 'none'` (inline script and
// style only): nothing it runs can reach the network. One launch of the browser
// per check, driven over the DevTools protocol, with a throwaway profile: the
// page's verdict (the harness writes it into #vc-result) and a 2× PNG.
//
// The browser: $VC_HEADLESS_BROWSER, else chromium / google-chrome / chrome /
// msedge on PATH, the Nix store, or the usual Windows and macOS locations.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** A DevTools connection to the browser's first page. */
async function connect(profile: string, deadline: number): Promise<{ call: (method: string, params?: object) => Promise<any>; on: (ev: string, fn: (p: any) => void) => void; close: () => void }> {
  let port = 0;
  while (!port) {
    if (Date.now() > deadline) throw new Error("the headless browser did not start");
    try {
      port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]) || 0;
    } catch {
      /* not yet */
    }
    if (!port) await sleep(100);
  }
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
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("could not reach the headless browser"));
  });
  let seq = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  const listeners = new Map<string, ((p: any) => void)[]>();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message));
      else p.res(msg.result);
    } else if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  };
  return {
    call: (method, params = {}) =>
      new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    on: (ev, fn) => listeners.set(ev, [...(listeners.get(ev) ?? []), fn]),
    close: () => ws.close(),
  };
}

export type HeadlessResult = { verdict: string | null; png: Buffer | null };

/**
 * Load `html` (a whole document) at w×h css px: the text of its #vc-result
 * element once it reports (up to `budgetMs`, plus a moment for errors that
 * come right after mount), and (unless `shot` is false) a PNG at 2× of the
 * first `shotH` px (default h). Throws when there is no browser.
 */
export async function headless(html: string, o: { w: number; h: number; budgetMs?: number; shot?: boolean | ((verdict: string | null) => number | null); timeoutMs?: number }): Promise<HeadlessResult> {
  const bin = findBrowser();
  if (!bin) throw new Error("no headless browser on this box (install Chromium, or set VC_HEADLESS_BROWSER)");
  const dir = mkdtempSync(join(tmpdir(), "vc-headless-"));
  const deadline = Date.now() + (o.timeoutMs ?? 45_000);
  let proc = spawn(bin, flags(join(dir, "profile"), o.w, o.h), { windowsHide: true, stdio: "ignore" });
  let cdp: Awaited<ReturnType<typeof connect>> | null = null;
  try {
    const page = join(dir, "page.html");
    writeFileSync(page, html);
    // Not raced against the launcher exiting: on Windows msedge.exe hands off to its browser process and exits 0.
    // A cold first start sometimes never opens its DevTools port: one more launch, on a fresh profile.
    try {
      cdp = await connect(join(dir, "profile"), Math.min(deadline, Date.now() + 15_000));
    } catch {
      proc.kill("SIGKILL");
      proc = spawn(bin, flags(join(dir, "profile2"), o.w, o.h), { windowsHide: true, stdio: "ignore" });
      cdp = await connect(join(dir, "profile2"), deadline);
    }
    await cdp.call("Emulation.setDeviceMetricsOverride", { width: Math.round(o.w), height: Math.round(o.h), deviceScaleFactor: 2, mobile: false });
    await cdp.call("Page.enable");
    const loaded = new Promise<void>((res) => cdp!.on("Page.loadEventFired", () => res()));
    await cdp.call("Page.navigate", { url: pathToFileURL(page).href });
    await Promise.race([loaded, sleep(10_000)]);
    const read = async () => (await cdp!.call("Runtime.evaluate", { expression: "(function(){var e=document.getElementById('vc-result');return e&&e.textContent?e.textContent:null})()", returnByValue: true }))?.result?.value ?? null;
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
      await cdp.call("Emulation.setDeviceMetricsOverride", { width: Math.round(o.w), height: Math.round(shotH), deviceScaleFactor: 2, mobile: false });
      await sleep(60);
      const r = await cdp.call("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: Math.round(o.w), height: Math.round(shotH), scale: 1 } });
      png = r?.data ? Buffer.from(r.data, "base64") : null;
    }
    return { verdict, png };
  } finally {
    try {
      await cdp?.call("Browser.close").catch(() => {});
    } catch {
      /* gone */
    }
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
