// Phone host, on the box (server/main.ts starts it): notes, schedules, the
// chats list, notifications and Web Push for the /phone PWA, over the same
// reqId relay phone voice uses. Messages, answers and stops never come here —
// they are the engine's (server/http.ts).
//
// Web Push is implemented with WebCrypto (RFC 8291 aes128gcm + VAPID ES256);
// the server only stores subscriptions and does the raw POST.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./store";
import { isArchivedThread } from "./conversations";


function respond(reqId: string, result: unknown): void {
  const s = typeof result === "string" ? result : JSON.stringify(result);
  void invoke("voice_tool_respond", { reqId, result: s }).catch(() => {});
}

function broadcast(event: Record<string, unknown>): void {
  void invoke("phone_broadcast", { json: JSON.stringify(event) }).catch(() => {});
}

// Coalesce identical (title, body) notifications fired within this window. The
// dark-alarm triple-fires the same record within one second (two scheduler
// loops + path-variant vault keys), and parallel worker-done events arrive as
// separate pings; both collapse to one feed entry here. In-memory is enough —
// the box is the sole active writer, so this Map sees every real notify().
const NOTIF_COALESCE_MS = 60_000;
const recentNotifs = new Map<string, number>(); // dedup-key -> last ts
function isDuplicateNotif(key: string, now: number): boolean {
  const prev = recentNotifs.get(key);
  if (prev !== undefined && now - prev < NOTIF_COALESCE_MS) return true;
  recentNotifs.set(key, now);
  // Cheap bounded sweep: evict stale keys so the map stays small.
  if (recentNotifs.size > 64) {
    for (const [k, t] of recentNotifs) {
      if (now - t >= NOTIF_COALESCE_MS) recentNotifs.delete(k);
    }
  }
  return false;
}

// ---- the agent→you channel: record + push + live-update, one call ----
// Every notification is (a) appended to <vault>/.vault-chat/notifications.jsonl
// (the Alerts tab reads this), (b) delivered as Web Push, and (c) broadcast so
// an open phone page updates its badge live.
export type NotifyExtra = {
  intention?: string;
  summary?: string;
  icon?: string;
  cls?: string;
  // [AskUser redesign] Structured deliberation payload for an "ask" notification.
  // When present, the cockpit renders the richer "Needs you" deliberation card +
  // inline-option sheet from REAL ask data (not just ?mock=1). Passed straight
  // through notifications.jsonl → the box's notifications_json → the phone.
  deliberation?: {
    mission?: string;
    ask: string;
    askLong?: string;
    // [ask-object] The declared fallback if the user doesn't answer (Not now /
    // timeout), and how consequential the fork is. `stakes:"high"` means a
    // no-answer must STAND DOWN, never auto-proceed.
    stakes?: "low" | "high";
    onDefer?: string;
    // [ask-object 4b] Minutes to wait before a low-stakes ask self-defers.
    timeoutMin?: number;
    options?: { answer: string; title: string; body: string; primary?: boolean }[];
  };
};
export async function notify(
  kind: "info" | "ask",
  title: string,
  body: string,
  convId?: string,
  extra?: NotifyExtra,
): Promise<void> {
  const vault = useStore.getState().vaultPath;
  if (!vault) return;
  const rec: Record<string, unknown> = {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    ts: Date.now(),
    kind,
    title: title.slice(0, 90),
    // The Alerts sheet renders + scrolls the full body, so don't guillotine a
    // summary mid-word (the "…[SECONDARY" cutoff). Keep it generous here; the
    // push text below is truncated separately to a notification-sized line.
    body: body.slice(0, 2000),
    convId,
  };
  // Structured-deliverable fields. Alerts renders these directly (a real
  // intention line + summary) instead of guessing a category from the title.
  // All optional and backward-compatible: notifications_json on the box passes
  // any extra fields straight through, and the page falls back to derived
  // values when they're absent.
  if (extra?.intention) rec.intention = String(extra.intention).slice(0, 90);
  if (extra?.summary) rec.summary = String(extra.summary).slice(0, 200);
  if (extra?.icon) rec.icon = String(extra.icon).slice(0, 4);
  if (extra?.cls) rec.cls = String(extra.cls).slice(0, 4);
  // [AskUser redesign] Carry the structured deliberation payload verbatim so the
  // cockpit renders the option cards from real ask data. Bounded lengths so a
  // verbose option set can't bloat the feed/push, but generous — the sheet shows
  // the full option bodies. Only for "ask" notifications with real options.
  if (extra?.deliberation && Array.isArray(extra.deliberation.options) && extra.deliberation.options.length) {
    const d = extra.deliberation;
    rec.deliberation = {
      mission: d.mission ? String(d.mission).slice(0, 90) : undefined,
      ask: String(d.ask || "").slice(0, 600),
      askLong: d.askLong ? String(d.askLong).slice(0, 1200) : undefined,
      ...(d.stakes === "high" || d.stakes === "low" ? { stakes: d.stakes } : {}),
      ...(d.onDefer && String(d.onDefer).trim() ? { onDefer: String(d.onDefer).trim().slice(0, 300) } : {}),
      options: d.options!.slice(0, 6).map((o) => ({
        // 200, not 80: the answer text is relayed VERBATIM as the user's
        // message when tapped — an 80-char cap once delivered "…then t"
        // (truncated mid-word) to the waiting supervisor.
        answer: String(o.answer || "").slice(0, 200),
        title: String(o.title || o.answer || "").slice(0, 120),
        body: String(o.body || "").slice(0, 800),
        ...(o.primary ? { primary: true } : {}),
      })),
    };
  }
  // Quality floor: a stringified error object must never reach the feed/push as
  // the literal "[object Object]" (it was even mislabeled as success). Blank it
  // so the title carries the signal instead of junk.
  if (rec.body === "[object Object]") rec.body = "";
  if (rec.summary === "[object Object]") rec.summary = "";
  // Coalesce a byte-identical re-fire inside the 60s window (dark-alarm
  // triple-fire, parallel worker pings) before it hits feed + push. Key on
  // kind+convId+title+body — NOT title+body alone: two different threads asking
  // the SAME stock AskUser question must each surface their own card, or the
  // second asker (which already ended its turn awaiting a reply routed to its
  // convId) would deadlock on a card that never appeared. The ask-thread mint
  // below sits AFTER this gate — the probe run proved a doubled AskUser call
  // mints an orphan thread when the mint runs first (the notification deduped,
  // the mint didn't).
  const dupKey = `${kind} ${convId ?? ""} ${rec.title as string} ${rec.body as string}`;
  if (isDuplicateNotif(dupKey, rec.ts as number)) return;
  // Latest ask wins, BY CONSTRUCTION: a conversation has at most ONE pending ask.
  // A new "ask" retires any earlier unanswered asks for the same thread (append
  // read markers — same append-only shape the phone's swipe writes). Without this
  // the self-test deadlock stacked 3 live cards for one decision; the user tapped
  // several, each tap woke another turn, and the thread filled with duplicate
  // replies. The supervisor only ever honors the newest ask anyway.
  if (kind === "ask" && convId) {
    try {
      const raw = await invoke<string>("read_text_file", {
        path: `${vault}/.vault-chat/notifications.jsonl`,
      }).catch(() => "");
      const readIds = new Set<string>();
      const priorAsks: string[] = [];
      for (const line of String(raw || "").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let v: { type?: string; id?: string; kind?: string; convId?: string };
        try { v = JSON.parse(line); } catch { continue; }
        if (v.type === "read" && v.id) { readIds.add(v.id); continue; }
        if (v.type) continue; // hide/clear markers
        if (v.kind === "ask" && v.convId === convId && v.id) priorAsks.push(v.id);
      }
      for (const id of priorAsks.filter((i) => !readIds.has(i))) {
        await invoke("notification_add", {
          vault,
          json: JSON.stringify({ type: "read", id, ts: Date.now() }),
        }).catch(() => {});
      }
    } catch (e) {
      console.warn("[notify] ask supersede failed (non-fatal):", e);
    }
  }
  await invoke("notification_add", { vault, json: JSON.stringify(rec) }).catch(() => {});
  broadcast({ type: "notif" });
  // The push itself stays one notification-sized line; the full body lives in
  // the feed. Carry the conversation id in the url so a tapped notification
  // deep-links to the asking thread (the service worker + phone.html read
  // ?conv=), instead of just re-focusing whatever chat was open last — the
  // wrong-conversation bug the PROXY spend-fork surfaced.
  // An ask is answered in its own conversation, so every push opens that.
  const pushUrl = convId ? `/phone?conv=${encodeURIComponent(convId)}` : "/phone";
  await sendPush(rec.title as string, (rec.body as string).slice(0, 180), pushUrl).catch(() => {});
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
export async function sendPush(title: string, body: string, url = "/phone", tag = "vault-chat"): Promise<number> {
  let subs: any[] = [];
  try {
    subs = JSON.parse(await invoke<string>("phone_push_subs"));
  } catch {
    return 0;
  }
  if (!Array.isArray(subs) || subs.length === 0) return 0;
  const { pubB64u } = await ensureVapid();
  const payload = te.encode(
    JSON.stringify({ title: title.slice(0, 80), body: body.slice(0, 400), url, tag }),
  );
  let sent = 0;
  for (const sub of subs) {
    try {
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) continue;
      // Made under another VAPID key (the phone says which, phone/src/boot.ts): the push service refuses it, always.
      if (typeof sub.key === "string" && sub.key && sub.key !== pubB64u) {
        void invoke("phone_push_unsub", { endpoint: sub.endpoint }).catch(() => {});
        console.warn("[phone-push] dropped a subscription made under an older VAPID key");
        continue;
      }
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
        void invoke("phone_push_result", { endpoint: sub.endpoint, ok: true }).catch(() => {});
      } else {
        // 400/403 on every push is a subscription the service will never take: pruned after a few in a row.
        const gone = status >= 400 && status < 500 && status !== 429 ? await invoke<boolean>("phone_push_result", { endpoint: sub.endpoint, ok: false }).catch(() => false) : false;
        console.warn(`[phone-push] push service answered ${status}${gone ? " — the subscription is dead, removed" : ""}`);
      }
    } catch (e) {
      console.warn("[phone-push] delivery failed:", e);
    }
  }
  return sent;
}


// ---- wiring ----

let started = false;

// ---- note titles (box-side, disk-based) ----
// Generate Note.title (a short scannable headline distinct from the body) for
// notes that lack one, on the box where the API keys live. DISK-based on
// purpose: the box's in-memory notes can be empty/unloaded, and a store-based
// writeAllNotes would then blank the file — so we read the jsonl fresh, patch,
// and re-read right before writing to avoid clobbering a concurrent change. A
// single file read when everything is already titled, so it's safe to poll; and
// because it titles per-line it self-heals an untitled duplicate that a
// cross-machine union-merge adds back.
// Collapse the duplicate physical lines that merge=union accumulates in
// notes.jsonl (a status flip rewrites the row; two machines editing concurrently
// each leave one). readNotes already dedupes on read so the count is always
// correct, but the file would grow unbounded — this rewrites it to the deduped
// set. Idempotent: a no-op write-skip when already compact, so it's safe on the
// same launch+poll cadence as the title backfill. Box-only on purpose: the box
// is the sole active writer (see sync architecture), so a follower rewriting
// here would just churn history.
async function compactNotesOnBox(): Promise<void> {
  const vault = useStore.getState().vaultPath ?? "";
  if (!vault) return;
  try {
    const { compactNotes } = await import("./notes");
    const collapsed = await compactNotes(vault);
    if (collapsed > 0) console.log(`[phone-app] compacted notes.jsonl: −${collapsed} duplicate line(s)`);
  } catch (e) {
    console.warn("[phone-app] compactNotes failed:", e);
  }
}

let titlingInFlight = false;
async function ensureNoteTitles(vault: string): Promise<void> {
  if (!vault || titlingInFlight) return;
  titlingInFlight = true;
  try {
    const { readNotes, writeAllNotes, titleableText } = await import("./notes");
    const disk = await readNotes(vault);
    const todo = disk
      .filter((n) => (n.title == null || n.title === "") && titleableText(n))
      .slice(0, 12);
    if (!todo.length) return;
    const { titleForNote } = await import("./notes-format");
    const titles = new Map<string, string>();
    for (const n of todo) {
      try {
        const t = await titleForNote(n);
        if (t) titles.set(n.id, t);
      } catch (e) {
        console.warn("[phone-app] note title gen failed:", e);
      }
    }
    if (!titles.size) return;
    // Re-read so a note created/edited while we were generating isn't lost.
    const fresh = await readNotes(vault);
    let changed = false;
    const updated = fresh.map((n) => {
      if ((n.title == null || n.title === "") && titles.has(n.id)) {
        changed = true;
        return { ...n, title: titles.get(n.id)! };
      }
      return n;
    });
    if (changed) await writeAllNotes(vault, updated);
  } catch (e) {
    console.warn("[phone-app] ensureNoteTitles failed:", e);
  } finally {
    titlingInFlight = false;
  }
}

export async function startPhoneAppHost(): Promise<void> {
  if (started) return;
  started = true;

  // Backfill note headlines shortly after launch, then poll — cheap (one file
  // read) when everything is titled, and it catches notes synced in from other
  // machines as well as ones jotted on the phone.
  setTimeout(() => {
    void compactNotesOnBox();
    void ensureNoteTitles(useStore.getState().vaultPath ?? "");
  }, 8_000);
  setInterval(() => {
    void compactNotesOnBox();
    void ensureNoteTitles(useStore.getState().vaultPath ?? "");
  }, 5 * 60_000);

  // Hand the server our VAPID public key so the page can subscribe.
  void ensureVapid()
    .then(({ pubB64u }) => invoke("phone_set_vapid", { key: pubB64u }))
    .catch((e) => console.warn("[phone-app] vapid init failed:", e));

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
          quietUnlessAlert: !!sc.quietUnlessAlert,
          // One-offs are the agent's own self-scheduled wakes (it sets a one-time
          // Schedule for its next check, which self-destructs after firing).
          // Those are background plumbing, not something the user monitors — the
          // phone hides them from the Scheduled list.
          once: sc.recurrence.kind === "once",
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

  // Capture a new note from the phone. Pure text capture (no anchors) — the same
  // shape the desktop's quick-note and the voice CreateNote produce. addNote
  // appends to notes.jsonl and updates the in-memory store, so it shows up on the
  // desktop live and on the phone's next /notes fetch.
  await listen<{ reqId: string; text?: string }>("phone:note", async (event) => {
    const { reqId, text } = event.payload;
    try {
      const s = useStore.getState();
      if (!s.vaultPath) {
        respond(reqId, { error: "no vault open" });
        return;
      }
      const t = (text ?? "").trim();
      if (!t) {
        respond(reqId, { error: "empty note" });
        return;
      }
      const { buildNote } = await import("./notes");
      const note = buildNote({ anchors: [], userDraft: t });
      await s.addNote(note);
      respond(reqId, { ok: true, id: note.id });
      // Give the new note a scannable headline (best-effort, off the response path).
      void ensureNoteTitles(s.vaultPath);
    } catch (e) {
      respond(reqId, { error: String(e) });
    }
  });

  // [experience-log] The phone streams UI events (card renders, option taps, send
  // outcomes, errors) so a bug report is a REPLAY of the real session rather than
  // a description. Append them to client-events.jsonl. STRICTLY best-effort —
  // always respond ok, never throw; logging must never affect the app.
  await listen<{ reqId: string; [k: string]: unknown }>("phone:client-event", async (event) => {
    const { reqId, ...ev } = event.payload as { reqId: string; [k: string]: unknown };
    try {
      const s = useStore.getState();
      if (s.vaultPath) {
        await invoke("client_event_append", { vault: s.vaultPath, line: JSON.stringify(ev) }).catch(() => {});
      }
    } catch {
      /* logging must never surface */
    }
    respond(reqId, { ok: true });
  });

  // Resolve / reopen a note from the phone (swipe-to-resolve). Apply the change
  // against the FRESHEST on-disk notes — never the box's in-memory store, which
  // can be empty or stale (a store-based rewrite would then blank the file). We
  // bump last_updated so the cross-machine union merge keeps this status change
  // as the winner over an older copy on another machine.
  await listen<{ reqId: string; id?: string; status?: string }>(
    "phone:note-status",
    async (event) => {
      const { reqId, id, status } = event.payload;
      try {
        const s = useStore.getState();
        if (!s.vaultPath) {
          respond(reqId, { error: "no vault open" });
          return;
        }
        const noteId = (id ?? "").trim();
        if (!noteId) {
          respond(reqId, { error: "missing note id" });
          return;
        }
        const next: "open" | "resolved" = status === "open" ? "open" : "resolved";
        const { readNotes, writeAllNotes } = await import("./notes");
        const disk = await readNotes(s.vaultPath);
        const now = new Date().toISOString();
        let found = false;
        const updated = disk.map((n) =>
          n.id === noteId ? ((found = true), { ...n, status: next, last_updated: now }) : n,
        );
        if (!found) {
          respond(reqId, { error: "note not found" });
          return;
        }
        await writeAllNotes(s.vaultPath, updated);
        // Keep the box's in-memory store coherent if notes are loaded there.
        if (s.notesLoaded) {
          useStore.setState((st) => ({
            notes: st.notes.map((n) =>
              n.id === noteId ? { ...n, status: next, last_updated: now } : n,
            ),
          }));
        }
        respond(reqId, { ok: true, id: noteId, status: next });
      } catch (e) {
        respond(reqId, { error: String(e) });
      }
    },
  );

  // Edit a note's text from the phone (swipe right → edit sheet, note 002c8029).
  // Same freshest-on-disk contract as note-status: apply against readNotes, bump
  // last_updated so the edit wins the cross-machine union merge, and clear the
  // AI headline so it regenerates to match the new content.
  await listen<{ reqId: string; id?: string; text?: string }>("phone:note-edit", async (event) => {
    const { reqId, id, text } = event.payload;
    try {
      const s = useStore.getState();
      if (!s.vaultPath) {
        respond(reqId, { error: "no vault open" });
        return;
      }
      const noteId = (id ?? "").trim();
      const t = (text ?? "").trim();
      if (!noteId) {
        respond(reqId, { error: "missing note id" });
        return;
      }
      if (!t) {
        respond(reqId, { error: "empty note text" });
        return;
      }
      const { readNotes, writeAllNotes } = await import("./notes");
      const disk = await readNotes(s.vaultPath);
      const now = new Date().toISOString();
      let found = false;
      const updated = disk.map((n) =>
        n.id === noteId ? ((found = true), { ...n, user_draft: t, title: null, last_updated: now }) : n,
      );
      if (!found) {
        respond(reqId, { error: "note not found" });
        return;
      }
      await writeAllNotes(s.vaultPath, updated);
      if (s.notesLoaded) {
        useStore.setState((st) => ({
          notes: st.notes.map((n) =>
            n.id === noteId ? { ...n, user_draft: t, title: null, last_updated: now } : n,
          ),
        }));
      }
      respond(reqId, { ok: true, id: noteId });
      // Re-headline off the response path — the edited body needs a fresh title.
      void ensureNoteTitles(s.vaultPath);
    } catch (e) {
      respond(reqId, { error: String(e) });
    }
  });

  // Reopen a shipped feedback ticket IN PLACE when the boss says the fix didn't
  // take (report 8dabd9b1). Older builds minted a SECOND "REOPENED <id>" note —
  // a dead duplicate — while the original card sat as a permanent red dead-end.
  // Now we re-open the SAME note (same id): stamp `reopened_at` so the feedback
  // queue treats the prior fixer verdict as stale, and bump `timestamp` +
  // `last_updated` to now so the ticket clears the fixer's watermark and re-enters
  // the queue as fresh, actionable work. Same freshest-on-disk contract as the
  // other note relays. A [reopened] marker is appended to the body so the fixer
  // (and the ticket's brief) know to re-diagnose from scratch.
  await listen<{ reqId: string; id?: string }>("phone:note-reopen", async (event) => {
    const { reqId, id } = event.payload;
    try {
      const s = useStore.getState();
      if (!s.vaultPath) {
        respond(reqId, { error: "no vault open" });
        return;
      }
      const noteId = (id ?? "").trim();
      if (!noteId) {
        respond(reqId, { error: "missing note id" });
        return;
      }
      const { readNotes, writeAllNotes } = await import("./notes");
      const disk = await readNotes(s.vaultPath);
      const now = new Date().toISOString();
      const marker =
        "\n\n[reopened] The shipped fix didn't take — re-diagnose from scratch, don't repeat the same change.";
      let found = false;
      const updated = disk.map((n) => {
        if (n.id !== noteId) return n;
        found = true;
        const draft = n.user_draft ?? "";
        const body = draft.includes("[reopened]") ? draft : draft + marker;
        return {
          ...n,
          status: "open" as const,
          user_draft: body,
          reopened_at: now,
          timestamp: now,
          last_updated: now,
        };
      });
      if (!found) {
        respond(reqId, { error: "note not found" });
        return;
      }
      await writeAllNotes(s.vaultPath, updated);
      if (s.notesLoaded) {
        useStore.setState((st) => ({
          notes: st.notes.map((n) =>
            n.id === noteId
              ? {
                  ...n,
                  status: "open" as const,
                  reopened_at: now,
                  timestamp: now,
                  last_updated: now,
                }
              : n,
          ),
        }));
      }
      respond(reqId, { ok: true, id: noteId });
    } catch (e) {
      respond(reqId, { error: String(e) });
    }
  });

  // Empty the resolved pile from the phone (the "Clear all" in Resolved Notes).
  // Flip every resolved note to the terminal `cleared` status against the
  // FRESHEST on-disk notes — never a filter-and-rewrite, which would drop the
  // rows and let the union merge resurrect them from another machine's copy
  // (the schedule-tombstone trap). A bumped last_updated + cleared > resolved
  // (preferredNote) makes the clear win the cross-machine merge.
  await listen<{ reqId: string }>("phone:notes-clear-resolved", async (event) => {
    const { reqId } = event.payload;
    try {
      const s = useStore.getState();
      if (!s.vaultPath) {
        respond(reqId, { error: "no vault open" });
        return;
      }
      const { readNotes, writeAllNotes } = await import("./notes");
      const disk = await readNotes(s.vaultPath);
      const now = new Date().toISOString();
      let cleared = 0;
      const updated = disk.map((n) =>
        n.status === "resolved"
          ? ((cleared += 1), { ...n, status: "cleared" as const, last_updated: now })
          : n,
      );
      if (cleared > 0) await writeAllNotes(s.vaultPath, updated);
      // Keep the box's in-memory store coherent if notes are loaded there.
      if (cleared > 0 && s.notesLoaded) {
        useStore.setState((st) => ({
          notes: st.notes.map((n) =>
            n.status === "resolved" ? { ...n, status: "cleared" as const, last_updated: now } : n,
          ),
        }));
      }
      respond(reqId, { ok: true, cleared });
    } catch (e) {
      respond(reqId, { error: String(e) });
    }
  });

  // The phone opened a thread — promote it into the recent/Chats list. Mission
  // and worker threads live on Activity and stay out of recent by default; the
  // moment the user views one it flips `surfaced` and joins recent so they can
  // get back to it. Setting it on the conversations list triggers the store's
  // debounced autosave, which persists + syncs it (so a worker surfaced on the
  // phone also shows in the desktop's list). No-op for already-surfaced threads
  // and for normal chats (manual/voice/phone), which are in recent regardless.
  await listen<{ reqId: string; convId?: string }>("phone:surface", async (event) => {
    const { reqId, convId } = event.payload;
    try {
      const s = useStore.getState();
      const conv = convId ? s.conversations.find((c) => c.id === convId) : undefined;
      // Worker/mission threads live on Activity and stay out of recent by
      // default. Opening one both surfaces it AND bumps lastActivityAt so it
      // pins to the TOP of recent — matching the desktop's selectConversation,
      // and the note's ask ("pin that chat to top … instead it disappears").
      // Bump on every open (not just first surface) so re-opening re-pins.
      const isWorkerOrMission =
        !!conv && (conv.source === "worker" || conv.source === "mission");
      if (isWorkerOrMission) {
        useStore.setState((st) => ({
          conversations: st.conversations.map((c) =>
            c.id === convId
              ? { ...c, surfaced: true, lastActivityAt: Date.now() }
              : c,
          ),
        }));
      }
      respond(reqId, { ok: true });
    } catch (e) {
      respond(reqId, { error: String(e) });
    }
  });

  // Vault-only resolver for routes that read disk directly (/conversations,
  // /file) — works even when no ElevenLabs key exists for the voice context.
  await listen<{ reqId: string }>("phone:vault", (event) => {
    respond(event.payload.reqId, useStore.getState().vaultPath ?? "");
  });

  // Purge the chats list: tombstone-delete every idle assistant chat. Archived
  // mission threads are untouched (they are history), as is anything mid-run.
  await listen<{ reqId: string }>("phone:clearchats", async (event) => {
    try {
      const s = useStore.getState();
      if (!s.vaultPath) {
        respond(event.payload.reqId, { error: "no vault open" });
        return;
      }
      const victims = s.conversations.filter(
        (c) =>
          !isArchivedThread(c) &&
          c.status !== "running" &&
          !(s.busy && s.activeConversationId === c.id),
      );
      // Await the tombstone writes before acking: the phone refreshes its chats
      // list as soon as this responds, and a fire-and-forget delete let that
      // refresh re-read the still-on-disk chats before their tombstones flushed.
      const del = useStore.getState().deleteConversation;
      await Promise.all(victims.map((v) => del(v.id)));
      respond(event.payload.reqId, { ok: true, cleared: victims.length });
    } catch (e) {
      respond(event.payload.reqId, { error: String(e) });
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
}
