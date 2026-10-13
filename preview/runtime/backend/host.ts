// Scenario-scripted host commands: vault sync (git remote + the box loop),
// the key store (fake values only), the shell (scripted outputs) and the
// Tauri plugins (updater, dialog, opener, window, app).
import { report } from "../overlay";
import * as fs from "../shims/memfs";
import { gitDirty } from "./memgit";

export type BoxReport = {
  configured: boolean;
  ok: boolean;
  message: string;
  committed: boolean;
  merged: boolean;
  conflict: { files: string[]; since: number } | null;
  error: string | null;
  error_kind: "unreachable" | "git" | null;
  changes_waiting: number;
  big_files: { path: string; size: number }[];
  github_warning: string | null;
  github_pushed_at: number | null;
};

export type SyncScript = {
  /** `.vault-chat/sync.json`'s box, or null for the plain git-remote loop. */
  box?: { box: string; vault: string } | null;
  /** vault_box_sync replies, in order; the last one repeats. */
  reports?: Partial<BoxReport>[];
  remote?: string | null;
  ahead?: number;
  pull?: { ok: boolean; message: string; error: boolean };
  push?: { ok: boolean; message: string; error: boolean };
  role?: "writer" | "follower";
  /** Box-mode chat (src/boxChat.ts): the conversations the box serves and a
   *  script of what happens next, one step per boxNext() (a scenario step). */
  boxChat?: BoxChatScript;
};

export type BoxConv = { title: string; source?: string; status?: "running" | "idle"; meta?: Record<string, unknown>; messages: unknown[] };
export type BoxStep = {
  /** Poll events delivered for this step (status / runtime / message / chat). */
  events?: unknown[];
  /** Messages the box now has at the end of a conversation. */
  append?: Record<string, unknown[]>;
  meta?: Record<string, Record<string, unknown>>;
  status?: Record<string, "running" | "idle">;
};
export type BoxChatScript = { convs: Record<string, BoxConv>; steps?: BoxStep[] };

export type BashRule = { match: RegExp; stdout?: string; stderr?: string; code?: number; delayMs?: number };

export type HostConfig = {
  sync?: SyncScript;
  keys?: Record<string, string | null>;
  bash?: BashRule[];
  updater?: { version: string; notes?: string } | null;
  appVersion?: string;
  dialogOpen?: string | string[] | null;
};

let cfg: HostConfig = {};
// The fake box's live state for box-mode chat.
let boxConvs: Record<string, BoxConv> = {};
let boxQueue: unknown[] = [];
let boxStep = 0;
/** Play the box script's next step (a scenario/tour step calls it). */
export function boxNext(): boolean {
  const st = cfg.sync?.boxChat?.steps?.[boxStep];
  if (!st) return false;
  boxStep++;
  for (const [id, msgs] of Object.entries(st.append ?? {})) if (boxConvs[id]) boxConvs[id].messages = [...boxConvs[id].messages, ...msgs];
  for (const [id, m] of Object.entries(st.meta ?? {})) if (boxConvs[id]) boxConvs[id].meta = { ...(boxConvs[id].meta ?? {}), ...m };
  for (const [id, v] of Object.entries(st.status ?? {})) if (boxConvs[id]) boxConvs[id].status = v;
  boxQueue.push(...(st.events ?? []));
  return true;
}
let boxCalls = 0;
const keys = new Map<string, string>();

export function setHostConfig(c: HostConfig, now: () => number): void {
  cfg = c ?? {};
  boxCalls = 0;
  boxConvs = JSON.parse(JSON.stringify(cfg.sync?.boxChat?.convs ?? {}));
  boxQueue = [];
  boxStep = 0;
  keys.clear();
  const defaults: Record<string, string> = { "api.openrouter": "sk-or-PREVIEW-0000000000000000000000000000000000000000", "service.elevenlabs": "sk_PREVIEW0000000000000000000000000000000000" };
  for (const [k, v] of Object.entries({ ...defaults, ...(cfg.keys ?? {}) })) if (v) keys.set(k, v);
  void now;
}

function okBox(): BoxReport {
  return {
    configured: true,
    ok: true,
    message: "in sync",
    committed: false,
    merged: false,
    conflict: null,
    error: null,
    error_kind: null,
    changes_waiting: 0,
    big_files: [],
    github_warning: null,
    github_pushed_at: Date.now() - 4 * 60_000,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const hostCommands: Record<string, (a: Record<string, any>) => unknown> = {
  // ---- sync ----
  vault_box_config: () => cfg.sync?.box ?? null,
  vault_box_sync: async () => {
    const list = cfg.sync?.reports ?? [];
    const r = list.length ? list[Math.min(boxCalls, list.length - 1)] : {};
    boxCalls++;
    await sleep(250);
    if (!cfg.sync?.box) return { ...okBox(), configured: false };
    return { ...okBox(), ...r };
  },
  vault_sync_role: () => cfg.sync?.role ?? "writer",
  vault_sync_status: ({ vault }) => ({
    has_repo: true,
    remote: cfg.sync?.remote === undefined ? "https://github.com/carl-wilson/summer-preview.git" : cfg.sync.remote,
    has_changes: gitDirty(vault) > 0,
    ahead: cfg.sync?.ahead ?? 0,
    nested_repos: [],
  }),
  vault_sync_set_remote: ({ url }) => {
    cfg.sync = { ...(cfg.sync ?? {}), remote: url };
    return null;
  },
  vault_sync_commit_local: () => ({ ok: true, message: "nothing to commit", error: false }),
  vault_commit_local: () => ({ ok: true, message: "nothing to commit", error: false }),
  vault_sync_pull: async () => {
    await sleep(300);
    return cfg.sync?.pull ?? { ok: true, message: "Already up to date.", error: false };
  },
  vault_sync_push: async () => {
    await sleep(300);
    return cfg.sync?.push ?? { ok: true, message: "Everything up-to-date", error: false };
  },
  vault_sync_gh_create_repo: () => ({ ok: false, message: "preview: no GitHub in the preview", error: true }),
  // [phase 2] Box-mode chat (src/boxChat.ts) talks to the box over these. The
  // preview's box is reachable: it serves the scenario's box conversations
  // (sync.boxChat, none by default) and an event ring fed by boxNext(). A
  // scenario overrides them to make it unreachable.
  box_get_json: async ({ url }) => {
    const u = new URL(String(url));
    const p = u.pathname.replace(/^.*?(\/(poll|conversations|conversation|status))/, "$1");
    const ok = (v: unknown) => ({ status: 200, body: JSON.stringify(v) });
    if (p === "/poll") {
      const after = u.searchParams.get("after");
      if (after === "latest") return ok({ next: 0, events: [] });
      const n = Number(after) || 0;
      for (let t = 0; t < 125 && !boxQueue.length; t++) await sleep(200);
      const events = boxQueue.splice(0);
      return ok({ next: n + events.length, events });
    }
    if (p === "/conversations")
      return ok({
        conversations: Object.entries(boxConvs).map(([id, c]) => ({ id, title: c.title, source: c.source ?? "phone", msgCount: c.messages.length, lastActivityAt: Number(c.meta?.lastActivityAt) || undefined, ...(c.meta ?? {}) })),
      });
    if (p === "/status") return ok({ runs: Object.entries(boxConvs).filter(([, c]) => c.status === "running").map(([id]) => ({ convId: id })) });
    if (p === "/conversation") {
      const id = u.searchParams.get("id") ?? "";
      const c = boxConvs[id];
      if (!c) return { status: 404, body: JSON.stringify({ error: "not found" }) };
      return ok({ id, title: c.title, source: c.source ?? "phone", status: c.status ?? "idle", full: true, meta: c.meta ?? {}, messages: c.messages });
    }
    return { status: 404, body: JSON.stringify({ error: "not found" }) };
  },
  box_post_json: ({ url }) => {
    report("info", `box POST ${url} (answered by the preview)`);
    return { status: 200, body: "{\"ok\":true}" };
  },

  // ---- keys: fake values only ----
  keychain_get: ({ key }) => keys.get(key) ?? null,
  keychain_set: ({ key, value }) => {
    keys.set(key, String(value));
    return null;
  },
  keychain_delete: ({ key }) => {
    keys.delete(key);
    return null;
  },
  keystore_encrypt: ({ plaintext }) => "PREVIEW:" + btoa(unescape(encodeURIComponent(String(plaintext)))),
  keystore_decrypt: ({ blob }) => {
    const s = String(blob);
    if (!s.startsWith("PREVIEW:")) throw "wrong passphrase or corrupt key store";
    return decodeURIComponent(escape(atob(s.slice(8))));
  },

  // ---- shell: scripted, never executed ----
  bash_shell_kind: () => ({ kind: "git-bash", path: "C:/Program Files/Git/bin/bash.exe" }),
  bash_exec: async ({ command }) => {
    const rule = (cfg.bash ?? []).find((r) => r.match.test(String(command)));
    await sleep(rule?.delayMs ?? 400);
    if (rule) return { stdout: rule.stdout ?? "", stderr: rule.stderr ?? "", code: rule.code ?? 0, timed_out: false };
    return { stdout: "", stderr: `preview: shell commands don't run in the preview (${String(command).slice(0, 80)})`, code: 127, timed_out: false };
  },
  bash_cancel: () => null,

  // ---- Tauri plugins ----
  "plugin:app|version": () => cfg.appVersion ?? "0.6.32",
  "plugin:app|name": () => "vault-chat",
  "plugin:app|tauri_version": () => "2.10.1",
  "plugin:app|identifier": () => "com.vault-chat.app",
  "plugin:updater|check": () =>
    cfg.updater
      ? { rid: 1, currentVersion: cfg.appVersion ?? "0.6.32", version: cfg.updater.version, date: "2026-10-09T18:00:00Z", body: cfg.updater.notes ?? "", rawJson: {} }
      : null,
  "plugin:updater|download_and_install": () => {
    report("info", "update install is not run in the preview");
    return null;
  },
  "plugin:autostart|is_enabled": () => false,
  "plugin:autostart|enable": () => null,
  "plugin:autostart|disable": () => null,
  "plugin:dialog|open": () => cfg.dialogOpen ?? null,
  "plugin:dialog|save": () => null,
  "plugin:dialog|message": () => true,
  "plugin:dialog|ask": () => true,
  "plugin:dialog|confirm": () => true,
  "plugin:opener|open_url": ({ url }) => {
    report("refused", `open_url ${url} (outside links don't open from the preview)`);
    return null;
  },
  "plugin:opener|open_path": ({ path }) => {
    report("info", `would open ${path} in its default app`);
    return null;
  },
  "plugin:opener|reveal_item_in_dir": ({ path }) => {
    report("info", `would reveal ${path}`);
    return null;
  },
  "plugin:process|exit": () => null,
  "plugin:process|restart": () => {
    location.reload();
    return null;
  },
  "plugin:resources|close": () => null,
  "plugin:webview|create_webview_window": ({ options }) => {
    const url = options?.url ?? "index.html?view=chat";
    const full = new URL(String(url), location.href);
    for (const [k, v] of new URLSearchParams(location.search)) if (!full.searchParams.has(k) && k !== "view") full.searchParams.set(k, v);
    window.open(full.href, `vc-preview-${options?.label ?? "popout"}`, "width=520,height=820");
    return null;
  },
};

// Window plugin: every getter answers like a 1400×900 undecorated window.
const windowState = { maximized: false, focused: true, visible: true, minimized: false, fullscreen: false };
export function windowCommand(cmd: string, args: Record<string, any>): { handled: boolean; value?: unknown } {
  if (!cmd.startsWith("plugin:window|") && !cmd.startsWith("plugin:webview|")) return { handled: false };
  const op = cmd.split("|")[1];
  switch (op) {
    case "is_maximized":
      return { handled: true, value: windowState.maximized };
    case "maximize":
      windowState.maximized = true;
      return { handled: true, value: null };
    case "unmaximize":
      windowState.maximized = false;
      return { handled: true, value: null };
    case "toggle_maximize":
      windowState.maximized = !windowState.maximized;
      return { handled: true, value: null };
    case "is_focused":
      return { handled: true, value: document.hasFocus() };
    case "is_visible":
      return { handled: true, value: true };
    case "is_minimized":
    case "is_fullscreen":
      return { handled: true, value: false };
    case "is_decorated":
      return { handled: true, value: false };
    case "scale_factor":
      return { handled: true, value: window.devicePixelRatio || 1 };
    case "inner_size":
    case "outer_size":
      return { handled: true, value: { width: window.innerWidth, height: window.innerHeight } };
    case "inner_position":
    case "outer_position":
      return { handled: true, value: { x: 0, y: 0 } };
    case "get_all_windows":
    case "get_all_webviews":
      return { handled: true, value: [{ label: "main" }] };
    case "close":
    case "destroy":
      if ((window as any).__TAURI_INTERNALS__?.metadata?.currentWindow?.label !== "main") window.close();
      else report("info", "the main window would close here");
      return { handled: true, value: null };
    case "create_webview_window":
      return { handled: false };
    default:
      // minimize, start_dragging, set_focus, show, hide, set_* …: accepted, no-op.
      void args;
      return { handled: true, value: null };
  }
}

export function fileForConvert(path: string): string {
  return fs.urlFor(path) ?? `${import.meta.env.BASE_URL}__preview/vfs?path=${encodeURIComponent(path)}`;
}
