// Scenario-scripted host commands: vault sync (the box loop and local autosave;
// the git-remote commands stay for the before side),
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
  /** `.vault-chat/sync.json`'s box, or null for the plain git-remote loop.
   *  Settings → Box changes it (vault_box_connect / vault_box_disconnect). */
  box?: { box: string; vault: string; name?: string } | null;
  /** Settings → Box: what `box_discover` finds (machines answering now). */
  discover?: { name: string; url: string; version: string | null; online: boolean; hasKey: boolean }[];
  /** The fake boxes behind those URLs: health, key, vaults. Offline ones never answer. */
  boxes?: Record<string, FakeBox>;
  /** vault_box_sync replies, in order; the last one repeats. */
  reports?: Partial<BoxReport>[];
  remote?: string | null;
  ahead?: number;
  pull?: { ok: boolean; message: string; error: boolean };
  push?: { ok: boolean; message: string; error: boolean };
  role?: "writer" | "follower";
  /** `tailscale status --json` on the laptop (asked only after a box request
   *  failed). Default: connected. "Open Tailscale" connects it, and the box
   *  answers from the next cycle on. */
  tailscale?: { installed: boolean; connected: boolean; state: string; canOpen: boolean };
  /** Box-mode chat (src/boxChat.ts): the conversations the box serves and a
   *  script of what happens next, one step per boxNext() (a scenario step). */
  boxChat?: BoxChatScript;
};

/** A fake box. `keys` is what the laptop pushed to it (fake values; the
 *  health route shows only the names, like the real box). */
export type FakeBox = { name: string; version: string; keys?: Record<string, string>; online?: boolean; vaults?: string[] };

export type BoxConv = { title: string; source?: string; status?: "running" | "idle"; meta?: Record<string, unknown>; messages: unknown[] };
export type BoxStep = {
  /** Poll events delivered for this step (status / runtime / message / chat). */
  events?: unknown[];
  /** Messages the box now has at the end of a conversation. */
  append?: Record<string, unknown[]>;
  meta?: Record<string, Record<string, unknown>>;
  status?: Record<string, "running" | "idle">;
};
export type BoxChatScript = {
  convs: Record<string, BoxConv>;
  steps?: BoxStep[];
  /** /api/v1/models (Settings' box model checks). */
  models?: unknown;
  /** Record what the laptop sends (/message, /answer, subagent steer/stop) on
   *  the box like the engine does: the turn appended, its poll events queued.
   *  The reply itself stays the script's (boxNext). */
  live?: boolean;
  /** Voice on the box (server/voice.ts): POST /api/v1/voice/tool answers
   *  `results[name]` (else "(ran <name> on the box)"); AskAgent starts a box
   *  chat (running, the task as its first message) and AgentStatus reads it. */
  voice?: { results?: Record<string, string> };
};
/** `vault`: the vault the laptop named (?vault=), as the real box scopes it. */
export type BoxPost = { path: string; body: any; vault?: string | null };

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
let tailscaleOpened = false;
const boxPosts: BoxPost[] = [];
/** What the laptop POSTed to the fake box (scenario checks). */
export function boxPostLog(): BoxPost[] {
  return boxPosts;
}
const keys = new Map<string, string>();

export function setHostConfig(c: HostConfig, now: () => number): void {
  cfg = c ? { ...c, sync: c.sync ? JSON.parse(JSON.stringify({ ...c.sync, boxChat: undefined, reports: undefined })) : undefined } : {};
  if (cfg.sync && c.sync) Object.assign(cfg.sync, { boxChat: c.sync.boxChat, reports: c.sync.reports });
  boxCalls = 0;
  tailscaleOpened = false;
  boxConvs = JSON.parse(JSON.stringify(cfg.sync?.boxChat?.convs ?? {}));
  boxQueue = [];
  boxStep = 0;
  boxPosts.length = 0;
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

/** The scenario's fake box behind a URL; offline (or unknown) ones don't answer. */
/** Like the real box: a request naming a vault this box doesn't have is 404 (only for a fake box that lists its vaults). */
function unknownVault(u: URL): { status: number; body: string } | null {
  const v = u.searchParams.get("vault");
  const list = cfg.sync?.boxes?.[u.origin]?.vaults;
  return v && list && !list.includes(v) ? { status: 404, body: JSON.stringify({ error: `no vault ${v} on this box` }) } : null;
}

function fakeBox(u: URL): FakeBox {
  // A scenario that starts connected (sync.box) gets that box online with an
  // empty key store unless it lists its boxes itself.
  const boxes = ((cfg.sync ??= {} as any).boxes ??= {}) as Record<string, FakeBox>;
  const conf = cfg.sync?.box as unknown;
  const confUrl = typeof conf === "string" ? conf : (conf as { box?: string } | undefined)?.box;
  let confOrigin = "";
  try {
    confOrigin = confUrl ? new URL(confUrl).origin : "";
  } catch {
    /* not a URL */
  }
  if (!boxes[u.origin] && confOrigin === u.origin)
    boxes[u.origin] = { name: u.hostname.split(".")[0], version: "0.6.33", online: true, keys: {}, vaults: [] } as FakeBox;
  const b = boxes[u.origin];
  if (!b || b.online === false) throw `error sending request for url (${u.href}): operation timed out`;
  return b;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A voice session's line saved on the box (server/voice.ts voiceTranscript):
 *  a voice conversation of its own, tagged with the project it came from. */
function boxVoiceLine(b: any): { ok: true; convId: string } {
  let id = String(b.convId ?? "");
  if (!boxConvs[id] || boxConvs[id]!.source !== "voice") {
    const from = boxConvs[String(b.fromConvId ?? "")];
    id = `v-voice-${Object.keys(boxConvs).filter((k) => k.startsWith("v-voice-")).length + 1}`;
    const first = String(b.text ?? "");
    boxConvs[id] = { title: b.role === "user" ? (first.length > 48 ? first.slice(0, 47) + "…" : first) : "Voice", source: "voice", status: "idle", meta: { lastActivityAt: Date.now(), ...(from?.meta?.project ? { project: from.meta.project } : {}) }, messages: [] };
  }
  boxConvs[id]!.messages = [...boxConvs[id]!.messages, { role: b.role === "user" ? "user" : "assistant", content: String(b.text ?? ""), ...(b.system ? { system: true } : {}) }];
  boxConvs[id]!.meta = { ...(boxConvs[id]!.meta ?? {}), lastActivityAt: Date.now() };
  boxQueue.push({ type: "message", convId: id, role: b.role === "user" ? "user" : "assistant" });
  return { ok: true, convId: id };
}

/** The fake box's voice tools (the real ones: server/voice.ts). */
function boxVoiceTool(name: string, args: any): string {
  if (name === "AskAgent") {
    const task = String(args.task ?? "").trim();
    let id = String(args.conversationId ?? "");
    const started = !id || !boxConvs[id];
    if (started) {
      // Deterministic, so a scenario's box steps can name it: v-agent-1, v-agent-2 …
      id = `v-agent-${Object.keys(boxConvs).filter((k) => k.startsWith("v-agent-")).length + 1}`;
      const title = task.length > 48 ? task.slice(0, 47) + "…" : task;
      boxConvs[id] = { title, source: "phone", status: "running", meta: { state: "running", lastActivityAt: Date.now(), ...(args.project ? { project: String(args.project) } : {}) }, messages: [{ role: "user", content: task }] };
    } else {
      boxConvs[id]!.messages = [...boxConvs[id]!.messages, { role: "user", content: task, direct: true }];
      boxConvs[id]!.status = "running";
    }
    boxQueue.push({ type: "status", convId: id, status: "running" });
    return JSON.stringify({ conversationId: id, started });
  }
  if (name === "AgentStatus") {
    const id = String(args.conversationId ?? "");
    const c = boxConvs[id];
    if (!c) return `No conversation ${id}.`;
    const last = [...c.messages].reverse().find((m: any) => m.role === "assistant" && !m.system) as any;
    return JSON.stringify({ conversationId: id, title: c.title, state: c.status === "running" ? "working" : String(c.meta?.state ?? "idle"), ...(last ? { lastReply: String(last.content).slice(0, 800) } : {}) });
  }
  return cfg.sync?.boxChat?.voice?.results?.[name] ?? `(ran ${name} on the box)`;
}

export const hostCommands: Record<string, (a: Record<string, any>) => unknown> = {
  // ---- sync ----
  vault_box_config: () => cfg.sync?.box ?? null,
  vault_box_sync: async () => {
    const list = cfg.sync?.reports ?? [];
    const r = list.length ? list[Math.min(boxCalls, list.length - 1)] : {};
    boxCalls++;
    await sleep(250);
    if (!cfg.sync?.box) return { ...okBox(), configured: false };
    if (tailscaleOpened) return okBox();
    return { ...okBox(), ...r };
  },
  tailscale_check: () => (tailscaleOpened ? null : cfg.sync?.tailscale) ?? { installed: true, connected: true, state: "Running", canOpen: true },
  tailscale_open: () => {
    tailscaleOpened = true;
    report("info", "Tailscale opened (the preview connects it; the box answers from the next cycle)");
    return null;
  },
  box_discover: async () => {
    await sleep(700);
    return cfg.sync?.discover ?? [];
  },
  vault_box_connect: ({ boxUrl, boxVault, name }) => {
    cfg.sync = { ...(cfg.sync ?? {}), box: { box: String(boxUrl).replace(/\/+$/, ""), vault: boxVault, name } };
    return null;
  },
  vault_box_disconnect: () => {
    cfg.sync = { ...(cfg.sync ?? {}), box: null };
    return null;
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
    if (u.pathname === "/api/v1/health") {
      const b = fakeBox(u);
      await sleep(400);
      const names = Object.keys(b.keys ?? {}).sort();
      const has = (n: string) => names.includes(n);
      return {
        status: 200,
        body: JSON.stringify({ ok: true, app: "vault-chat-server", name: b.name, version: b.version, hasKey: has("api.openrouter"), keyNames: names, keys: { openrouter: has("api.openrouter"), elevenlabs: has("service.elevenlabs") } }),
      };
    }
    if (u.pathname.endsWith("/api/v1/voice/session")) {
      // The box's session (server/voice.ts): no ElevenLabs in the preview, so a URL nothing dials.
      return { status: 200, body: JSON.stringify({ signedUrl: "wss://preview.invalid/voice", systemPrompt: "(the box's voice prompt)", toolNames: [], vaultRoot: "/home/carl/vaults/summer-demo", onBox: true }) };
    }
    if (u.pathname === "/api/v1/vaults") {
      const b = fakeBox(u);
      return { status: 200, body: JSON.stringify({ vaults: (b.vaults ?? []).map((name, i) => ({ name, main: i === 0, syncing: true })) }) };
    }
    const miss = unknownVault(u);
    if (miss) return miss;
    const p = u.pathname.replace(/^.*?(\/(poll|conversations|conversation|status|api\/v1\/models))/, "$1");
    if (p === "/api/v1/models" && cfg.sync?.boxChat?.models) return { status: 200, body: JSON.stringify(cfg.sync.boxChat.models) };
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
  box_post_json: async ({ url, body }) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/v1/keys" || u.pathname === "/api/v1/vaults") {
      const b = fakeBox(u);
      const j = JSON.parse(String(body || "{}"));
      await sleep(500);
      if (u.pathname === "/api/v1/keys") {
        // The whole set: a name the laptop no longer has is removed.
        if (!j.keys || typeof j.keys !== "object") return { status: 400, body: JSON.stringify({ error: "keys: a {name: value} map is required" }) };
        b.keys = { ...j.keys };
        report("info", `fake box ${b.name} received keys: ${Object.keys(b.keys).sort().join(", ")}`);
        return { status: 200, body: JSON.stringify({ ok: true, changed: true, names: Object.keys(b.keys).sort() }) };
      }
      const created = !(b.vaults ??= []).includes(j.name);
      if (created) b.vaults.push(j.name);
      // Each vault on the box gets its own agent there; the laptop names it on every request.
      report("info", `fake box ${b.name} vaults: ${b.vaults.join(", ")}`);
      return { status: 200, body: JSON.stringify({ ok: true, name: j.name, created }) };
    }
    const miss = unknownVault(u);
    if (miss) return miss;
    report("info", `box POST ${url} (answered by the preview)`);
    const path = new URL(String(url)).pathname.replace(/^.*?(\/(message|answer|kill|api\/v1\/.*))$/, "$1");
    let b: any = {};
    try {
      b = JSON.parse(String(body ?? "{}"));
    } catch {
      b = {};
    }
    boxPosts.push({ path, body: b, vault: u.searchParams.get("vault") });
    if (path === "/api/v1/voice/tool") return { status: 200, body: JSON.stringify({ result: boxVoiceTool(String(b.name ?? ""), b.args ?? {}) }) };
    if (path === "/api/v1/voice/transcript") return { status: 200, body: JSON.stringify(boxVoiceLine(b)) };
    if (cfg.sync?.boxChat?.live) {
      const id = String(b.convId ?? "");
      const c = boxConvs[id];
      if (c && (path === "/message" || path === "/answer")) {
        const imgs = Array.isArray(b.images) ? b.images : [];
        const text = String(b.text ?? "").trim() || "(image)";
        c.messages = [
          ...c.messages,
          {
            role: "user",
            content: text,
            direct: true,
            ...(path === "/answer" ? { decision: true } : {}),
            ...(imgs.length ? { attachments: imgs.map((i: any) => ({ imageDataUrl: `data:${i.mime};base64,${i.dataBase64}`, capturedFilePath: `.vault-chat/captures/${i.name ?? "image.png"}` })) } : {}),
          },
        ];
        c.status = "running";
        c.meta = { ...(c.meta ?? {}), state: "running" };
        boxQueue.push({ type: "message", convId: id, role: "user" }, { type: "status", convId: id, status: "running" });
        return { status: 200, body: JSON.stringify({ ok: true, convId: id, ...(path === "/answer" ? { answered: true } : {}) }) };
      }
    }
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
