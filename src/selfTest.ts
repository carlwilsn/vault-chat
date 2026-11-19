// Self-test mode (src-tauri/src/self_test.rs): the real built app drives itself, with no box, so CI on a fresh
// machine can check the artifact that ships. Only the launch environment turns it on (VC_SELFTEST=<steps.json>):
// the main window asks the native side for the steps (`selftest_config`, null in every normal launch), opens the
// vault they name (or a fresh temp one: as any vault with no box, that starts the app's own local server), runs the
// steps with the Drive step engine (src/driveSteps.ts) in this window — writable, unlike the Drive copy — and hands
// the outcome to `selftest_finish`, which writes the results JSON and exits 0 or 1.
//
// Steps file: `{"vault"?: "/path", "pace"?: ms, "steps": [...]}` or just the list. `pace`: a pause after every step,
// so a recording of the run can be followed (at most 5 s). Each step is a Drive step
// (click/hover/rightClick/type/press/wait/waitFor/scroll/drag/select), `shot` (a no-op here: native screenshots are
// taken outside the app, e.g. screencapture on macOS), `{closeWindow: "<label>"}` (closes another window of the app,
// e.g. the chat popout "chat-popout", as its close button would), or one check. Any step may carry `"label": "…"`, a
// name for it in the results.
//   {expect: {health: "server", timeout?}}             the app's local server answers /api/v1/health (default 90 s)
//   {expect: {text: "…", timeout?}}                     the window shows that text (default 5 s)
//   {expect: {file: "rel/path", contains?: "…", timeout?}}  that file is on disk in the vault (with that text; a binary
//                                                        file such as a PDF counts as there, with no text)
//   {expect: {notText: "…"}}                            the window does NOT show that text (checked once)
//   {expect: {status: {…}, timeout?}}                   the app's status file (src-tauri/src/first_run.rs) holds these
//                                                        values (nested objects match in part; "$vault" = the vault)
//   {expect: {key: "service.x", sha256: "<hex>", timeout?}}  the key store holds a value with that SHA-256 under that
//                                                        name; only match / no match is ever reported, never the value
//   {expect: {noFile: "rel/path", timeout?}}             that file is no longer on disk in the vault
//   {expect: {gone: "css", timeout?}}                    nothing visible matches that selector (any more)
//   {expect: {window: "<label>", open: true|false, timeout?}}  the app's window with that label is open / closed
//   {expect: {clear: "traffic-lights", timeout?}}       nothing visible (text, a control, an icon) is under the macOS
//                                                        traffic lights (src/macChrome.ts); passes, saying so, elsewhere
import { isMac, TRAFFIC_LIGHTS_RECT, firstHeaderText, underTrafficLights } from "./macChrome";
import { checkSteps, find, runSteps, stepAction, visibleText, type Step, type StepOutcome } from "./driveSteps";

export type Expect =
  | { health: "server"; timeout?: number }
  | { text: string; timeout?: number }
  | { file: string; contains?: string; timeout?: number }
  | { notText: string; timeout?: number }
  | { status: Record<string, unknown>; timeout?: number }
  | { key: string; sha256: string; timeout?: number }
  | { noFile: string; timeout?: number }
  | { gone: string; timeout?: number }
  | { window: string; open: boolean; timeout?: number }
  | { clear: "traffic-lights"; timeout?: number };
export type SelfTestStep = (Step | { expect: Expect } | { closeWindow: string }) & { label?: string };
export type SelfTestPlan = { vault?: string; pace?: number; steps: SelfTestStep[] };
export type SelfTestConfig = { steps: unknown; out: string; vault: string; tempVault?: boolean };
export type SelfTestResult = {
  schema: 1;
  ok: boolean;
  error?: string;
  vault?: string;
  steps: StepOutcome[];
  errors: string[];
  text: string;
  ms: number;
};

export const SELFTEST_MAX_STEPS = 200;
const MAX_WAIT_MS = 180_000;

/** The steps file, checked: the list of steps (and the vault it names), or why not. */
export function parseSelfTest(raw: unknown): SelfTestPlan | string {
  const obj = Array.isArray(raw) ? { steps: raw } : raw;
  if (!obj || typeof obj !== "object") return "the steps file must be a list of steps or {steps: [...]}";
  const { steps, vault, pace } = obj as { steps?: unknown; vault?: unknown; pace?: unknown };
  if (vault !== undefined && typeof vault !== "string") return "vault must be a path";
  if (pace !== undefined && !(typeof pace === "number" && pace >= 0 && pace <= 5000)) return "pace is 0-5000 ms";
  if (!Array.isArray(steps) || !steps.length) return "steps must be a non-empty list";
  if (steps.length > SELFTEST_MAX_STEPS) return `at most ${SELFTEST_MAX_STEPS} steps`;
  for (const [i, s] of steps.entries()) {
    const why = checkStep(s);
    if (why) return `step ${i + 1}: ${why}`;
  }
  return { ...(vault ? { vault } : {}), ...(pace ? { pace } : {}), steps: steps as SelfTestStep[] };
}

/** The step without its label. */
function bare(s: SelfTestStep): SelfTestStep {
  if (!("label" in s)) return s;
  const { label: _label, ...rest } = s;
  return rest as SelfTestStep;
}

function checkStep(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return "not an object";
  const label = (raw as { label?: unknown }).label;
  if (label !== undefined && !(typeof label === "string" && label.trim())) return "label needs text";
  const s = bare(raw as SelfTestStep);
  if ("closeWindow" in s) {
    if (Object.keys(s).length !== 1) return "closeWindow is a step of its own";
    return typeof s.closeWindow === "string" && /^[\w-]+$/.test(s.closeWindow) ? null : "closeWindow needs a window label";
  }
  if ("expect" in s) {
    if (Object.keys(s).length !== 1) return "expect is a step of its own";
    const e = (s as { expect: unknown }).expect;
    if (!e || typeof e !== "object") return "expect needs {health}, {text} or {file}";
    const o = e as Record<string, unknown>;
    if (o.timeout !== undefined && !(typeof o.timeout === "number" && o.timeout > 0 && o.timeout <= MAX_WAIT_MS)) return `timeout is at most ${MAX_WAIT_MS} ms`;
    const kinds = ["health", "text", "file", "notText", "status", "key", "noFile", "gone", "window", "clear"].filter((k) => k in o);
    if (kinds.length !== 1) return "expect needs exactly one of health, text, file, notText, status, key, noFile, gone, window, clear";
    if ("clear" in o && o.clear !== "traffic-lights") return 'expect.clear is "traffic-lights"';
    if ("gone" in o && !(typeof o.gone === "string" && o.gone.trim())) return "expect.gone needs a CSS selector";
    if ("window" in o && !(typeof o.window === "string" && /^[\w-]+$/.test(o.window) && typeof o.open === "boolean")) return "expect.window needs a window label and open: true or false";
    if ("noFile" in o && !(typeof o.noFile === "string" && o.noFile.trim() && !o.noFile.startsWith("/") && !/^[a-z]:/i.test(o.noFile) && !o.noFile.split(/[\\/]/).includes(".."))) return "expect.noFile needs a vault-relative path inside the vault";
    if ("notText" in o && !(typeof o.notText === "string" && o.notText.trim())) return "expect.notText needs text";
    if ("status" in o && !(o.status && typeof o.status === "object" && !Array.isArray(o.status))) return "expect.status needs an object of values";
    if ("key" in o && !(typeof o.key === "string" && o.key.trim() && typeof o.sha256 === "string" && /^[0-9a-f]{64}$/.test(o.sha256))) return "expect.key needs a key name and a sha256 (64 hex digits)";
    if ("health" in o && o.health !== "server") return 'expect.health is "server"';
    if ("text" in o && !(typeof o.text === "string" && o.text.trim())) return "expect.text needs text";
    if ("file" in o) {
      if (!(typeof o.file === "string" && o.file.trim())) return "expect.file needs a vault-relative path";
      if (o.file.startsWith("/") || /^[a-z]:/i.test(o.file) || o.file.split(/[\\/]/).includes("..")) return "expect.file must stay inside the vault";
      if (o.contains !== undefined && typeof o.contains !== "string") return "expect.contains needs text";
    }
    return null;
  }
  // `shot` is accepted however many there are: here it draws nothing.
  if ("shot" in s && Object.keys(s).length === 1) return typeof (s as { shot: unknown }).shot === "string" ? null : "shot needs a name";
  const checked = checkSteps([s]);
  return typeof checked === "string" ? checked.replace(/^step 1(: | )/, "") : null;
}

export function selfTestAction(raw: SelfTestStep): string {
  const s = bare(raw);
  const what = "expect" in s
    ? `expect ${Object.keys(s.expect).find((k) => k !== "timeout" && k !== "contains" && k !== "sha256" && k !== "open")}`
    : "closeWindow" in s
      ? "closeWindow"
      : stepAction(s);
  return raw.label ? `${what}: ${raw.label}` : what;
}

/** What a run needs from the app; tests pass their own. */
export type SelfTestDeps = {
  /** One Drive step in the window. */
  runStep: (s: Step) => Promise<StepOutcome>;
  /** The local server's health body, or why not (no server yet, an HTTP error). */
  health: () => Promise<{ ok: true; body: string } | { ok: false; why: string }>;
  /** A vault file's text, or null when it isn't there. */
  readFile: (rel: string) => Promise<string | null>;
  text: () => string;
  /** The app's status file, or null when there is none yet. */
  status?: () => Promise<unknown>;
  /** SHA-256 (hex) of the value the key store holds under that name, or null. Never the value. */
  keyHash?: (name: string) => Promise<string | null>;
  /** What "$vault" in an expected status stands for. */
  vault?: string;
  /** Whether the app's window with that label is open; closing one. */
  windowOpen?: (label: string) => Promise<boolean>;
  closeWindow?: (label: string) => Promise<void>;
  /** What is drawn under the macOS traffic lights (empty: nothing) and the first header text, for the note; null
   * where there are no traffic lights (Windows, Linux). */
  trafficLights?: () => { under: string[]; header: string | null } | null;
  /** Whether a visible element matches the selector. */
  shows?: (css: string) => boolean;
  /** A pause after every step (the plan's pace). */
  pace?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Told when a step starts (outcome undefined) and when it ends: the native side logs it and keeps it, so a run
   * the watchdog has to end still says which steps passed and which one hung. */
  progress?: (i: number, action: string, outcome?: StepOutcome) => void;
  /** The hard cap on one step (default: its own timeout + 60 s, see stepCapMs). Tests pass their own. */
  stepCap?: (s: SelfTestStep) => number;
};

/** How long one step may take before the run calls it hung: its own timeout (or wait) plus a minute. A step that never
 * settles (a native dialog, a modal, a window that blocks) then fails with a message instead of holding the run until
 * the app's watchdog (VC_SELFTEST_TIMEOUT) or the CI job's own timeout kills it with nothing said. */
export function stepCapMs(raw: SelfTestStep): number {
  const s = bare(raw) as Record<string, unknown>;
  const e = s.expect as Record<string, unknown> | undefined;
  const own = typeof s.timeout === "number" ? s.timeout
    : typeof s.wait === "number" ? s.wait
    : e && typeof e.timeout === "number" ? e.timeout
    : e && "health" in e ? 90_000
    : 10_000;
  return own + 60_000;
}

/** The promise, or a rejection saying the step hung once `ms` pass (the timer is cleared either way). */
function capped<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the step did not finish in ${Math.round(ms / 1000)} s (hung)`)), ms);
  });
  return Promise.race([p, hung]).finally(() => clearTimeout(timer));
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run the steps in order; the first failing step stops the run. */
export async function runSelfTest(steps: SelfTestStep[], deps: SelfTestDeps): Promise<{ ok: boolean; steps: StepOutcome[] }> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? (() => performance.now());
  const out: StepOutcome[] = [];
  for (const [n, raw] of steps.entries()) {
    const i = n + 1;
    const action = selfTestAction(raw);
    const s = bare(raw);
    const t0 = now();
    let r: StepOutcome;
    deps.progress?.(i, action);
    try {
      const one = async (): Promise<StepOutcome> => {
        if ("expect" in s) {
          const note = await expect(s.expect, deps, sleep, now);
          return { i, action, ok: true, ms: Math.round(now() - t0), ...(note ? { note } : {}) };
        }
        if ("closeWindow" in s) {
          if (!deps.closeWindow) throw new Error("no windows to close here");
          await deps.closeWindow(s.closeWindow);
          return { i, action, ok: true, ms: Math.round(now() - t0) };
        }
        if ("shot" in s) return { i, action, ok: true, ms: 0, note: "no picture in self-test: the job takes native screenshots outside the app" };
        return { ...(await deps.runStep(s)), i, action };
      };
      r = await capped(one(), (deps.stepCap ?? stepCapMs)(raw));
    } catch (e) {
      r = { i, action, ok: false, ms: Math.round(now() - t0), error: String((e as Error)?.message ?? e) };
    }
    out.push(r);
    deps.progress?.(i, action, r);
    console.info(`[selftest] ${i} ${action} ${r.ok ? "ok" : `FAILED: ${r.error}`}`);
    if (!r.ok) break;
    if (deps.pace) await sleep(deps.pace);
  }
  return { ok: out.length === steps.length && out.every((r) => r.ok), steps: out };
}

async function expect(e: Expect, deps: SelfTestDeps, sleep: (ms: number) => Promise<void>, now: () => number): Promise<string | undefined> {
  if ("notText" in e) {
    if (deps.text().includes(e.notText)) throw new Error(`"${e.notText}" is on screen`);
    return undefined;
  }
  const limit = e.timeout ?? ("health" in e ? 90_000 : 5_000);
  const end = now() + limit;
  let last = "";
  for (;;) {
    if ("health" in e) {
      const h = await deps.health().catch((err) => ({ ok: false as const, why: String((err as Error)?.message ?? err) }));
      if (h.ok) return h.body.replace(/\s+/g, " ").slice(0, 200);
      last = h.why;
    } else if ("text" in e) {
      if (deps.text().includes(e.text)) return undefined;
      last = `"${e.text}" is not on screen`;
    } else if ("status" in e) {
      const st = await (deps.status ?? (async () => null))().catch(() => null);
      const miss = st == null ? "there is no status file yet" : statusMismatch(e.status, st, deps.vault);
      if (!miss) return undefined;
      last = miss;
    } else if ("noFile" in e) {
      const body = await deps.readFile(e.noFile).catch(() => null);
      if (body === null) return undefined;
      last = `${e.noFile} is still on disk`;
    } else if ("gone" in e) {
      if (!(deps.shows ?? (() => false))(e.gone)) return undefined;
      last = `${e.gone} is still on screen`;
    } else if ("window" in e) {
      const open = await (deps.windowOpen ?? (async () => false))(e.window).catch(() => false);
      if (open === e.open) return undefined;
      last = `window ${e.window} is ${open ? "open" : "not open"}`;
    } else if ("clear" in e) {
      const t = (deps.trafficLights ?? (() => null))();
      if (t === null) return "no traffic lights here (not macOS)";
      if (t.under.length === 0) return `clear of the traffic lights (x ${TRAFFIC_LIGHTS_RECT.left}-${TRAFFIC_LIGHTS_RECT.right}, y ${TRAFFIC_LIGHTS_RECT.top}-${TRAFFIC_LIGHTS_RECT.bottom}); first header text ${t.header ?? "none"}`;
      last = `under the traffic lights: ${t.under.join("; ")}`;
    } else if ("key" in e) {
      const h = await (deps.keyHash ?? (async () => null))(e.key).catch(() => null);
      if (h === e.sha256) return `the value kept under ${e.key} matches`;
      last = h === null ? `nothing is kept under ${e.key}` : `a different value is kept under ${e.key}`;
    } else {
      const body = await deps.readFile(e.file).catch(() => null);
      if (body !== null && (e.contains === undefined || body.includes(e.contains))) return `${body.length} chars`;
      last = body === null ? `${e.file} is not on disk` : `${e.file} does not contain "${e.contains}"`;
    }
    if (now() >= end) throw new Error(`${last} (waited ${limit} ms)`);
    await sleep(Math.min(250, Math.max(0, end - now())));
  }
}

/** Why `actual` does not hold `want` (objects in part, "$vault" = the vault), or null. Names the field, never more
 * than the expected value. */
export function statusMismatch(want: Record<string, unknown>, actual: unknown, vault?: string, at = ""): string | null {
  const a = actual && typeof actual === "object" ? (actual as Record<string, unknown>) : {};
  for (const [k, w] of Object.entries(want)) {
    const path = at ? `${at}.${k}` : k;
    if (w && typeof w === "object" && !Array.isArray(w)) {
      const m = statusMismatch(w as Record<string, unknown>, a[k], vault, path);
      if (m) return m;
      continue;
    }
    const expected = w === "$vault" && vault !== undefined ? vault : w;
    if (JSON.stringify(a[k]) !== JSON.stringify(expected)) return `status ${path} is ${JSON.stringify(a[k]) ?? "missing"}, not ${JSON.stringify(expected)}`;
  }
  return null;
}

/** SHA-256 of a string, hex. */
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The result the native side writes. */
export function selfTestResult(o: { ok: boolean; vault?: string; steps: StepOutcome[]; errors: string[]; text: string; ms: number; error?: string }): SelfTestResult {
  return {
    schema: 1,
    ok: o.ok && !o.error,
    ...(o.error ? { error: o.error } : {}),
    ...(o.vault ? { vault: o.vault } : {}),
    steps: o.steps,
    errors: o.errors.slice(0, 50),
    text: o.text,
    ms: Math.round(o.ms),
  };
}

/** The page's errors from now on: thrown errors, unhandled rejections, console.error. */
function collectErrors(): string[] {
  const errors: string[] = [];
  const push = (s: string) => errors.length < 200 && errors.push(s.slice(0, 400));
  window.addEventListener("error", (e) => push(String(e.message || e.error || "error")));
  window.addEventListener("unhandledrejection", (e) => push(`unhandled rejection: ${String((e.reason as Error)?.message ?? e.reason)}`));
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    push(a.map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" "));
    orig.apply(console, a);
  };
  return errors;
}

/** In the main window at launch: run the self-test when the environment asked for one; otherwise nothing. */
export async function startSelfTestIfAsked(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const cfg = await invoke<SelfTestConfig | null>("selftest_config").catch(() => null);
  if (!cfg) return;
  const errors = collectErrors();
  const began = performance.now();
  const finish = (r: SelfTestResult) => invoke("selftest_finish", { result: r }).catch((e) => console.warn("[selftest] finish:", e));
  const plan = parseSelfTest(cfg.steps);
  if (typeof plan === "string") {
    await finish(selfTestResult({ ok: false, error: `bad steps file: ${plan}`, steps: [], errors, text: "", ms: 0 }));
    return;
  }
  const vault = cfg.vault;
  try {
    const [{ openVaultAt }, bc] = await Promise.all([import("./openVault"), import("./boxChat")]);
    await openVaultAt(vault);
    const sep = vault.endsWith("/") ? "" : "/";
    const r = await runSelfTest(plan.steps, {
      runStep: async (s) => {
        const one = await runSteps(document, [s]);
        return one.steps[0] ?? { i: 1, action: stepAction(s), ok: false, ms: 0, error: one.aborted ?? "the step did not run" };
      },
      health: async () => {
        const link = bc.localServerLink(vault) ?? (await bc.boxLinkFor(vault));
        if (!link) return { ok: false, why: "the app has no server for this vault yet" };
        const h = await invoke<{ status: number; body: string }>("box_get_json", { url: `${link.url}/api/v1/health`, token: link.token, timeoutMs: 5000 });
        return h.status >= 200 && h.status < 300 ? { ok: true, body: `${link.url} ${h.body}` } : { ok: false, why: `health answered HTTP ${h.status}` };
      },
      // A file that is not text (a PDF) is there with no text: "" (null only when it is not on disk).
      readFile: (rel) =>
        invoke<string>("read_text_file", { path: `${vault}${sep}${rel}` }).catch(async () =>
          (await invoke<boolean>("path_exists", { path: `${vault}${sep}${rel}` }).catch(() => false)) ? "" : null,
        ),
      text: () => visibleText(document, 1_000_000),
      status: () => invoke<unknown>("app_status_read"),
      keyHash: async (name) => {
        const v = await invoke<string | null>("keychain_get", { key: name }).catch(() => null);
        return v ? sha256Hex(v) : null;
      },
      vault,
      windowOpen: async (label) => {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const w = await WebviewWindow.getByLabel(label);
        return !!w && (await w.isVisible().catch(() => true));
      },
      closeWindow: async (label) => {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const w = await WebviewWindow.getByLabel(label);
        if (!w) throw new Error(`no window ${label} is open`);
        await w.close();
      },
      shows: (css) => !!find(document, css),
      trafficLights: () => (isMac ? { under: underTrafficLights(document), header: firstHeaderText(document) } : null),
      pace: plan.pace,
      progress: (i, action, outcome) => void invoke("selftest_progress", { i, action, outcome: outcome ?? null }).catch(() => {}),
    });
    await finish(selfTestResult({ ok: r.ok, vault, steps: r.steps, errors, text: visibleText(document), ms: performance.now() - began }));
  } catch (e) {
    await finish(selfTestResult({ ok: false, vault, error: String((e as Error)?.message ?? e), steps: [], errors, text: visibleText(document), ms: performance.now() - began }));
  }
}
