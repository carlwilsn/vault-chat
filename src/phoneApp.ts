// Phone chat host. The box runs vault-chat 24/7; the embedded server
// (src-tauri/src/voice_server.rs) serves the /phone PWA and relays its
// traffic here over the same reqId machinery phone voice uses. This module:
//
//   • runs phone messages as background agent turns (parallel to the
//     foreground, never steals desktop focus) with queue-then-auto-run
//     semantics when the target thread is mid-run — the Telegram
//     "message absorbed, no reply until you text again" hole doesn't exist
//     on this surface;
//   • forwards store diffs (streaming text, new messages, status flips) to
//     the phone's SSE stream via phone_broadcast;
//   • answers /status from the heartbeat file + run registry — a glance,
//     not a model turn;
//   • implements Web Push entirely with WebCrypto (RFC 8291 aes128gcm +
//     VAPID ES256). Rust only stores subscriptions and does the raw POST,
//     so push costs zero new native dependencies.
//
// Phone-sourced runs use the desktop default model, NOT the cheap Telegram
// brain — the phone page is a full-fidelity surface.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore, type ChatMessage } from "./store";
import { abortRun, activeRuns } from "./runRegistry";
import { emptyConversation, deriveConversationTitle, type Conversation } from "./conversations";

const STREAM_TAIL = 6_000;
const MSG_CAP = 20_000;

function respond(reqId: string, result: unknown): void {
  const s = typeof result === "string" ? result : JSON.stringify(result);
  void invoke("voice_tool_respond", { reqId, result: s }).catch(() => {});
}

function broadcast(event: Record<string, unknown>): void {
  void invoke("phone_broadcast", { json: JSON.stringify(event) }).catch(() => {});
}

// ---- inbound: run a phone message ----

// Messages that arrived while their thread was mid-run. Flushed (joined into
// one turn) the moment the run ends — see the status-flip handler below.
const queued = new Map<string, string[]>();

function isThreadBusy(conv: Conversation): boolean {
  const s = useStore.getState();
  return (
    conv.status === "running" ||
    (s.activeConversationId === conv.id && s.busy)
  );
}

async function handlePhoneMessage(
  convId: string | null,
  text: string,
  supervisor = false,
): Promise<Record<string, unknown>> {
  const s = useStore.getState();
  if (!s.vaultPath) return { error: "no vault open on the box" };
  if (!s.conversationsLoaded) return { error: "box is still loading conversations — retry in a few seconds" };
  const trimmed = text.trim();
  if (!trimmed) return { error: "empty message" };

  let conv: Conversation | undefined;
  if (convId) {
    conv = s.conversations.find((c) => c.id === convId);
    if (!conv) return { error: `conversation ${convId} not found` };
  } else if (supervisor) {
    // Cockpit chats: every new thread IS the agent — a fresh conversation
    // carrying role "supervisor" so its turns get the vault's supervisor.md
    // orchestrator prompt (chat-controller passes supervisorMode for
    // role === "supervisor") without the Telegram brevity contract. Fresh
    // each time, per the open-to-a-new-chat design; old threads stay in
    // the menu's recents.
    const fresh: Conversation = {
      ...emptyConversation(),
      source: "phone",
      role: "supervisor",
      title: deriveConversationTitle([{ role: "user", content: trimmed }]),
    };
    useStore.setState({ conversations: [fresh, ...useStore.getState().conversations] });
    conv = fresh;
  } else {
    // Fresh thread. Built inline (NOT newConversation()) so the desktop's
    // focus never jumps — same pattern as the Telegram inbound handler.
    const fresh: Conversation = {
      ...emptyConversation(),
      source: "phone",
      title: deriveConversationTitle([{ role: "user", content: trimmed }]),
    };
    useStore.setState({ conversations: [fresh, ...useStore.getState().conversations] });
    conv = fresh;
  }

  if (isThreadBusy(conv)) {
    const q = queued.get(conv.id) ?? [];
    q.push(trimmed);
    queued.set(conv.id, q);
    return { ok: true, convId: conv.id, queued: true };
  }

  const { sendMessage } = await import("./chat-controller");
  void sendMessage(trimmed, undefined, undefined, conv.id).catch((e) =>
    console.warn("[phone-app] agent run failed:", e),
  );
  return { ok: true, convId: conv.id };
}

// ---- inbound: status snapshot (deterministic — zero model tokens) ----

type HeartbeatFile = Record<string, { lastProgressAt: number; lastTool?: string; running: boolean }>;

async function statusSnapshot(): Promise<Record<string, unknown>> {
  const s = useStore.getState();
  if (!s.vaultPath) return { error: "no vault open on the box" };
  let hb: HeartbeatFile = {};
  try {
    const raw = await invoke<string>("read_text_file", {
      path: `${s.vaultPath}/.vault-chat/run-heartbeat.json`,
    });
    hb = JSON.parse(raw) ?? {};
  } catch {
    /* no heartbeat file yet */
  }
  const runningIds = new Set<string>(activeRuns());
  for (const c of s.conversations) {
    if (c.status === "running") runningIds.add(c.id);
  }
  if (s.busy && s.activeConversationId) runningIds.add(s.activeConversationId);
  const runs = [...runningIds].map((id) => {
    const c = s.conversations.find((x) => x.id === id);
    const beat = hb[id];
    return {
      convId: id,
      title: c?.title ?? id,
      mission: c?.mission ?? "",
      source: c?.source ?? "",
      lastTool: beat?.lastTool,
      lastProgressAt: beat?.lastProgressAt,
    };
  });
  let schedules: { name: string; detail: string }[] = [];
  try {
    const { getSchedules } = await import("./schedulerLoop");
    schedules = getSchedules().map((sc: any) => ({
      name: String(sc.name ?? sc.prompt ?? "schedule").slice(0, 60),
      detail:
        (sc.enabled === false ? "disabled" : "enabled") +
        (sc.sendViaTelegram ? " · → phone" : "") +
        (sc.quietUnlessAlert ? " · quiet-unless-ALERT" : ""),
    }));
  } catch {
    /* scheduler not loaded */
  }
  const vaultName = s.vaultPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? s.vaultPath;
  // App version, so the phone can show what the box is actually running —
  // "did the box pick up the update yet" stops being guesswork.
  let version = "";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    version = await getVersion();
  } catch {
    /* version stays unknown */
  }
  return { vault: vaultName, model: s.modelId, version, runs, schedules };
}

// ---- outbound: store diffs → SSE ----

type ConvSnap = { status: string; msgCount: number; title: string };
let snaps = new Map<string, ConvSnap>();
let lastStreamSent = new Map<string, string>();
let diffTimer: number | null = null;

function toolNames(m: ChatMessage): string[] {
  return (m.toolCalls ?? []).map((t) => t.name);
}

function runDiff(): void {
  diffTimer = null;
  const s = useStore.getState();
  const next = new Map<string, ConvSnap>();
  for (const c of s.conversations) {
    const prev = snaps.get(c.id);
    const visible = c.messages.filter((m) => !m.hidden);
    next.set(c.id, { status: c.status, msgCount: visible.length, title: c.title });
    if (!prev) continue; // newly-seen conv: list view refreshes via status events
    // New finalized messages.
    if (visible.length > prev.msgCount) {
      for (const m of visible.slice(prev.msgCount)) {
        broadcast({
          type: "message",
          convId: c.id,
          role: m.role,
          content: (m.content ?? "").slice(0, MSG_CAP),
          tools: toolNames(m),
        });
      }
    }
    if (c.title !== prev.title) {
      broadcast({ type: "title", convId: c.id, title: c.title });
    }
    // Status transitions.
    if (c.status !== prev.status) {
      broadcast({ type: "status", convId: c.id, status: c.status });
      if (prev.status === "running" && c.status === "idle") {
        lastStreamSent.delete(c.id);
        void onRunEnded(c.id);
      }
    }
  }
  snaps = next;

  // Streaming progress: background runs mirror into convRuntime; the
  // foreground run streams into the global view for the active conversation.
  // Keyed on text AND current tool — a worker grinding through tool calls
  // with no prose yet must still show signs of life on the phone (the old
  // text-only gate left its thread a silent "running…" for minutes).
  for (const [id, rt] of Object.entries(s.convRuntime)) {
    const text = (rt.streamingText ?? "").slice(-STREAM_TAIL);
    const tool = rt.liveTools?.length ? rt.liveTools[rt.liveTools.length - 1]!.name : "";
    const sig = tool + "\u0000" + text;
    if ((text || tool) && lastStreamSent.get(id) !== sig) {
      lastStreamSent.set(id, sig);
      broadcast({ type: "runtime", convId: id, text, tool });
    }
  }
  if (s.busy && s.activeConversationId && (s.streamingText || s.liveTools.length)) {
    const id = s.activeConversationId;
    const text = s.streamingText.slice(-STREAM_TAIL);
    const tool = s.liveTools.length ? s.liveTools[s.liveTools.length - 1]!.name : "";
    const sig = tool + "\u0000" + text;
    if (lastStreamSent.get(id) !== sig) {
      lastStreamSent.set(id, sig);
      broadcast({ type: "runtime", convId: id, text, tool });
    }
  }
}

async function onRunEnded(convId: string): Promise<void> {
  // 1) Flush messages that queued up while the thread was busy.
  const q = queued.get(convId);
  if (q && q.length > 0) {
    queued.delete(convId);
    const text = q.join("\n\n");
    const { sendMessage } = await import("./chat-controller");
    void sendMessage(text, undefined, undefined, convId).catch((e) =>
      console.warn("[phone-app] queued send failed:", e),
    );
    return; // the follow-up run's completion will handle notification
  }
  // 2) Worker completions auto-notify — delegated background work you aren't
  // watching, so a finish ping is the deterministic safety net. The MAIN
  // cockpit chat does NOT auto-push every reply (spam while you're actively
  // talking); there, the agent decides what's worth an interruption via the
  // Notify / AskUser tools. Telegram-delivered replies are mirrored inside
  // sendTelegramReplyWithImages, after the [[SILENT]]/ALERT gates.
  const c = useStore.getState().conversations.find((x) => x.id === convId);
  if (!c) return;
  if (c.source === "worker") {
    const last = [...c.messages].reverse().find((m) => m.role === "assistant" && !m.hidden);
    let body = (last?.content ?? "").trim().replace(/\s+/g, " ").slice(0, 180);
    if (!body) {
      // Tool-only turn (no prose) — name what it actually ran instead of a
      // contentless "finished."
      const names = (last?.toolCalls ?? []).map((t) => t.name);
      body = names.length ? `ran ${[...new Set(names)].slice(0, 5).join(", ")}` : "finished.";
    }
    void notify("info", `Worker finished — ${c.title}`, body, convId);
  }

}

// ---- the agent→you channel: record + push + live-update, one call ----
// Every notification is (a) appended to <vault>/.vault-chat/notifications.jsonl
// (the Alerts tab reads this), (b) delivered as Web Push, and (c) broadcast so
// an open phone page updates its badge live.
export async function notify(
  kind: "info" | "ask",
  title: string,
  body: string,
  convId?: string,
): Promise<void> {
  const vault = useStore.getState().vaultPath;
  if (!vault) return;
  const rec = {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    ts: Date.now(),
    kind,
    title: title.slice(0, 90),
    body: body.slice(0, 400),
    convId,
  };
  await invoke("notification_add", { vault, json: JSON.stringify(rec) }).catch(() => {});
  broadcast({ type: "notif" });
  await sendPush(rec.title, rec.body).catch(() => {});
}

// ---- Web Push: VAPID + RFC 8291 (aes128gcm), all WebCrypto ----

const te = new TextEncoder();

function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64uDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function b64Encode(buf: Uint8Array): string {
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const VAPID_STORE_KEY = "vault_chat_vapid_keys";
// Repo-facing contact, required by the push services' VAPID spec.
const VAPID_SUB = "mailto:carlwilson2027@u.northwestern.edu";

type VapidKeys = { privKey: CryptoKey; pubB64u: string };
let vapidCache: VapidKeys | null = null;

async function ensureVapid(): Promise<VapidKeys> {
  if (vapidCache) return vapidCache;
  const stored = localStorage.getItem(VAPID_STORE_KEY);
  if (stored) {
    try {
      const { priv, pubRaw } = JSON.parse(stored);
      const privKey = await crypto.subtle.importKey(
        "jwk",
        priv,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      vapidCache = { privKey, pubB64u: pubRaw };
      return vapidCache;
    } catch {
      /* regenerate below */
    }
  }
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const pubRaw = b64uEncode(await crypto.subtle.exportKey("raw", pair.publicKey));
  localStorage.setItem(VAPID_STORE_KEY, JSON.stringify({ priv: privJwk, pubRaw }));
  vapidCache = { privKey: pair.privateKey, pubB64u: pubRaw };
  return vapidCache;
}

const jwtCache = new Map<string, { jwt: string; exp: number }>();

async function vapidJwt(audience: string): Promise<string> {
  const hit = jwtCache.get(audience);
  const now = Math.floor(Date.now() / 1000);
  if (hit && hit.exp - now > 600) return hit.jwt;
  const { privKey } = await ensureVapid();
  const exp = now + 12 * 3600;
  const header = b64uEncode(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(
    te.encode(JSON.stringify({ aud: audience, exp, sub: VAPID_SUB })),
  );
  const signingInput = `${header}.${claims}`;
  // WebCrypto ECDSA emits the raw r||s form — exactly what JWS ES256 wants.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privKey,
    te.encode(signingInput),
  );
  const jwt = `${signingInput}.${b64uEncode(sig)}`;
  jwtCache.set(audience, { jwt, exp });
  return jwt;
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bits: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const out = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    bits,
  );
  return new Uint8Array(out);
}

/// RFC 8291 message encryption (aes128gcm content coding, single record).
async function encryptForSub(
  sub: { keys: { p256dh: string; auth: string } },
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const uaPub = b64uDecode(sub.keys.p256dh); // 65-byte raw P-256 point
  const authSecret = b64uDecode(sub.keys.auth); // 16 bytes
  const eph = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPub as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256),
  );
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));

  const keyInfo = concatBytes(te.encode("WebPush: info\0"), uaPub, asPub);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 96);

  const aesKey = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  // 0x02 = padding delimiter for the final (only) record.
  const padded = concatBytes(plaintext, new Uint8Array([2]));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, aesKey, padded as BufferSource),
  );

  // aes128gcm header: salt(16) | rs(4, big-endian) | idlen(1) | keyid(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concatBytes(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

/** Deliver a notification to every registered phone. Quietly prunes dead
 * subscriptions (404/410). Returns how many deliveries were attempted. */
export async function sendPush(title: string, body: string, url = "/phone"): Promise<number> {
  let subs: any[] = [];
  try {
    subs = JSON.parse(await invoke<string>("phone_push_subs"));
  } catch {
    return 0;
  }
  if (!Array.isArray(subs) || subs.length === 0) return 0;
  const { pubB64u } = await ensureVapid();
  const payload = te.encode(
    JSON.stringify({ title: title.slice(0, 80), body: body.slice(0, 400), url, tag: "vault-chat" }),
  );
  let sent = 0;
  for (const sub of subs) {
    try {
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) continue;
      const aud = new URL(sub.endpoint).origin;
      const jwt = await vapidJwt(aud);
      const bodyBytes = await encryptForSub(sub, payload);
      const status = await invoke<number>("push_post", {
        endpoint: sub.endpoint,
        headers: [
          ["TTL", "43200"],
          ["Urgency", "high"],
          ["Content-Encoding", "aes128gcm"],
          ["Content-Type", "application/octet-stream"],
          ["Authorization", `vapid t=${jwt}, k=${pubB64u}`],
        ],
        bodyB64: b64Encode(bodyBytes),
      });
      if (status === 404 || status === 410) {
        void invoke("phone_push_unsub", { endpoint: sub.endpoint }).catch(() => {});
      } else if (status >= 200 && status < 300) {
        sent++;
      } else {
        console.warn("[phone-push] push service answered", status);
      }
    } catch (e) {
      console.warn("[phone-push] delivery failed:", e);
    }
  }
  return sent;
}

/** Mirror a phone-bound Telegram delivery into the notification feed + push.
 * Called (dynamically) from sendTelegramReplyWithImages AFTER the silence
 * gates, so a quiet supervisor stays quiet here too. */
export async function mirrorPushNotify(title: string, text: string): Promise<void> {
  const raw = text.trim();
  if (!raw) return;
  const body = raw.replace(/\s+/g, " ").slice(0, 300);
  // For the generic mirror, lead with the message's first line as the title so
  // the Alert reads like the message itself (e.g. a coach check-in's opening
  // line) instead of a meta "Delivered to your phone".
  const head =
    title === "vault-chat" ? raw.split("\n")[0]!.trim().slice(0, 80) || "New message" : title;
  await notify("info", head, body);
}

// ---- wiring ----

let started = false;

export async function startPhoneAppHost(): Promise<void> {
  if (started) return;
  started = true;

  // Hand the server our VAPID public key so the page can subscribe.
  void ensureVapid()
    .then(({ pubB64u }) => invoke("phone_set_vapid", { key: pubB64u }))
    .catch((e) => console.warn("[phone-app] vapid init failed:", e));

  await listen<{ reqId: string; convId?: string | null; text?: string; supervisor?: boolean }>(
    "phone:msg",
    async (event) => {
      const { reqId, convId, text, supervisor } = event.payload;
      try {
        respond(reqId, await handlePhoneMessage(convId ?? null, String(text ?? ""), !!supervisor));
      } catch (e) {
        respond(reqId, { error: String(e) });
      }
    },
  );

  // Full schedule list for the phone's drawer — read fresh from disk so the
  // phone sees the same truth as the SchedulesPanel.
  await listen<{ reqId: string }>("phone:schedules", async (event) => {
    try {
      const s = useStore.getState();
      if (!s.vaultPath) {
        respond(event.payload.reqId, { error: "no vault open" });
        return;
      }
      const { readSchedules, recurrenceLabel, shortTimeLabel } = await import("./schedules");
      const list = await readSchedules(s.vaultPath);
      respond(event.payload.reqId, {
        schedules: list.map((sc) => ({
          id: sc.id,
          name: sc.name || sc.prompt.split(/\s+/).slice(0, 5).join(" ") || "Schedule",
          prompt: sc.prompt.slice(0, 200),
          label: `${recurrenceLabel(sc.recurrence)} · ${shortTimeLabel(sc)}`,
          enabled: sc.enabled,
          lastFiredAt: sc.lastFiredAt,
          sendViaTelegram: sc.sendViaTelegram,
          quietUnlessAlert: !!sc.quietUnlessAlert,
        })),
      });
    } catch (e) {
      respond(event.payload.reqId, { error: String(e) });
    }
  });

  // Toggle / delete a schedule from the phone. Uses the scheduler's own CRUD
  // so the in-memory loop and the SchedulesPanel stay in sync.
  await listen<{ reqId: string; action?: string; id?: string; enabled?: boolean }>(
    "phone:schedule",
    async (event) => {
      const { reqId, action, id, enabled } = event.payload;
      try {
        const s = useStore.getState();
        if (!s.vaultPath || !id) {
          respond(reqId, { error: "no vault open or missing id" });
          return;
        }
        const { toggleSchedule, deleteSchedule } = await import("./schedulerLoop");
        if (action === "toggle") {
          await toggleSchedule(s.vaultPath, id, !!enabled);
          respond(reqId, { ok: true });
        } else if (action === "delete") {
          await deleteSchedule(s.vaultPath, id);
          respond(reqId, { ok: true });
        } else {
          respond(reqId, { error: `unknown action ${action}` });
        }
      } catch (e) {
        respond(reqId, { error: String(e) });
      }
    },
  );

  // Vault-only resolver for routes that read disk directly (/conversations,
  // /file) — works even when no ElevenLabs key exists for the voice context.
  await listen<{ reqId: string }>("phone:vault", (event) => {
    respond(event.payload.reqId, useStore.getState().vaultPath ?? "");
  });

  await listen<{ reqId: string }>("phone:status", async (event) => {
    try {
      respond(event.payload.reqId, await statusSnapshot());
    } catch (e) {
      respond(event.payload.reqId, { error: String(e) });
    }
  });

  await listen<{ reqId: string; convId?: string | null }>("phone:kill", async (event) => {
    const { reqId, convId } = event.payload;
    try {
      if (convId) {
        const hit = abortRun(convId);
        // Broadcast the idle flip immediately. The store diff only catches
        // status transitions on conversations whose `status` field was set
        // (background runs); a stop on the foreground run otherwise leaves the
        // phone's running indicator flashing until the next full refresh.
        broadcast({ type: "status", convId, status: "idle" });
        respond(reqId, { ok: true, result: hit ? "Stopped." : "Nothing running on that thread." });
      } else {
        const ids = activeRuns();
        let n = 0;
        for (const id of ids) {
          if (abortRun(id)) {
            n++;
            broadcast({ type: "status", convId: id, status: "idle" });
          }
        }
        respond(reqId, { ok: true, result: n ? `Stopped ${n} run(s).` : "Nothing running." });
      }
    } catch (e) {
      respond(reqId, { error: String(e) });
    }
  });

  await listen<{ reqId: string }>("phone:pushtest", async (event) => {
    try {
      const n = await sendPush("vault-chat", "Test notification from the box. Push works.");
      respond(event.payload.reqId, n > 0 ? { ok: true } : { error: "no subscriptions registered (or all deliveries failed — check the box console)" });
    } catch (e) {
      respond(event.payload.reqId, { error: String(e) });
    }
  });

  // Store → SSE forwarding, debounced. The diff is cheap (length/status
  // compares) and only runs 4×/sec at worst during a streaming turn.
  let prevConvs = useStore.getState().conversations;
  let prevRuntime = useStore.getState().convRuntime;
  let prevStreaming = "";
  useStore.subscribe((s) => {
    if (
      s.conversations === prevConvs &&
      s.convRuntime === prevRuntime &&
      s.streamingText === prevStreaming
    ) {
      return;
    }
    prevConvs = s.conversations;
    prevRuntime = s.convRuntime;
    prevStreaming = s.streamingText;
    if (diffTimer === null) {
      diffTimer = window.setTimeout(runDiff, 250);
    }
  });
  // Seed the snapshot so a fresh boot doesn't replay the whole history.
  runDiff();
}
