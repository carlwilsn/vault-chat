// The phone app's behaviour: the former <script id="phone-ts"> body of
// src-tauri/assets/phone.html, unchanged except for the module wrapper and the
// bundled imports (ElevenLabs from npm instead of esm.sh). It drives the shell
// that React renders (App.tsx) through element ids, exactly as before.
import { installMock } from "./mock";
import * as X from "./extras";
import { createPhoneMarkdown, domToHtml } from "./markdown";
import { stripAudioTags } from "../../src/voiceTags";
import { isControlLine, isFillerLine } from "../../src/voicePrompt";
import { QuietGate } from "../../src/voiceQuiet";
import { SPEECH_LEVEL } from "../../src/voiceHealth";
import { AUDIO_WARN_LINE, MicPin, audioBlocked, canPickOutput, deviceLists, listAudioDevices } from "../../src/voiceMic";
import { PlaybackMonitor, roomAudioStats } from "../../src/voiceStats";
import { VoiceLogShipper } from "../../src/voiceShip";
import { VoiceImagePusher } from "../../src/voiceImages";
import { VoiceUpdates, pushStartImages } from "../../src/voiceFront";
import { BrainConversation } from "../../src/voiceBrainClient";
import { WaitTracker, calibFrom, renderWaitLine, waitInputs, type WaitCalib } from "../../src/voiceWaitLine";
import type { LogRecord } from "../../src/convlog/protocol";
import { emptyPicture, emptyRow, foldInto, pendingOf, reduceRow, shown, type Picture, type RowState } from "../../src/convlog/reduce";
import { afterClear, makeChatView, type ChatView } from "../../src/convlog/view";
import { MAIN_ID, MAIN_TITLE, isOlderChat, panelModel, projectThreadId } from "../../src/threads";
import { startAttentionBeat, type AttentionBeat } from "../../src/attentionBeat";

export function boot(): void {
  const qs = new URLSearchParams(location.search);
  const MOCK = qs.get("mock") === "1";

  const sdkPromise = MOCK ? Promise.resolve(null) : import("@elevenlabs/client").catch(() => null);

  let TOKEN = qs.get("token") || "";
  try {
    if (TOKEN) localStorage.setItem("vc_phone_token", TOKEN);
    else TOKEN = localStorage.getItem("vc_phone_token") || "";
  } catch {}
  // The box's vault this page shows: ?vault= (a push names its vault), else the
  // one picked last; none = the box's main vault. A push for a conversation
  // without a vault is the main vault's.
  let VAULT = qs.get("vault") || "";
  try {
    if (qs.has("vault") || qs.has("conv")) {
      if (VAULT) localStorage.setItem("vc_phone_vault", VAULT);
      else localStorage.removeItem("vc_phone_vault");
    } else VAULT = localStorage.getItem("vc_phone_vault") || "";
  } catch {}
  const inVault = (path: string) => (VAULT ? path + (path.includes("?") ? "&" : "?") + "vault=" + encodeURIComponent(VAULT) : path);
  const $ = (id: string): any => document.getElementById(id);
  const toastEl = $("toast");
  let toastT = 0;
  const toast = (m: string) => { toastEl.textContent = m; toastEl.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove("show"), 2600); try { logEvent("toast", { msg: (m || "").slice(0, 160) }); } catch {} };
  if (!TOKEN && !MOCK) {
    // No stored/URL token — but the box provisions an httpOnly auth cookie when it
    // serves this shell (self-heal after iOS evicts storage or a home-screen launch
    // drops ?token=). So PROCEED and let the cookie authorize the data calls; fall
    // back to the manual-link gate only if the box actually rejects us. Hard-
    // blocking here was the "No access token" dead-end that a valid cookie couldn't
    // rescue. Non-blocking probe, so startup isn't delayed.
    fetch("/status").then((r) => {
      if (r.status === 401) {
        document.body.innerHTML = '<div class="gate"><b style="color:var(--text)">No access token</b><div>Open the phone link from vault-chat Settings once — it carries the token, which is then remembered on this device.</div></div>';
      }
    }).catch(() => {});
  }

  // ---------- mock box (test mode only) ----------
  if (MOCK) installMock();

  const api = (path: string, opts: RequestInit = {}) => fetch(inVault(path), { ...opts, headers: { "X-Vault-Token": TOKEN, ...(opts.headers || {}) } });
  // [experience-log] Fire-and-forget: stream what the user SEES and TAPS to a
  // synced client-events.jsonl, so a bug report becomes a replay of the real
  // session instead of a description ("I need Claude to see what I saw"). Never
  // throws, never blocks — a missing/failing endpoint just drops the event.
  let __alertsSig = "";
  function logEvent(type: string, detail?: Record<string, any>) {
    try {
      api("/client-event", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: Date.now(), type, page, ...(detail || {}) }) }).catch(() => {});
    } catch {}
  }
  // [list-busy] A background refresh (an SSE run/notif tick, or returning to the
  // foreground) rebuilds a whole list via innerHTML — which resets scrollTop AND
  // discards per-card closure state, most importantly a clear-all's two-tap
  // "armed" flag. During an active mission those ticks arrive constantly, so one
  // landing inside the 3s arm window silently reset the confirm and the button
  // "did nothing" (the clear-all weirdness), or yanked the archive back to the
  // top mid-cleanup. Fix: while the user is actively touching a list — or has a
  // control armed — DEFER the background rebuild until they go idle. Reloads the
  // user asked for (tab switch, post-swipe reconcile) still run immediately.
  let listBusyUntil = 0, softReloadT = 0;
  const markListBusy = (ms = 4000) => { listBusyUntil = Date.now() + ms; };
  function softReload(fn) {
    const wait = listBusyUntil - Date.now();
    if (wait <= 0) { void fn(); return; }
    clearTimeout(softReloadT);
    softReloadT = setTimeout(() => softReload(fn), wait + 60);
  }
  const fileUrl = (p) => inVault("/file?path=" + encodeURIComponent(p) + "&token=" + encodeURIComponent(TOKEN));
  // Pull a worker thread into the recent/Chats list so you can find it again
  // ("view history"). ONLY the thread-open entry points call this — opening a
  // thread from the recent list, and the 3s sheet polls, deliberately do NOT —
  // so a worker no longer re-pins to the top or re-marks itself unread when it's
  // reopened from the pane (note ec78cbf8). Fetching a conversation is now
  // side-effect-free; this is the explicit "surface it" signal.
  const surfaceThread = (id) => {
    if (!id) return;
    api("/surface?id=" + encodeURIComponent(id)).catch(() => {});
    // The pin bumps lastActivityAt to "now" on the box. YOU opened it, so it
    // must not then read as unread on this device: re-stamp the seen watermark
    // just after the bump lands so the pin can't out-run it.
    setTimeout(() => markSeen(id), 1500);
  };

  // ---------- markdown ----------
  // The desktop's pipeline (./markdown.ts → src/mdPipeline.ts): the same math
  // scanner, tables, nested lists, code, footnotes and sanitised HTML as the
  // viewer and the chat, rendered to HTML with KaTeX already applied.
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const md = createPhoneMarkdown({ toHtml: domToHtml(), fileUrl });
  // Nothing to typeset: KaTeX ran in the pipeline. (A DOM pass would turn an
  // escaped dollar pair back into math.) Kept so the call sites read as before.
  function typeset(_elm) {}

  // ---------- state ----------
  let page = "chat";
  // Phase 3. Threads from the old missions system: archived, read-only.
  const ARCHIVED_SOURCES = new Set(["mission", "worker", "ask"]);
  // The vault's projects (GET /projects), for names and the project sheet.
  let projects = [];
  // The open conversation's meta (project + ongoing work), from /conversation.
  let convMeta: any = {};
  // A new chat started "in" a project: sent with the first /message.
  let newChatProject = "";
  let convId = null, convTitle = "New chat";
  // Says to the box whether Carl is looking at the phone (started under "lifecycle").
  let attention: AttentionBeat | null = null;
  // The open thread's source ("phone" | "mission" | "worker" | …). Missions and
  // workers run in the BACKGROUND (their executor being busy is not "your turn
  // generating"), so the composer must never offer the stop square for them —
  // see stopMode().
  let convSource = null;
  let running = false, stopping = false, streamText = "", streamTool = "", streamStartedAt = null;
  let vWaitTools: any[] = [], vWaitMsgs: any[] = []; // the voice's waiting line reads these (vWaitLine)
  // Per-conversation activity, for the drawer rows AND the conversations icon:
  //  • convRunning — convIds generating right now → a white pulsing "thinking" dot.
  //  • convUnseen  — convIds whose run FINISHED while you were looking at another
  //    conversation (or elsewhere in the app) this session → a solid dot.
  // That "a parallel conversation finished a reply while I was looking elsewhere"
  // case is the ONLY thing that earns an unread dot (note 9693499e). convUnseen is
  // populated purely from live/status finishes (see applyRunningSet + the status
  // handler) — NEVER derived from a conversation's age or a persisted watermark.
  // So old chats never badge (you didn't miss a reply on them this sitting), and a
  // reload / app-update starts clean instead of resurrecting stale "unread"s.
  // Opening a thread clears its unseen state.
  const convRunning = new Set();
  const convUnseen = new Set();
  let __dotState = ""; // last-logged conversations-icon dot state (think/solid/off)
  // The conversations icon tracks YOUR chats only. A mission/worker self-wake
  // ending in the background must never light it (note 8c84fc31 — "the icon is
  // not accurate": CADENCE-FAST's 2-minute wakes kept flipping the dot as each
  // wake started/ended). Eligible = a thread you actually converse in: a
  // phone/manual chat, or any thread you sent a message to this session.
  const convSourceById = new Map();
  const userEngaged = new Set();
  function dotEligible(id) {
    if (!id) return false;
    // The conversations icon mirrors the drawer, and the drawer shows ONLY your
    // chats — missions/workers/asks live on Activity or behind their alert cards,
    // never in this panel (see the source filter in loadConvs). So a steered
    // mission finishing in the background must NOT light an icon whose panel will
    // never list it (report afc7971c: "the indicator was up but no conversations
    // in the panel"). Exclude those sources even when you engaged the thread.
    const s = convSourceById.get(id);
    if (s === "mission" || s === "worker" || s === "ask") return false;
    if (userEngaged.has(id) || id === convId) return true;
    return s === "phone" || s === "manual";
  }
  // One-time purge of the old per-conversation "seen" watermark. It used to drive
  // unread off conversation age, which spuriously badged old chats and resurfaced
  // "cleared" ones after an app update (note 9693499e). Nothing reads it now;
  // drop it so a stale copy on-device can never be misread by a future change.
  try { localStorage.removeItem("vc_phone_seen"); } catch {}
  function markSeen(id) { if (!id) return; convUnseen.delete(id); updateConvDot(); }
  function updateConvDot() {
    const dot = $("convdot"); if (!dot) return;
    // The icon is about BACKGROUND threads — the ones you can't see right now.
    // A conversation you're currently viewing (the open main chat, or a thread
    // open in the sheet) must NOT light the dot: you can already watch it work.
    // Its whole purpose is "is one of my OTHER conversations still running /
    // finished while I wasn't looking" (note 85c11485).
    const viewing = (id) => id === convId;
    let running = false; for (const id of convRunning) { if (!viewing(id)) { running = true; break; } }
    let anyUnseen = false; for (const id of convUnseen) { if (!viewing(id)) { anyUnseen = true; break; } }
    const unseen = !running && anyUnseen;
    dot.classList.toggle("on", running || unseen);
    dot.classList.toggle("think", running);
    dot.classList.toggle("solid", unseen);
    // [experience-log] Record every change of the conversations-icon dot with
    // WHY (which threads are running / unseen, what you're viewing) — the
    // "unread indicator is out of whack" complaint is unreconstructable without
    // seeing when it lit and what it was tracking at that moment.
    const st = running ? "think" : unseen ? "solid" : "off";
    if (st !== __dotState) { __dotState = st; try { logEvent("convdot", { state: st, running: [...convRunning], unseen: [...convUnseen], viewing: convId || null }); } catch {} }
  }
  // Reconcile the running set against the heartbeat-backed /status truth. A conv
  // that WAS running and no longer is — and that you weren't looking at — becomes
  // done-unseen. Catches finishes even if the live status event was missed.
  function applyRunningSet(ids) {
    // Only YOUR chats count (dotEligible) — harness wakes on missions/workers
    // used to churn through here and light the dot for plumbing.
    const next = new Set((ids || []).filter(dotEligible));
    for (const id of convRunning) { if (!next.has(id) && id !== convId) convUnseen.add(id); }
    convRunning.clear();
    for (const id of next) { convRunning.add(id); convUnseen.delete(id); }
    updateConvDot();
  }
  let vaultName = "", boxModel = "", boxVersion = "";
  let unreadN = 0, offlineStreak = 0;
  const msgsEl = $("msgs"), input = $("input"), sendBtn = $("sendBtn");
  // One-tap send with the keyboard up (note 85933e24). A plain onclick needed
  // TWO taps on iOS: the first tap blurred the textarea → the keyboard
  // collapsed → the layout shifted → the click landed nowhere. preventDefault
  // on pointerdown keeps focus (and the keyboard) exactly where they are; the
  // action fires on pointerup, and the trailing synthetic click is swallowed.
  // The bare click handler stays as the fallback for non-pointer browsers.
  function wireTap(btn, fn) {
    if (!btn) return;
    let tappedAt = 0;
    btn.addEventListener("pointerdown", (e) => e.preventDefault());
    btn.addEventListener("pointerup", (e) => { e.preventDefault(); tappedAt = Date.now(); fn(); });
    btn.addEventListener("click", () => { if (Date.now() - tappedAt < 700) return; fn(); });
  }
  // composer glyphs are drawn, not typed — one icon voice with the rest of the app
  const SEND_ARROW_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M6 12l6-6 6 6"/></svg>';
  const SEND_STOP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';

  // Cosmetic "clear chats": a per-device hidden set. Never deletes anything on
  // the box or in git — the chats just stop rendering in this drawer.
  const HIDDEN_KEY = "vc_phone_hidden_chats";
  let lastChatList = [];
  function hiddenChats() { try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]")); } catch { return new Set(); } }
  const age = (ts) => { while (ts >= 1e14) ts = Math.floor(ts / 1000); const m = Math.floor((Date.now() - ts) / 60000); if (m < 1) return "now"; if (m < 60) return m + "m"; const h = Math.floor(m / 60); if (h < 24) return h + "h"; return Math.floor(h / 24) + "d"; };

  // ---------- pages ----------
  function setPage(name) {
    // [experience-log] The spine of a replay: every page the user lands on, in
    // order. `page` still holds the page we're leaving here — log both so the
    // path reads "chat → alerts → activity" and a swipe/clear event can be
    // placed on the page it happened.
    if (name !== page) { try { logEvent("nav", { to: name, from: page }); } catch {} }
    page = name;
    document.body.classList.remove("page-chat", "page-activity", "page-alerts", "page-notes");
    document.body.classList.add("page-" + name);
    document.querySelectorAll<HTMLElement>(".mrow[data-page]").forEach((r) => r.classList.toggle("cur", r.dataset.page === name));
    if (name !== "chat") hideKb();
    if (name === "alerts") void loadAlerts();
    if (name === "notes") void loadNotes();
    setHeader();
  }
  document.querySelectorAll<HTMLElement>(".mrow[data-page]").forEach((r) => (r.onclick = () => { closeMenu(); closeDrawer(); setPage(r.dataset.page); }));

  function setHeader() {
    const off = document.body.classList.contains("offline");
    const tx = $("titleTx"), sub = $("titleSub");
    if (page === "chat") {
      if (convId && convTitle && convTitle !== "New chat") { tx.textContent = convTitle; }
      else { tx.textContent = ""; }
      // The project chip: the project's name beside the title; tap the title to change it.
      const pj = convId ? convMeta.project : newChatProject;
      const total = convId && X.choice("cost") === "total" ? X.fmtCost(convMeta.costUsd) : "";
      sub.innerHTML = esc(pj ? projectName(pj) : "") + (total ? (pj ? " · " : "") + '<span data-el="total-cost">' + total + "</span>" : "");
    } else { tx.textContent = page === "notes" ? "Notes" : "Alerts"; sub.textContent = ""; }
    const mAl = $("mAl"); mAl.textContent = unreadN; mAl.classList.toggle("zero", unreadN === 0);
    $("menudot").classList.toggle("on", unreadN > 0 && page !== "alerts");
  }
  function setOffline(off) { document.body.classList.toggle("offline", off); setHeader(); }

  // ---------- menus ----------
  const menu = $("menu");
  function closeMenu() { menu.classList.remove("on"); }
  $("menuBtn").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("on"); };
  document.addEventListener("click", closeMenu);
  menu.addEventListener("click", (e) => e.stopPropagation());
  $("settingsRow").onclick = () => { closeMenu(); openDrawer(); };
  // The vault switcher: a row per vault at the top of the menu, only when the
  // box has two or more. Picking one reloads the page on it.
  function switchVault(name: string) {
    try { if (name) localStorage.setItem("vc_phone_vault", name); else localStorage.removeItem("vc_phone_vault"); } catch {}
    const q = new URLSearchParams(location.search);
    q.delete("conv");
    if (name) q.set("vault", name); else q.delete("vault");
    const s = q.toString();
    location.replace(location.pathname + (s ? "?" + s : ""));
  }
  let vaultIsMain = true;
  async function loadVaults() {
    try {
      const d = await (await api("/api/v1/vaults")).json();
      const list: { name: string; main?: boolean }[] = Array.isArray(d.vaults) ? d.vaults : [];
      // The vault picked here is gone from the box: back to the main one.
      if (VAULT && list.length && !list.some((v) => v.name === VAULT)) return switchVault("");
      const box = $("vaultRows");
      if (!box || list.length < 2) return;
      vaultIsMain = !VAULT || !!list.find((v) => v.name === VAULT)?.main;
      const cur = VAULT || list.find((v) => v.main)?.name || "";
      box.innerHTML = "";
      for (const v of list) {
        const b = document.createElement("button");
        b.className = "mrow" + (v.name === cur ? " cur" : "");
        b.dataset.vault = v.name;
        b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span class="nm"></span>';
        b.querySelector(".nm")!.textContent = v.name;
        b.onclick = () => { closeMenu(); if (v.name !== cur) switchVault(v.name); };
        box.appendChild(b);
      }
      box.hidden = false;
    } catch {}
  }
  void loadVaults();

  const cdraw = $("cdraw"), scrim = $("scrim");
  function openConvs() { scrim.classList.add("on"); cdraw.classList.add("on"); document.body.classList.add("cdraw-open"); void loadConvs(); }
  function closeConvs() { scrim.classList.remove("on"); cdraw.classList.remove("on"); document.body.classList.remove("cdraw-open"); }
  $("convBtn").onclick = openConvs;
  scrim.onclick = closeConvs;
  // [swipe-open] Swipe right from the left edge of the chat page and the
  // conversations drawer follows the finger; release past a third of its
  // width (or a flick) commits, anything less snaps back.
  (() => {
    const EDGE = 44;
    let x0 = 0, y0 = 0, mode: any = null, W = 0, lastX = 0, lastT = 0, vx = 0;
    const onStart = (e: TouchEvent) => {
      mode = null;
      if (page !== "chat" || cdraw.classList.contains("on")) return;
      if ($("sheet").classList.contains("on") || menu.classList.contains("on")) return;
      const t = e.touches[0];
      if (t.clientX > EDGE) return;
      x0 = lastX = t.clientX; y0 = t.clientY; lastT = e.timeStamp; vx = 0;
      W = Math.min(window.innerWidth * 0.87, 342);
      mode = "arm";
    };
    const onMove = (e: TouchEvent) => {
      if (!mode) return;
      const t = e.touches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      if (mode === "arm") {
        if (Math.abs(dx) < 9 && Math.abs(dy) < 9) return;
        if (Math.abs(dy) > Math.abs(dx) || dx <= 0) { mode = null; return; }
        mode = "drag";
        hideKb();
        cdraw.style.transition = "none";
        scrim.classList.add("on");
      }
      if (mode !== "drag") return;
      e.preventDefault();
      const p = Math.max(0, Math.min(1, dx / W));
      cdraw.style.transform = "translateX(" + (-(1 - p) * 102) + "%)";
      scrim.style.opacity = String(0.15 + p * 0.85);
      const dt = e.timeStamp - lastT;
      if (dt > 0) { vx = (t.clientX - lastX) / dt; lastX = t.clientX; lastT = e.timeStamp; }
    };
    const onEnd = () => {
      if (mode !== "drag") { mode = null; return; }
      mode = null;
      const m = /translateX\((-?[\d.]+)%\)/.exec(cdraw.style.transform || "");
      const shown = m ? 1 - Math.abs(parseFloat(m[1])) / 102 : 0;
      cdraw.style.transition = ""; scrim.style.opacity = "";
      // settle on the next frame — or a timeout, because rAF stalls when the
      // page isn't rendering (backgrounded PWA) and the gesture must still land
      const settle = (fn) => { let done = false; const go = () => { if (!done) { done = true; fn(); } }; requestAnimationFrame(go); setTimeout(go, 40); };
      if (shown > 0.33 || vx > 0.45) {
        settle(() => { cdraw.style.transform = ""; openConvs(); });
      } else {
        settle(() => { cdraw.style.transform = ""; scrim.classList.remove("on"); });
      }
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", onEnd, { passive: true });
  })();
  // The ⋯ menu: what is not in the panel itself (src/threads.ts).
  $("newBtn").onclick = () => { closeConvs(); openThreadsMenu(); };
  function openThreadsMenu() {
    const row = (k: string, label: string) => '<button class="arch-row" data-k="' + k + '"><span class="arch-t">' + esc(label) + "</span></button>";
    openSheet({
      intent: "Chats", title: "More", ico: "◎",
      bodyHtml: convId ? row("clear", "Clear this thread") : '<div class="md dim" style="padding:0 18px 10px">Nothing to clear.</div>',
      wire: (body) => {
        body.querySelectorAll(".arch-row[data-k]").forEach((b) => {
          b.onclick = () => {
            const k = b.dataset.k;
            if (k === "clear") { closeSheet(); clearThread(); }
          };
        });
      },
    });
  }
  /** Clear on this phone only (the laptop's view, the conversation and its context are untouched): what is
   *  shown now leaves this view, kept across reloads (src/boxChat.ts afterClear, the laptop's own). */
  const CLEARED_KEY = "vc_phone_cleared";
  let clearedAt: Record<string, string> = (() => { try { return JSON.parse(localStorage.getItem(CLEARED_KEY) || "{}") || {}; } catch { return {}; } })();
  function clearThread() {
    if (!convId || !pic || !picView) return;
    const msgs = picView(pic).messages;
    const last = msgs[msgs.length - 1]?.mid;
    if (!last) return;
    clearedAt = { ...clearedAt, [convId]: last };
    try { localStorage.setItem(CLEARED_KEY, JSON.stringify(clearedAt)); } catch {}
    outgoing = outgoing.filter((o) => o.convId !== convId || !o.failed);
    for (const [, n] of shownNodes) n.el.remove();
    shownNodes.clear();
    renderThread();
  }
  /** "/compact [focus]": the conversation's context compacted now (not a message to the agent). */
  async function compactCommand(text: string): Promise<boolean> {
    const m = /^\/compact(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (!m || !convId) return false;
    try {
      const r = await api("/api/v2/intent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "compact", convId, client: "phone", ...(m[1] && m[1].trim() ? { focus: m[1].trim() } : {}) }) });
      const d = await r.json();
      if (!r.ok || d.error || d.ok === false) throw new Error(d.error || r.status);
      toast(d.compacted === false ? "Nothing to compact yet." : "Compacted.");
    } catch (e: any) {
      toast("Not compacted: " + (e.message || e));
    }
    return true;
  }
  // The title opens the panel (Main and the projects); a thread is not moved between projects any more.
  $("titleBtn").onclick = () => { if (page === "chat") openConvs(); else setPage("chat"); };

  async function loadConvs() {
    const box = $("clist");
    try {
      const [r, sr] = await Promise.all([api("/conversations"), api("/status").catch(() => null)]);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      vaultName = d.vault || vaultName;
      const runIds = new Set();
      if (sr && sr.ok) { const sd = await sr.json().catch(() => ({})); for (const x of sd.runs || []) runIds.add(x.convId); }
      const convs = d.conversations || [];
      void loadProjects();
      // The drawer is your conversations, grouped by project. Threads from the
      // old missions system (mission/worker/ask) stay on disk but aren't
      // listed. The cosmetic hidden set (cleared "from this
      // view") is filtered out, except the chat you're currently in.
      const hidden = hiddenChats();
      // Feed the dot's eligibility map — the icon needs sources to tell your
      // chats from harness threads.
      for (const c of convs) convSourceById.set(c.id, c.source);
      const chats = convs.filter((c) => c.source !== "ask" && c.source !== "worker" && c.source !== "mission" && (!hidden.has(c.id) || c.id === convId));
      // The chat you're in may not be on disk yet (the box persists ~500ms
      // after the first message). Show it anyway so a just-made chat never
      // looks missing.
      if (convId && !chats.some((c) => c.id === convId)) {
        chats.unshift({ id: convId, title: convTitle || "New chat", lastActivityAt: Date.now(), source: "phone", msgCount: 0, preview: "" });
      }
      lastChatList = chats.slice();
      // Reconcile the running set with /status so the row dots and the
      // conversations icon are right on open. Unseen state is NOT seeded here —
      // it only comes from a run finishing while you were looking elsewhere, so
      // opening the drawer never conjures unread dots on chats you didn't miss.
      applyRunningSet([...runIds]);
      // Opening the drawer = looking at your conversations. A chat whose reply
      // finished while you were elsewhere has now been SEEN — clear its unseen
      // so the icon dot stops claiming "unread" after you've looked (the "still
      // out of whack" case: I opened my conversations and the dot stayed on).
      // Scoped to the chats actually shown and only the finished ones — a chat
      // still generating keeps its think-dot; workers/missions aren't here.
      if (cdraw.classList.contains("on")) { for (const c of chats) { if (!runIds.has(c.id)) convUnseen.delete(c.id); } }
      updateConvDot();
      box.innerHTML = "";
      // The left panel, as on the laptop (src/threads.ts): Main on its own, then "Projects" (each its one thread) and
      // + New project, then a separate chat while one exists. No list of older chats (their files stay on the box).
      await loadProjects();
      const { entries } = panelModel(chats.map((c) => ({ ...c, running: runIds.has(c.id) || convRunning.has(c.id), unread: convUnseen.has(c.id) })), projects, convId);
      const sectionLabel = (t: string) => { const h = document.createElement("div"); h.className = "csec"; h.textContent = t; return h; };
      for (const e of entries) {
        if (e.type === "main") {
          const r = convRow({ id: e.id, title: "Main", lastActivityAt: (chats.find((c) => c.id === e.id) || {}).lastActivityAt, preview: "" }, e.running);
          r.dataset.el = "thread-main";
          r.classList.add("main");
          if (e.active) r.classList.add("on");
          box.appendChild(r);
          box.appendChild(sectionLabel("Projects"));
          continue;
        }
        if (e.type === "new-project") {
          const np = el('<button class="csec proj pnew" data-el="new-project"><span class="pn">+ New project</span></button>');
          np.onclick = () => { closeConvs(); openNewProjectSheet(); };
          box.appendChild(np);
          continue;
        }
        const r = convRow({ id: e.id, title: projectName(e.slug) || e.title, lastActivityAt: (chats.find((c) => c.id === e.id) || {}).lastActivityAt, preview: (chats.find((c) => c.id === e.id) || {}).preview || "" }, e.running);
        r.dataset.el = "thread-project";
        if (e.active) r.classList.add("on");
        box.appendChild(r);
      }
    } catch (e) {
      box.innerHTML = '<div class="empty">Couldn’t load: ' + esc(String(e.message || e)) + "</div>";
    }
  }
  /** "+ New project": name it, then its thread opens (POST /projects makes the project and its thread). */
  function openNewProjectSheet() {
    openSheet({
      intent: "Project", title: "New project", ico: "◎",
      bodyHtml: '<div class="md dim" style="padding:0 18px 10px">A project has one thread and its own notes and memory (project.md).</div>',
      footHtml: '<div class="reply"><textarea class="rinp" rows="1" enterkeyhint="enter" placeholder="Project name…" autocomplete="off"></textarea><button class="rsend">' + SEND_ARROW_SVG + "</button></div>",
      wire: (_b, foot) => wireReply(foot, async (name) => {
        const n = String(name || "").trim();
        if (!n) return;
        try {
          const r = await api("/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) });
          const d = await r.json();
          if (!r.ok || d.error) throw new Error(d.error || r.status);
          closeSheet();
          await loadProjects();
          void openThread(d.convId || projectThreadId(d.slug), d.name || n);
        } catch (e: any) { toast("Couldn't make the project: " + (e.message || e)); }
      }),
    });
    setTimeout(() => ($("sheetFoot").querySelector(".rinp") as HTMLTextAreaElement | null)?.focus(), 250);
  }
  function convRow(c, isRunning) {
    const b = document.createElement("button");
    b.className = "crow2";
    const running = isRunning || convRunning.has(c.id);
    const unseen = !running && convUnseen.has(c.id);
    const dot = running ? '<span class="rd think"></span>' : unseen ? '<span class="rd unseen"></span>' : "";
    b.innerHTML = '<div class="t">' + dot + '<span class="nm"></span><span class="ag"></span></div><div class="p"></div>';
    b.querySelector(".nm").textContent = c.title;
    b.querySelector(".ag").textContent = c.lastActivityAt ? age(c.lastActivityAt) : "";
    b.querySelector(".p").textContent = c.preview || "";
    b.onclick = () => { closeConvs(); openThread(c.id, c.title); };
    return b;
  }

  // ---------- projects + the ongoing-work line (Phase 3) ----------
  async function loadProjects() {
    try { const d = await (await api("/projects")).json(); if (Array.isArray(d.projects)) { projects = d.projects; setHeader(); } } catch {}
  }
  // The same slug rule as the server (server/context/files.ts).
  function slugify(name) {
    return String(name).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  }
  function projectName(slug) {
    const p = projects.find((x) => x.slug === slug);
    if (p) return p.name;
    const t = String(slug || "").replace(/-/g, " ");
    return t ? t[0].toUpperCase() + t.slice(1) : "";
  }
  function fmtWake(at) {
    const d = new Date(at), n = new Date();
    const hm = d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");
    if (d.toDateString() === n.toDateString()) return hm;
    if (at > Date.now() && at - Date.now() < 6 * 86400000) return d.toLocaleDateString(undefined, { weekday: "short" }) + " " + hm;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  // "checking the run · next 3:40 · $1.20" — from state / nextWakeAt / costUsd /
  // the last ScheduleWake's reason. Null when the conversation isn't doing long work.
  function ongoingOf(c) {
    if (!c || !c.state) return null;
    // With the total in the header (the "total" option) the line doesn't repeat it.
    const cost = X.choice("cost") !== "reply" ? "" : typeof c.costUsd === "number" && c.costUsd > 0 ? (c.costUsd < 0.01 ? "<$0.01" : "$" + c.costUsd.toFixed(2)) : "";
    let tone = "", label = "", next = "";
    if (c.state === "sleeping") {
      tone = "waiting";
      const r = String(c.wakeReason || "").trim();
      label = r ? r[0].toLowerCase() + r.slice(1) : "Waiting";
      if (c.nextWakeAt && c.nextWakeAt > Date.now() - 60000) next = "next " + fmtWake(c.nextWakeAt);
    }
    else if (c.state === "waiting_user") { tone = "you"; label = "Waiting for you"; }
    else if (c.state === "blocked") { tone = "blocked"; label = "Blocked"; }
    else if (c.state === "done" && c.verdict && X.choice("verdict") === "ongoing") { tone = c.verdict.verdict === "pass" ? "done" : c.verdict.verdict === "fail" ? "blocked" : "waiting"; label = X.verdictLabel(c.verdict); }
    else return null;
    return { tone, text: [label, next, cost].filter(Boolean).join(" · ") };
  }
  function setOngoing(node, og, cls) {
    node.className = cls + (og.tone === "blocked" ? " blocked" : "");
    node.innerHTML = '<span class="od ' + og.tone + '"></span><span class="ogt"></span>';
    node.querySelector(".ogt").textContent = og.text;
  }
  function renderOngoing() {
    const node = $("ongoing");
    const og = convId ? ongoingOf(convMeta) : null;
    if (!og) { node.className = "ongoing"; node.innerHTML = ""; node.removeAttribute("data-el"); return; }
    setOngoing(node, og, "ongoing on");
    if (convMeta.state === "done") node.setAttribute("data-el", "verdict"); else node.removeAttribute("data-el");
  }
  // The open conversation's meta: project, ongoing work, cost, and what the
  // thread shows beside the text (the Done verdict, the to-dos, the subagents).
  function metaOf(d) {
    return { project: d.project, state: d.state, nextWakeAt: d.nextWakeAt, costUsd: d.costUsd, wakeReason: d.wakeReason, verdict: d.verdict, todos: d.todos, subagents: d.subagents };
  }
  // The thread's tail (subagents no reply carries yet, the to-dos, the verdict
  // line) and the pinned area above the composer, per Carl's open choices.
  let tailEl = null;
  function renderExtras() {
    const subs = convId ? convMeta.subagents || [] : [];
    const placed = new Set();
    msgsEl.querySelectorAll('[data-el="subagent"]').forEach((e) => { if (!e.closest("#xtail")) placed.add(e.dataset.sid); });
    const inline = X.choice("subagents") === "inline";
    const tail = (inline ? X.subagentsHtml(subs.filter((x) => !placed.has(x.threadId)), "inline") : "")
      + (X.choice("todos") === "inline" ? X.todosHtml(convId ? convMeta.todos || [] : []) : "")
      + X.verdictHtml(convId ? convMeta.verdict : undefined, convMeta.state);
    if (tail && !msgsEl.querySelector(".hint")) {
      if (!tailEl) { tailEl = document.createElement("div"); tailEl.id = "xtail"; }
      tailEl.innerHTML = tail;
      const before = streamEl || runlineEl;
      if (before && before.parentNode === msgsEl) msgsEl.insertBefore(tailEl, before); else msgsEl.appendChild(tailEl);
    } else if (tailEl) { tailEl.remove(); }
    // In-place updates of the inline cards already in replies (state, cost, summary).
    if (inline) msgsEl.querySelectorAll(".amsg").forEach((a) => {
      const card = a.querySelector(':scope > [data-el="subagents"]');
      if (!card) return;
      const ids = [...card.querySelectorAll('[data-el="subagent"]')].map((e) => e.dataset.sid);
      const fresh = subs.filter((x) => ids.includes(x.threadId));
      if (fresh.length) card.outerHTML = X.subagentsHtml(fresh, "inline");
    });
    const pin = $("pinned");
    // The strip: the newest spawn (one call's children). The pinned plan: while it has work left.
    const last = subs[subs.length - 1];
    const latest = last ? subs.filter((x) => (x.toolCallId || "") === (last.toolCallId || "")) : [];
    const todos = convId ? convMeta.todos || [] : [];
    const planOpen = running || todos.some((t) => t.status !== "completed");
    if (pin) pin.innerHTML = (!inline ? X.subagentsHtml(latest, "strip") : "") + (X.choice("todos") === "pinned" && planOpen ? X.todosHtml(todos) : "");
  }
  setInterval(() => { renderOngoing(); }, 60000);
  // The project sheet: tap the chat's title. Pick, create, clear, or start a
  // new chat in the project. Before the first message it sets the new chat's.
  function openProjectSheet() {
    void loadProjects();
    const cur = convId ? convMeta.project || "" : newChatProject;
    const rows = projects.map((p) => '<button class="arch-row" data-slug="' + esc(p.slug) + '"><span class="arch-t"></span>' + (p.slug === cur ? '<span class="proj-cur">✓</span>' : "") + "</button>").join("");
    openSheet({
      intent: "Project", title: convId ? (convTitle || "This chat") : "New chat", ico: "◎",
      bodyHtml: (rows || '<div class="md dim" style="padding:0 18px 10px">No projects yet — name one below.</div>')
        + (cur ? '<button class="arch-row" data-none="1"><span class="arch-t" style="font-weight:400;color:var(--dim)">No project</span></button>' : "")
        + (cur && convId ? '<button class="arch-row" data-newin="1"><span class="arch-t">+ New chat in ' + esc(projectName(cur)) + "</span></button>" : ""),
      footHtml: '<div class="reply"><textarea class="rinp" rows="1" enterkeyhint="enter" placeholder="New project name…" autocomplete="off"></textarea><button class="rsend">' + SEND_ARROW_SVG + "</button></div>",
      wire: (body, foot) => {
        body.querySelectorAll(".arch-row[data-slug]").forEach((b) => { const pj = projects.find((x) => x.slug === b.dataset.slug); b.querySelector(".arch-t").textContent = pj ? pj.name : b.dataset.slug; b.onclick = () => void pickProject(b.dataset.slug); });
        const none = body.querySelector("[data-none]"); if (none) none.onclick = () => void pickProject("");
        const nw = body.querySelector("[data-newin]"); if (nw) nw.onclick = () => { closeSheet(); newChat(cur); };
        wireReply(foot, (v) => { const t = String(v || "").trim(); if (t) void pickProject(t); });
      },
    });
  }
  async function pickProject(nameOrSlug) {
    if (!convId) { newChatProject = nameOrSlug ? (projects.find((x) => x.name.toLowerCase() === nameOrSlug.toLowerCase())?.slug ?? slugify(nameOrSlug)) : ""; if (nameOrSlug && !projects.some((x) => x.slug === newChatProject)) projects.push({ slug: newChatProject, name: nameOrSlug }); closeSheet(); setHeader(); return; }
    try {
      const r = await api("/conversation/project", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ convId, project: nameOrSlug || null }) });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || r.status);
      convMeta.project = d.project || undefined;
      closeSheet(); void loadProjects(); setHeader();
      if (cdraw.classList.contains("on")) void loadConvs();
    } catch (e) { toast("Couldn't set the project: " + (e.message || e)); }
  }

  // ---------- chat ----------
  // Tool calls for a finished turn, collapsed to a tappable "N steps" summary
  // that expands to the list. ProposeMission is filtered out — it already shows
  // as its own Approve card in the content.
  function stepsStr(tools) {
    const t = (tools || []).filter((x) => x !== "ProposeMission");
    if (!t.length) return "";
    const items = t.map((x) => '<div class="step">' + esc(x) + "</div>").join("");
    return '<div class="steps"><button class="steps-h"><svg class="sck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12l5 5L20 7"/></svg>' +
      t.length + " step" + (t.length === 1 ? "" : "s") +
      '<svg class="scv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></button><div class="steps-list">' +
      items + "</div></div>";
  }
  // [unified ask] Inline option cards riding a reply — the presence-gated ask
  // (same visual language as the deliberation sheet's cards; the "inline"
  // class scopes the main-chat tap wiring). live=false renders them inert —
  // a later message already answered, or they're history.
  function inlineOptionsHtml(opts, live, chosenAns) {
    // [truth] Decided → losers say nothing: show ONLY the chosen option, "selected".
    const shown = chosenAns ? opts.filter((o) => o.answer === chosenAns) : opts;
    return '<div class="delib-proposed inline">' + shown.map((o) => {
      const chosen = !!chosenAns && o.answer === chosenAns;
      return '<div class="delib-opt inline' + (o.primary ? " prim" : "") + (!live || chosen ? " dead" : "") + (chosen ? " chosen" : "") + '" data-ans="' + esc(o.answer) + '" data-q="' + esc((o.body || o.title || o.answer).slice(0, 300)) + '">'
        + '<div class="ot">' + esc(o.title || o.answer)
        + (chosen
          ? '<span class="pick">✓ selected</span>'
          : (live ? '<span class="pick">choose <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>' : ""))
        + "</div>"
        + (o.body ? '<div class="ob">' + esc(o.body) + "</div>" : "")
        + "</div>";
    }).join("") + "</div>";
  }
  function bubble(role: string, content: string, tools?: string[], opts: Record<string, any> = {}) {
    const div = document.createElement("div");
    // A FORMAL decision (a tapped option / committed answer) renders as the
    // same quiet "Your call" receipt the sheets use — one visual language for
    // decisions everywhere.
    if (role === "user" && opts.decision) {
      div.className = "tdecision";
      div.innerHTML = '<span class="td-l">Your call</span>' + esc(content);
      return div;
    }
    // A compaction / roll-over: "Earlier conversation summarized", tap for the summary.
    if (typeof opts.divider === "string") {
      div.innerHTML = X.dividerHtml(md(opts.divider));
      const d = div.firstElementChild as HTMLElement;
      typeset(d);
      return d;
    }
    // Agent replies are bubble-free (full-width markdown); user + system keep
    // their bubbles.
    const asst = role !== "user" && !opts.system;
    div.className = (asst ? "amsg" : "m " + (role === "user" ? "user" : "sys")) + (opts.queued ? " queued" : "");
    if (!asst) div.textContent = content;
    else div.innerHTML = X.thoughtHtml(opts.thinking) + '<div class="md">' + md(Array.isArray(opts.askOptions) && opts.askOptions.length ? X.withoutOptionList(content, opts.askOptions) : content) + "</div>";
    // Images sent with a user turn: thumbnails above its text.
    if (!asst && Array.isArray(opts.images) && opts.images.length)
      div.insertAdjacentHTML("afterbegin", '<div class="mimgs">' + opts.images.map((u) => '<img src="' + esc(u) + '" alt="">').join("") + "</div>");
    // Finished-turn tool calls collapse to a "Ran N steps" summary at the end.
    if (asst) div.insertAdjacentHTML("beforeend", stepsStr(tools));
    // The subagents this turn spawned (inline option), and what the turn cost.
    if (asst && X.choice("subagents") === "inline") div.insertAdjacentHTML("beforeend", X.subagentsHtml(X.spawnsOf(opts.spawns, convMeta.subagents || []), "inline"));
    if (asst) div.insertAdjacentHTML("beforeend", X.costHtml(opts.costUsd));
    // [unified ask] Tappable option cards land WITH the reply that argues for
    // them (a presence-gated AskUser — no push was sent, you're here).
    if (asst && Array.isArray(opts.askOptions) && opts.askOptions.length)
      div.insertAdjacentHTML("beforeend", inlineOptionsHtml(opts.askOptions, !!opts.optionsLive, opts.chosenAnswer || ""));
    if (asst) typeset(div);
    return div;
  }
  const atBottom = () => msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
  // `force`: scroll to the end. A render measures "was he at the bottom" BEFORE it appends and
  // passes that: measured after, a reply landing in one chunk taller than 80 px never followed.
  const scrollDown = (force) => { if (force || atBottom()) msgsEl.scrollTop = msgsEl.scrollHeight; };

  let streamEl = null, runlineEl = null, _shownTool = null;
  // Send (↑) flips to stop (■) while the open thread is running — the standard
  // chatbot interrupt. ONLY for a direct chat (source phone/manual): a mission or
  // worker thread is "running" whenever its BACKGROUND executor is busy — for
  // minutes or hours — and flipping the composer made the only visible button a
  // ■ that KILLS the mission run, exactly when a typed message would simply go
  // to the conversational front ("the send button is weird"). Missions keep ↑
  // always; stopping a mission lives in its Activity sheet, deliberately.
  const stopMode = () => running && !!convId && convSource !== "mission" && convSource !== "worker";
  function syncSendBtn() {
    const stop = stopMode();
    sendBtn.classList.toggle("stop", stop);
    sendBtn.innerHTML = stop ? SEND_STOP_SVG : SEND_ARROW_SVG;
    sendBtn.setAttribute("aria-label", stop ? "stop" : "send");
  }
  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + (s % 60) + "s";
    const h = Math.floor(m / 60);
    return h + "h " + (m % 60) + "m";
  }
  // Elapsed-since-prompt clock on the thinking line — counts from the same start
  // the desktop uses (runStartedAt), continuous across leaving and reopening the
  // thread. A single shared ticker keeps it live without re-rendering the line.
  function updateElapsed() {
    if (!runlineEl) return;
    const e = runlineEl.querySelector(".elapsed");
    if (!e) return;
    e.textContent = running && streamStartedAt ? fmtElapsed(Date.now() - streamStartedAt) : "";
  }
  setInterval(updateElapsed, 1000);
  function renderRunline() {
    syncSendBtn();
    if (!running) { if (runlineEl) { runlineEl.remove(); runlineEl = null; } _shownTool = null; return; }
    if (!runlineEl) {
      runlineEl = document.createElement("div"); runlineEl.className = "thinking";
      runlineEl.innerHTML = '<span class="pulse"></span><span class="tlbl"></span><span class="elapsed"></span>';
      msgsEl.appendChild(runlineEl); _shownTool = null;
    }
    msgsEl.appendChild(runlineEl);
    updateElapsed();
    // The pulse is the "working" sign; beside it, the current tool's name
    // cross-fades in/out — like the desktop app: a tool starts, its name fades
    // in; the next swaps it. No "running" bar. Honest "stopping…" still shows.
    const lbl = runlineEl.querySelector(".tlbl");
    const txt = stopping ? "stopping — finishes after this step…" : (streamTool || "");
    if (txt !== _shownTool) {
      _shownTool = txt;
      lbl.classList.remove("show");
      setTimeout(() => { if (!running || !runlineEl) return; lbl.textContent = txt; lbl.classList.toggle("show", !!txt); }, 150);
    }
  }
  function renderStream() {
    const stick = atBottom();
    if (!streamText) { if (streamEl) { streamEl.remove(); streamEl = null; } renderRunline(); return; }
    if (!streamEl) { streamEl = document.createElement("div"); streamEl.className = "amsg stream"; msgsEl.appendChild(streamEl); }
    streamEl.innerHTML = '<div class="md">' + md(streamText, true) + '</div>';
    typeset(streamEl);
    renderRunline(); scrollDown(stick);
  }
  function clearThreadUi() { running = false; stopping = false; streamText = ""; streamTool = ""; streamEl = null; runlineEl = null; msgsEl.innerHTML = ""; syncSendBtn(); }
  // A rotating greeting, Claude-style (note 25b7b572) — the same small-bold
  // slot as the old "What needs doing?", but JUST the greeting: the Ink empty
  // chat stays quiet, no explainer boilerplate under it.
  const GREETS = ["Welcome back!", "He returns!", "Ready to work?", "Welcome, sir.", "At your service."];
  function showHint() {
    const g = GREETS[Math.floor(Math.random() * GREETS.length)];
    msgsEl.innerHTML = '<div class="hint"><b>' + g + "</b></div>";
  }

  // The phone opens on Main, always (Carl: "the phone should default to main chat ofc"): a cold
  // open and every return to the app (see "lifecycle") land there. A project thread stays open only
  // within the visit he opened it in. Nothing remembers the last thread across visits; the key the
  // phone used to keep it under is gone.
  try { localStorage.removeItem("vc_phone_conv"); } catch {}
  function newChat(project?: string) { convId = null; convTitle = "New chat"; convSource = null; convMeta = {}; newChatProject = project || ""; clearThreadUi(); showHint(); setPage("chat"); setHeader(); renderOngoing(); syncArchived(); }
  // An archived mission thread is history: the composer says so and won't send.
  function syncArchived() {
    // An old mission thread, or an older chat from before one main conversation (src/threads.ts): read only.
    const older = !!convId && !!pic && isOlderChat({ id: convId, kind: (pic.meta as any).kind });
    const arch = (!!convSource && ARCHIVED_SOURCES.has(convSource)) || older;
    input.disabled = arch; input.placeholder = arch ? (older ? "Older chat — read only" : "Archived — read only") : "Message…";
  }
  // ---------- the open thread: a fold of the box's log ----------
  // The thread on screen is the box's conversation log folded with the one
  // reducer (src/convlog/reduce.ts) and projected like the desktop's chat
  // (src/convlog/view.ts) — never a copy of its own. Carl's own messages show
  // at once under the id the box echoes back, and are confirmed in place.
  let pic: Picture | null = null;
  let picView: ((p: Picture) => ChatView) | null = null;
  /** The box's records that arrived while the open thread was loading. */
  let loadingRecs: LogRecord[] | null = null;
  /** This phone's messages on their way (shown until the log has them). */
  let outgoing: { id: string; convId: string | null; text: string; images?: string[]; failed?: string; kind?: "steer" | "queue" }[] = [];
  const shownNodes = new Map<string, { el: HTMLElement; msg: any; live: boolean }>();
  const clientId = () => (self.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2));

  /** What a projected message carries for bubble() (its tools, thinking, cost, divider, spawns, images). */
  function bubbleOf(m: any, live: boolean, last: boolean, all: any[], i: number): HTMLElement {
    const o: Record<string, any> = {
      system: m.system,
      decision: m.decision,
      thinking: m.thinking,
      costUsd: m.costUsd,
      divider: m.compaction ? m.compaction.summary : m.rollover ? m.rollover.recap : undefined,
      spawns: (m.toolCalls || []).flatMap((t) => t.subagents || []),
      images: (m.attachments || []).map((a) => a.imageDataUrl || (a.capturedFilePath ? fileUrl(a.capturedFilePath) : "")).filter(Boolean),
      queued: !!m.failed,
    };
    if (Array.isArray(m.askOptions) && m.askOptions.length) {
      o.askOptions = m.askOptions;
      let chosen = "";
      for (let j = i + 1; j < all.length && !chosen; j++) {
        if (all[j].role === "user" && m.askOptions.some((x) => (x.answer || "") === (all[j].content || "").trim())) chosen = (all[j].content || "").trim();
      }
      o.chosenAnswer = chosen;
      o.optionsLive = !chosen && last;
    }
    const el = bubble(m.role, m.content, (m.toolCalls || []).map((t) => t.name), o);
    if (live) el.classList.add("pending");
    if (m.__pending) {
      el.classList.add("queued");
      el.insertAdjacentHTML("beforeend", '<div class="steerlbl" data-el="pending" data-kind="' + m.__pending + '">' + (m.__pending === "steer" ? "Steering · next step" : "Queued · after this turn") + "</div>");
    }
    return el;
  }

  /** The thread on screen = the fold: each message's node kept while its message is the same object, put in the log's order. */
  function renderThread() {
    if (!convId) return;
    const stick = atBottom();
    // Clear pressed here: blank until the box's own `cleared` (this id) is in the fold, which is blank itself.
    const v = pic && picView ? picView(pic) : null;
    const have = new Set([...(pic ? shown(pic) : []).map((x) => x.id), ...(pic ? pendingOf(pic) : []).map((x) => x.id)]);
    const mine = outgoing.filter((o) => o.convId === convId && !have.has(o.id));
    outgoing = outgoing.filter((o) => o.convId !== convId || !(pic ? shown(pic) : []).some((x) => x.id === o.id));
    const msgs: any[] = [...afterClear(v ? v.messages : [], clearedAt[convId]).filter((m) => !m.hidden)];
    // What pi has not delivered yet (a steer, a queued message): after the thread, labelled.
    for (const p of v ? v.pending : []) msgs.push({ role: "user", content: p.text, mid: p.id, __pending: p.kind });
    for (const o of mine) {
      msgs.push({ role: "user", content: o.text, mid: o.id, attachments: (o.images || []).map((u) => ({ imageDataUrl: u })), __mine: true, failed: o.failed, ...(o.kind ? { __pending: o.kind } : {}) });
      if (o.failed) msgs.push({ role: "assistant", system: true, content: o.failed, mid: o.id + ":failed", __mine: true });
    }
    if (!msgs.length && !(v && v.running)) {
      if (!msgsEl.querySelector(".hint")) { for (const [, n] of shownNodes) n.el.remove(); shownNodes.clear(); showHint(); }
    } else {
      const hint = msgsEl.querySelector(".hint");
      if (hint) hint.remove();
      const keep = new Set<string>();
      let prev: HTMLElement | null = null;
      msgs.forEach((m, i) => {
        const key = String(m.mid ?? "i" + i);
        keep.add(key);
        let n = shownNodes.get(key);
        const last = i === msgs.length - 1 && !!v && v.waiting;
        if (!n || (n.msg !== m && !(m.__mine || m.__pending ? n.msg.content === m.content && n.msg.failed === m.failed && n.msg.__pending === m.__pending : false)) || n.live !== !!m.__mine) {
          const el = bubbleOf(m, !!m.__mine && !m.failed, last, msgs, i);
          if (n) n.el.replaceWith(el);
          n = { el, msg: m, live: !!m.__mine };
          shownNodes.set(key, n);
        }
        // In the log's order: right after the previous one.
        const want = prev ? prev.nextSibling : msgsEl.firstChild;
        if (want !== n.el) msgsEl.insertBefore(n.el, want);
        prev = n.el;
      });
      for (const [k, n] of shownNodes) if (!keep.has(k)) { n.el.remove(); shownNodes.delete(k); }
    }
    // The open tail and the run.
    running = !!(v && v.running) || mine.some((o) => !o.failed);
    if (!running) stopping = false;
    streamText = v ? v.live.text : "";
    const t = v && v.live.tools.length ? v.live.tools[v.live.tools.length - 1] : null;
    const arg = t && t.input ? t.input.path || t.input.file_path || t.input.command || t.input.pattern || t.input.url || "" : "";
    streamTool = t ? t.name + (arg ? " " + String(arg).split("\n")[0].slice(0, 80) : "") : "";
    vWaitTools = running && v ? v.live.tools : [];
    vWaitMsgs = msgs;
    streamStartedAt = v ? v.startedAt : null;
    if (pic) {
      const m = pic.meta as any;
      convTitle = m.title || convTitle;
      convSource = m.source || convSource;
      convMeta = { project: m.project, state: m.state, nextWakeAt: m.nextWakeAt, costUsd: m.costUsd, verdict: m.verdict, todos: v ? v.todos : undefined, subagents: m.subagents || [] };
    }
    renderStream(); renderRunline(); renderExtras(); renderOngoing(); syncArchived(); setHeader(); scrollDown(stick);
  }
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderThread(); });
    setTimeout(() => { if (renderQueued) { renderQueued = false; renderThread(); } }, 60);
  }

  async function openThread(id: string, title?: string) {
    if (convId !== id) setTimeout(() => attention?.poke(), 0);
    convId = id; convTitle = title || "New chat"; convSource = null; convMeta = {}; newChatProject = ""; clearThreadUi(); markSeen(id); renderOngoing();
    for (const [, n] of shownNodes) n.el.remove();
    shownNodes.clear();
    pic = null; picView = makeChatView(); loadingRecs = [];
    setPage("chat"); setHeader();
    try {
      const r = await api("/api/v2/conversations/" + encodeURIComponent(id) + "/checkpoint");
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || r.status);
      if (convId !== id) return;
      // The box's fold, then what arrived meanwhile (the reducer skips what it already holds).
      pic = foldInto(d.picture as Picture, loadingRecs || []);
      loadingRecs = null;
      clearThreadUi();
      renderThread(); scrollDown(true);
    } catch (e) {
      loadingRecs = null;
      if (/not found|404/i.test(String(e.message || e))) { if (id !== MAIN_ID) void openThread(MAIN_ID, MAIN_TITLE); else newChat(); return; }
      toast("Load failed: " + (e.message || e));
    }
  }

  // One send in flight at a time. The optimistic bubble + cleared input already
  // stop a same-text re-tap, but a NEW chat is the dangerous case: until the
  // first send returns, a second submit would start a SECOND conversation.
  // This flag closes that window; the client id closes the network/service-
  // worker-retry one (the box treats a repeated id as the same message).
  let sending = false;
  // send() with no argument sends the composer text; send(text) sends a given
  // string through the SAME pipeline (optimistic bubble, client id, busy flags)
  // — that's how a tapped inline option card becomes your message.
  async function send(forced?) {
    if (sending) return;
    const typed = (forced !== undefined ? String(forced) : input.value).trim();
    // Photos ride with a typed send (not with a tapped option).
    const imgs = forced === undefined ? pendingImgs.slice() : [];
    if (!typed && !imgs.length) return;
    if (!imgs.length && (await compactCommand(typed))) { if (forced === undefined) { input.value = ""; input.style.height = "auto"; input.style.overflowY = "hidden"; } return; }
    // The box records a photo-only turn as "(image)".
    const text = typed || "(image)";
    if (convSource && ARCHIVED_SOURCES.has(convSource)) { toast("Archived mission thread — start a new chat."); return; }
    if (convId && pic && isOlderChat({ id: convId, kind: (pic.meta as any).kind })) { toast("An older chat — read only. Main carries on."); return; }
    sending = true;
    if (forced === undefined) { input.value = ""; input.style.height = "auto"; input.style.overflowY = "hidden"; pendingImgs = []; renderPending(); }
    // A new chat gets its id here: the box makes the conversation under it.
    const fresh = !convId;
    if (fresh) { convId = clientId(); convTitle = text.split("\n")[0].slice(0, 60); pic = null; picView = makeChatView(); for (const [, n] of shownNodes) n.el.remove(); shownNodes.clear(); }
    const target = convId;
    userEngaged.add(target);
    const id = clientId();
    // The box's own rule: an open question takes it as the answer; a running turn as a steer (pi's, at its next step).
    const asking = !!pic?.meta.asking;
    const kind = asking ? "answer" : pic && pic.meta.running ? "steer" : "send";
    outgoing.push({ id, convId: target, text, images: imgs.map((x) => x.url), ...(kind === "steer" ? { kind: "steer" as const } : {}) });
    scheduleRender(); scrollDown(true);
    try {
      const r = await api("/api/v2/intent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: kind, convId: target, clientId: id, client: "phone", text: typed, ...(imgs.length ? { images: imgs.map((x) => ({ name: x.name, mime: x.mime, dataBase64: x.url.slice(x.url.indexOf(",") + 1) })) } : {}), ...(fresh && newChatProject ? { project: projects.find((x) => x.slug === newChatProject)?.name || newChatProject } : {}) }) });
      const d = await r.json();
      if (!r.ok || d.error || d.ok === false) throw new Error(d.error || r.status);
      if (fresh) { if (newChatProject) convMeta.project = newChatProject; newChatProject = ""; }
      if (d.steered) toast("Steering — it reads this at its next step.");
      setHeader();
    } catch (e) {
      // Kept on screen, marked as not sent (never dropped).
      const o = outgoing.find((x) => x.id === id);
      if (o) o.failed = "Not sent: " + String(e.message || e);
      else toast("Send failed: " + (e.message || e));
      scheduleRender();
    } finally {
      sending = false;
    }
  }
  // Same predicate as the visual: the tap does what the button SHOWS. (These
  // diverging is how a ↑-looking button could kill a run, or a ■ re-send.)
  // wireTap: one tap works with the keyboard up (note 85933e24).
  wireTap(sendBtn, () => { if (stopMode()) void killCurrent(); else void send(); });
  // Enter inserts a newline on the phone; sending is via the send button (no Shift+Enter on an iOS keyboard).
  let autosizeRAF = 0;
  function scheduleAutosize() {
    if (autosizeRAF) return;
    // The real text's height (an empty composer is one line; never sized to the placeholder), and a scrollbar
    // only once the text passes the cap.
    autosizeRAF = requestAnimationFrame(() => {
      autosizeRAF = 0;
      input.style.height = "auto";
      input.style.overflowY = "hidden";
      if (!input.value) return;
      input.style.height = Math.min(input.scrollHeight, 120) + "px";
      if (input.scrollHeight > 120) input.style.overflowY = "auto";
    });
  }
  input.addEventListener("input", scheduleAutosize);
  // Stop the open thread's turn (an intent: the box's own stop). Honest: the
  // line says "stopping…" until the log says the turn ended.
  async function killCurrent() {
    if (!convId) return;
    stopping = true; renderRunline(); setHeader();
    const r = await api("/api/v2/intent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "stop", convId }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    toast(d.result || "Stop sent.");
  }

  // ---------- photos in the composer ----------
  // Picked from the library or taken with the camera (the OS offers both),
  // shown as thumbnails above the composer, sent as images[] with the message.
  let pendingImgs: { url: string; mime: string; name: string }[] = [];
  function renderPending() {
    const el = $("pendImgs");
    if (!el) return;
    el.className = pendingImgs.length ? "on" : "";
    el.innerHTML = pendingImgs.map((x, i) => '<span class="pimg" data-i="' + i + '"><img src="' + esc(x.url) + '" alt=""><button class="px" aria-label="remove">×</button></span>').join("");
  }
  // Big photos are scaled down (longest side 1600 px, JPEG) before they go.
  function shrink(file: File): Promise<{ url: string; mime: string; name: string }> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(r.error);
      r.onload = () => {
        const url = String(r.result || "");
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, 1600 / Math.max(img.width, img.height));
          if (k >= 1 && file.size < 1_500_000) return resolve({ url, mime: file.type || "image/png", name: file.name || "photo" });
          const c = document.createElement("canvas");
          c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
          resolve({ url: c.toDataURL("image/jpeg", 0.85), mime: "image/jpeg", name: (file.name || "photo").replace(/\.\w+$/, "") + ".jpg" });
        };
        img.onerror = () => resolve({ url, mime: file.type || "image/png", name: file.name || "photo" });
        img.src = url;
      };
      r.readAsDataURL(file);
    });
  }
  const imgInput = $("imgInput");
  wireTap($("imgBtn"), () => imgInput && imgInput.click());
  if (imgInput) imgInput.addEventListener("change", async () => {
    const files = [...(imgInput.files || [])].filter((f: File) => f.type.startsWith("image/")).slice(0, 4);
    imgInput.value = "";
    for (const f of files) { try { pendingImgs.push(await shrink(f)); } catch {} }
    pendingImgs = pendingImgs.slice(0, 4);
    renderPending();
  });
  const pendEl = $("pendImgs");
  if (pendEl) pendEl.addEventListener("click", (e) => {
    const x = (e.target as HTMLElement).closest(".px");
    if (!x) return;
    const i = Number((x.closest(".pimg") as HTMLElement).dataset.i);
    pendingImgs.splice(i, 1); renderPending();
  });

  // Steer / stop a running subagent (its card in the thread or the strip).
  async function subagentOp(sid: string, op: "steer" | "stop") {
    if (!convId || !sid) return;
    let text = "";
    if (op === "steer") { text = (prompt("Tell the subagent…") || "").trim(); if (!text) return; }
    try {
      const r = await api("/api/v1/conversations/" + encodeURIComponent(convId) + "/subagents/" + encodeURIComponent(sid) + "/" + op, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op === "steer" ? { text } : {}) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) throw new Error(d.error || r.status);
      toast(op === "stop" ? "Stopping the subagent." : "Sent to the subagent.");
      void refreshConvMeta();
    } catch (err) { toast("Couldn't reach the subagent: " + (err.message || err)); }
  }
  function extrasClick(e) {
    const h = e.target.closest(".xblk > .xh");
    if (h) { h.parentElement.classList.toggle("open"); return true; }
    const b = e.target.closest(".sa-b");
    if (b) { const row = b.closest('[data-el="subagent"]'); void subagentOp(row?.dataset.sid || "", b.dataset.op); return true; }
    return false;
  }
  const pinnedEl = $("pinned");
  if (pinnedEl) pinnedEl.addEventListener("click", extrasClick);

  msgsEl.addEventListener("click", (e) => {
    if (extrasClick(e)) return;
    // [unified ask] Tap an inline option card → it becomes YOUR message (the
    // same send pipeline as typing it), the set goes inert, and the decision
    // lands in the Alerts ARCHIVE as a decided card (/decision-record) — the
    // presence-gated ask leaves the same paper trail as the push kind.
    const opt = e.target.closest(".delib-opt.inline");
    if (opt) {
      if (opt.classList.contains("dead") || opt.classList.contains("chosen") || sending) return;
      const ans = opt.dataset.ans || "";
      if (!ans) return;
      const q = opt.dataset.q || "";
      const wrap = opt.closest(".delib-proposed");
      if (wrap) wrap.querySelectorAll(".delib-opt").forEach((x) => { x.classList.add("dead"); const p = x.querySelector(".pick"); if (p) p.remove(); });
      opt.classList.remove("dead"); opt.classList.add("chosen");
      const ot = opt.querySelector(".ot"); if (ot) ot.insertAdjacentHTML("beforeend", '<span class="pick">✓ your call</span>');
      void send(ans);
      void api("/decision-record", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: ans, title: convTitle || "Inline decision", question: q, convId: convId || "" }) }).catch(() => {});
      return;
    }
    const sh = e.target.closest(".steps-h");
    if (sh) { sh.closest(".steps").classList.toggle("open"); }
  });

  // ---------- live events: the box's log ----------
  // /poll?after=<cursor> answers exactly the records after the cursor (the
  // whole vault: every conversation, and its signals). The open thread folds
  // its own; the drawer's dots follow every conversation's running state
  // (reduceRow); a reconnect resumes from the cursor, nothing is re-read.
  let pollGen = 0;
  let cursor: number | null = null, epoch: string | null = null;
  const rowState = new Map<string, RowState>();
  async function pollLoop() {
    const gen = ++pollGen;
    while (gen === pollGen) {
      try {
        if (cursor === null) {
          const d = await (await api("/poll?after=latest")).json();
          cursor = Number(d.next) || 0; epoch = d.epoch || null;
        }
        const r = await api("/poll?after=" + cursor + (epoch ? "&epoch=" + encodeURIComponent(epoch) : "") + "&client=phone");
        if (!r.ok) throw new Error("poll " + r.status);
        const d = await r.json(); offlineStreak = 0;
        if (document.body.classList.contains("offline")) setOffline(false);
        if (d.reset) {
          // Another log than the cursor's: start over from it (the open thread from its checkpoint).
          cursor = null; epoch = null;
          if (convId) void openThread(convId, convTitle);
          continue;
        }
        applyRecords(d.events || []);
        cursor = Math.max(cursor ?? 0, Number(d.next) || 0);
      } catch { offlineStreak++; if (offlineStreak >= 2) setOffline(true); await new Promise((res) => setTimeout(res, 3000)); }
    }
  }
  function applyRecords(recs: LogRecord[]) {
    let mineChanged = false;
    let listChanged = false;
    for (const rec of recs) {
      if (rec.conv === null) {
        const s: any = rec.type === "signal" ? rec.signal : {};
        if (s.type === "notif") { void refreshBadge(); if (page === "alerts") softReload(loadAlerts); }
        else if (s.type === "project") { if (s.convId === convId) void loadProjects(); listChanged = true; }
        else if (s.type === "show" && s.to === "phone" && s.id) void showOnPhone(s);
        // Carl asked to work in another thread (the agent's OpenProject): the phone follows.
        else if (s.type === "follow" && typeof s.convId === "string" && s.convId) { void loadProjects(); if (s.convId !== convId) void openThread(s.convId, typeof s.title === "string" ? s.title : undefined); }
        continue;
      }
      // The drawer's dots: which of your chats run now, and which finished while you looked elsewhere.
      const before = rowState.get(rec.conv);
      const row = reduceRow(before ?? emptyRow(rec.conv), rec);
      rowState.set(rec.conv, row);
      if (!before && row.source) convSourceById.set(rec.conv, row.source);
      const elig = dotEligible(rec.conv);
      const started = row.running && !before?.running;
      const ended = !row.running && !!before?.running;
      if (started && elig) { convRunning.add(rec.conv); convUnseen.delete(rec.conv); listChanged = true; }
      if (ended) { convRunning.delete(rec.conv); if (rec.conv === convId) markSeen(convId); else if (elig) convUnseen.add(rec.conv); listChanged = true; }
      if (rec.conv === convId) {
        if (loadingRecs) loadingRecs.push(rec);
        else pic = foldInto(pic ?? emptyPicture(rec.conv), [rec]);
        mineChanged = true;
      }
    }
    if (listChanged) { updateConvDot(); if (cdraw.classList.contains("on")) void loadConvs(); }
    if (mineChanged && !loadingRecs) { markSeen(convId); scheduleRender(); }
  }
  // pi's Show (server/show.ts) on the phone: markdown and images in a sheet; a PDF, a page or anything else as
  // a link to the phone's own viewer. The box hears what was shown (the ack), never more.
  async function showOnPhone(s: any) {
    const ack = (b: Record<string, unknown>) => api("/api/v1/show/" + encodeURIComponent(s.id) + "/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).catch(() => {});
    try {
      const intent = "Shown by the agent";
      if (s.url) {
        const u = String(s.url);
        openSheet({ intent, title: u, bodyHtml: '<p><a href="' + esc(u) + '" target="_blank" rel="noopener">Open ' + esc(u) + "</a></p>" });
        void ack({ ok: true, landed: "a link to " + u + " is on the phone's screen" });
        return;
      }
      const p = String(s.path || "");
      const name = p.split("/").pop() || p;
      const ext = (name.split(".").pop() || "").toLowerCase();
      if (ext === "md" || ext === "markdown") {
        const r = await api("/file?path=" + encodeURIComponent(p));
        if (!r.ok) throw new Error("the phone couldn't read " + p + " (" + r.status + ")");
        openSheet({ intent, title: name, bodyHtml: '<div class="md">' + md(await r.text()) + "</div>" });
        void ack({ ok: true, landed: "showing " + name + " on the phone" });
      } else if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) {
        openSheet({ intent, title: name, bodyHtml: '<img src="' + esc(fileUrl(p)) + '" alt="' + esc(name) + '" style="max-width:100%;height:auto">' });
        void ack({ ok: true, landed: "showing " + name + " on the phone" });
      } else {
        openSheet({ intent, title: name, bodyHtml: '<p><a href="' + esc(fileUrl(p)) + '" target="_blank" rel="noopener">Open ' + esc(name) + "</a> in the phone's viewer.</p>" });
        void ack({ ok: true, landed: name + " is on the phone's screen as a link that opens it in the phone's own viewer (one tap)" });
      }
    } catch (e: any) {
      void ack({ ok: false, error: String(e?.message || e) });
    }
  }
  // The open thread's meta is its fold: nothing to fetch.
  async function refreshConvMeta() { if (convId && pic) scheduleRender(); }

  async function refreshState() { try { const d = await (await api("/status")).json(); if (d.error) throw 0; vaultName = d.vault || vaultName; boxModel = d.model || ""; boxVersion = d.version || boxVersion; for (const r of d.runs || []) { if (r.convId && r.source) convSourceById.set(r.convId, r.source); } applyRunningSet((d.runs || []).map((r) => r.convId)); setHeader(); return d; } catch { return null; } }
  async function refreshBadge() { try { const d = await (await api("/notifications")).json(); if (typeof d.unread === "number") { unreadN = d.unread; setHeader(); } } catch {} }

  // ---------- activity ----------
  function el(html: string): any { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
  // drawn chevrons — the text glyphs (› ▸ ▾) read as fallback characters
  const CHEV_R = '<svg class="chev-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  const chevT = (open) => '<svg class="chev-t' + (open ? " open" : "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

  // ---------- bottom sheet (the detail surface) ----------
  // Measure the top safe-area inset (Dynamic Island / notch) in px — 0 in a browser
  // tab, ~47-59 in an iOS standalone PWA. A full-height sheet must stop BELOW it, or
  // its top slides up under the Island and reads as "too far up" (note 86073ceb).
  // Probed live (offsetHeight resolves env()), so rotation is handled.
  function safeAreaTop() {
    try {
      const p = document.createElement("div");
      p.style.cssText = "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none";
      document.body.appendChild(p);
      const h = p.offsetHeight || 0;
      p.remove();
      return h;
    } catch { return 0; }
  }
  // The height a sheet opens/snaps to at rest. A smidge below the very top so the
  // header still clears the Dynamic Island, but HIGHER than the old
  // full-safe-area gap — the user wanted it "a smidge higher, halfway between all
  // the way up and where it used to default." So we give back half the safe-area
  // band. 0 inset in a browser tab, so this is the near-full height there.
  function sheetRestHeight() { return Math.round(0.96 * window.innerHeight) - Math.round(safeAreaTop() / 2); }
  // Cohesive monochrome line-icon set — replaces the old punctuation glyphs (?, ≡,
  // ✓, $, !, ◎, ✦, ◷) in the .ico / .sheet-ico tiles. Drawn with currentColor so
  // the tile's status class (.a warn · .r err · .g white) tints the icon ONLY, in
  // keeping with the near-monochrome app. Keyed by the same glyph values the
  // producers + alertMeta still emit, so callers are unchanged; an unknown key
  // (e.g. a stray emoji from a producer) falls back to the neutral info icon.
  const ICON_PATHS = {
    "?": '<circle cx="6" cy="6" r="2.7"/><circle cx="18" cy="6" r="2.7"/><circle cx="12" cy="18" r="2.7"/><path d="M6 8.7v.6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-.6M12 12.6v2.7"/>',
    "!": '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><circle cx="12" cy="17.3" r=".6" fill="currentColor" stroke="none"/>',
    "✓": '<circle cx="12" cy="12" r="9"/><path d="M8 12.4l2.6 2.6L16 9.6"/>',
    "$": '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M14.5 9.3c-.6-.7-1.6-1.1-2.6-1.1-1.4 0-2.4.8-2.4 1.9 0 2.6 5 1.4 5 4 0 1.2-1 2-2.6 2-1.1 0-2.1-.4-2.7-1.1"/>',
    "≡": '<path d="M4 6h16M4 12h16M4 18h10"/>',
    "•": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.7" r=".6" fill="currentColor" stroke="none"/>',
    "◎": '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.4"/>',
    "✦": '<path d="M4 20l4-1L19 8a2 2 0 0 0-3-3L5 16l-1 4z"/><path d="M14.5 6.5l3 3"/>',
    "◷": '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
    "✕": '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    // Plain chat bubble — the "dig in / talk it through" affordance on an ask card.
    "chat": '<path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  };
  function iconSvg(key) {
    const p = ICON_PATHS[key] || ICON_PATHS["•"];
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + "</svg>";
  }
  function openSheet(opts) {
    const sh = $("sheet");
    sh.style.transition = "";
    // Cards open FULL-SCREEN by default (note 7a420a05) — not the old ~64% peek.
    // A sheet→sheet transition (the back ‹, or opening a worker from its mission)
    // instead PRESERVES the current height, so back never "forces me back up"
    // after I've dragged the sheet down.
    sh.style.maxHeight = "none";
    // Open at the resting height (a smidge below the very top — see sheetRestHeight).
    // A sheet→sheet transition (back ‹, or opening a worker from its mission)
    // PRESERVES the current height so back never forces you back up.
    sh.style.height = (sh.classList.contains("on") ? sh.offsetHeight : sheetRestHeight()) + "px";
    $("sheetIco").innerHTML = iconSvg(opts.ico || "•");
    $("sheetIco").className = "sheet-ico" + (opts.cls ? " " + opts.cls : "");
    // A worker thread doesn't need an icon chip — the "Worker · …" intent label
    // already says what it is, and the ● sitting next to the back ‹ just looked
    // cluttered (note 7a420a05). Hide it for those views.
    $("sheetIco").style.display = opts.noIco ? "none" : "";
    $("sheetIntent").textContent = opts.intent || "";
    $("sheetTitle").textContent = opts.title || "";
    $("sheetBody").innerHTML = opts.bodyHtml || "";
    const foot = $("sheetFoot");
    if (opts.footHtml) { foot.style.display = ""; foot.innerHTML = opts.footHtml; } else { foot.style.display = "none"; foot.innerHTML = ""; }
    const act = $("sheetAction");
    if (opts.action) { act.style.display = ""; act.textContent = opts.action.label; act.className = "sheet-action" + (opts.action.danger ? " danger" : ""); act.onclick = opts.action.onClick; }
    else { act.style.display = "none"; act.className = "sheet-action"; act.onclick = null; }
    // Back affordance: when this sheet was reached FROM another (a worker thread
    // opened from its mission), show a ‹ that returns there instead of forcing a
    // full close + re-tap to get back to the supervisor/mission level.
    const back = $("sheetBack");
    if (opts.back) { back.style.display = ""; back.onclick = opts.back; } else { back.style.display = "none"; back.onclick = null; }
    if (opts.wire) opts.wire($("sheetBody"), foot);
    typeset($("sheetBody"));
    $("sheetScrim").classList.add("on"); $("sheet").classList.add("on");
  }
  function closeSheet() { $("sheetScrim").classList.remove("on"); const sh = $("sheet"); sh.classList.remove("on", "editing"); sh.style.maxHeight = ""; }
  // ONE keyboard contract for EVERY text input inside a sheet — the reply
  // composer, the note editor, any future field (note ba0735c9: "find all of
  // the text box enter use cases and get them straightened out"). On focus the
  // sheet fills exactly the space ABOVE the keyboard:
  //  - never shrink-to-content (the old code cleared the inline height, so a
  //    sheet with a short conversation COLLAPSED the moment you tapped the
  //    composer — "brings the sheet down from being expanded");
  //  - never full-height + lift (an input NOT on this contract kept the sheet
  //    at full height while translateY(-kb) lifted it, pushing the top clean
  //    out of the screen — the note editor "swiping way up out of frame").
  // On blur the resting geometry comes back.
  function sheetEditFocus(el) {
    hideKb();
    const sheet = $("sheet");
    // Remember the resting height once (not when hopping between two inputs),
    // so blur can put the sheet back — never the CSS 64% "middle" fallback
    // (notes 7edf4afd / 55ab9006).
    if (!sheet.classList.contains("editing")) sheet.dataset.restH = sheet.style.height || "";
    // Keep the sheet at its RESTING spot on focus — do NOT balloon or lift it. The
    // `.editing` class (CSS) reserves the keyboard height as INSIDE padding, so the
    // top stays fixed and only the pinned composer rises above the keyboard. Was:
    // height:100% + a live maxHeight cap, which grew the sheet to full-screen and
    // let the whole-sheet lift shove its top up into the notch — the on-device
    // report ("the top should not expand because I opened my keyboard; keep it in
    // the same spot") and note 93b609bc. Resting height is an explicit px from
    // openSheet, so not touching it can't collapse a short sheet.
    sheet.classList.add("editing");
    const be = $("sheetBody");
    const wasBottom = be && be.scrollHeight - be.scrollTop - be.clientHeight < 80;
    setTimeout(() => { try { el.scrollIntoView({ block: "nearest" }); } catch {} if (be && wasBottom) be.scrollTop = be.scrollHeight; }, 60);
  }
  function sheetEditBlur() {
    const sh = $("sheet");
    sh.classList.remove("editing");
    // Restore the resting geometry (explicit height + maxHeight:none, like
    // openSheet) so dismissing the keyboard doesn't collapse the sheet, and
    // keep the thread pinned to its latest line across the resize.
    const be = $("sheetBody");
    const wasBottom = be && be.scrollHeight - be.scrollTop - be.clientHeight < 80;
    sh.style.maxHeight = "none";
    sh.style.height = sh.dataset.restH || (sheetRestHeight() + "px");
    if (be && wasBottom) {
      requestAnimationFrame(() => { be.scrollTop = be.scrollHeight; });
      setTimeout(() => { if (be.scrollHeight - be.scrollTop - be.clientHeight < 220) be.scrollTop = be.scrollHeight; }, 300);
    }
  }
  // Wire a sheet's reply textarea: auto-grows vertically as you type (like the
  // chat composer), Enter inserts a newline, the ↑ button sends. The pinned
  // footer + the visualViewport lift keep it above the keyboard.
  function wireReply(foot, onSend) {
    if (!foot) return;
    const ta = foot.querySelector(".rinp"); if (!ta) return;
    ta.setAttribute("enterkeyhint", "enter");
    const autosize = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; };
    ta.addEventListener("input", autosize);
    ta.addEventListener("focus", () => sheetEditFocus(ta));
    ta.addEventListener("blur", sheetEditBlur);
    // onSend returning false = blocked (lane busy) — keep the typed text so
    // nothing is lost; anything else counts as accepted and clears the box.
    const go = () => { const v = ta.value.trim(); if (!v) return; if (onSend(v) === false) return; ta.value = ""; autosize(); };
    wireTap(foot.querySelector(".rsend"), go);
    // Enter inserts a newline; sending is via the send button.
    setTimeout(autosize, 0);
  }
  $("sheetScrim").onclick = closeSheet; $("sheetX").onclick = closeSheet;
  // Tool-call "N steps" chips expand inside the sheet too. The chat has its own
  // handler on msgsEl; the sheet's thread (worker / mission / alert detail) is a
  // separate container, so it needs its own delegated toggle — without this,
  // tapping the steps chip in a thread did nothing.
  $("sheetBody").addEventListener("click", (e) => {
    const sh = e.target.closest(".steps-h");
    if (sh) sh.closest(".steps").classList.toggle("open");
  });
  // Drag the grab/header: pull up to fill the screen for a long thread, pull
  // down past the threshold to dismiss. Snaps to peek / full / closed.
  (function sheetDrag() {
    const sheet = $("sheet"); let startY = 0, startH = 0, dragging = false, H = 0, bodyBottom = false;
    // Growing the sheet must NOT reveal the top of the thread: if the body was at
    // the bottom (latest line in view), keep it there as the frame resizes — the
    // "drag back up and it scrolls the conversation to the top" bug (note this
    // session). Captured at drag-start, re-applied through the move + snap.
    const be = () => $("sheetBody");
    const atBot = () => { const b = be(); return !!b && b.scrollHeight - b.scrollTop - b.clientHeight < 80; };
    const pin = () => { const b = be(); if (b && bodyBottom) b.scrollTop = b.scrollHeight; };
    const down = (y) => { dragging = true; startY = y; startH = sheet.offsetHeight; H = window.innerHeight; bodyBottom = atBot(); sheet.style.transition = "none"; sheet.style.maxHeight = "none"; };
    const move = (y) => { if (!dragging) return; const h = Math.max(80, Math.min(startH - (y - startY), Math.round(0.97 * H))); sheet.style.height = h + "px"; pin(); };
    const up = () => { if (!dragging) return; dragging = false; sheet.style.transition = ""; const h = sheet.offsetHeight; if (h < 0.30 * H) { closeSheet(); return; } if (h > 0.55 * H) sheet.style.height = sheetRestHeight() + "px"; else sheet.style.height = Math.min(sheet.scrollHeight, Math.round(0.62 * H)) + "px"; setTimeout(pin, 300); };
    for (const elx of [$("sheetGrab"), $("sheetHead")]) {
      elx.addEventListener("touchstart", (e) => { if (e.target.closest(".sheet-x,.sheet-action")) return; down(e.touches[0].clientY); }, { passive: true });
      elx.addEventListener("mousedown", (e) => { if (e.target.closest(".sheet-x,.sheet-action")) return; e.preventDefault(); down(e.clientY); });
    }
    window.addEventListener("touchmove", (e) => { if (dragging) move(e.touches[0].clientY); }, { passive: true });
    window.addEventListener("touchend", up); window.addEventListener("touchcancel", up);
    window.addEventListener("mousemove", (e) => { if (dragging) move(e.clientY); });
    window.addEventListener("mouseup", up);
  })();

  // structured-first alert metadata; falls back to derivation (no longer a
  // pure keyword sniff once the producer ships intention/summary/icon).
  function alertMeta(n) {
    if (n.intention || n.icon) return { intention: n.intention || "Update", icon: n.icon || "•", cls: n.cls || "" };
    if (n.kind === "ask") return { intention: "Needs your call", icon: "?", cls: "a" };
    if (/^blocked\b|fail|error|diverg|crash|wedge|❌|⚠/i.test(n.title)) return { intention: "Something failed", icon: "!", cls: "r" };
    if (/complete|done|finished/i.test(n.title)) return { intention: "Finished", icon: "✓", cls: "g" };
    if (/stopped|idle|cost|\$/i.test(n.title)) return { intention: "Cost / cleanup", icon: "$", cls: "r" };
    if (/brief|coach|morning|daily|check-?in/i.test(n.title)) return { intention: "Briefing", icon: "≡", cls: "" };
    return { intention: "Update", icon: "•", cls: "" };
  }

  // ---------- alerts ----------
  // Two classes, by design. ACTION (kind "ask") — something needs a decision;
  // reply inline. INFO (everything else) — a heads-up. Archiving is the ONE
  // explicit acknowledge gesture: swipe a card right-to-left and it's read.
  // Archived items live behind the Archive toggle at the bottom.
  let alertArchiveOpen = false;
  // ---------- notes ----------
  // Read-only view of the desktop's captured notes (highlights, asks, answers).
  // Served by GET /notes; editing/resolving still happens on the desktop.
  let notesResolvedOpen = false;
  const noteFirstLine = (s) => String(s || "").split("\n").map((x) => x.trim()).find(Boolean) || "";
  // A short, scannable header. The AI headline (Note.title) is already short, but
  // the FALLBACKS — raw draft/turn text shown until the box has titled the note —
  // are often one long paragraph with no early newline, so noteFirstLine returned
  // the WHOLE paragraph and it rendered as a giant header (the "summary header is
  // way too long" complaint, note 8da0e8bc; the lag before the AI title lands is
  // note 7e432831). Clip the fallback to its first sentence / ~64 chars so even
  // the pre-title state reads as a header, not a wall of text.
  function clipHeadline(s) {
    const t = noteFirstLine(s);
    if (t.length <= 64) return t;
    const cut = t.slice(0, 64);
    const sentEnd = cut.search(/[.!?](\s|$)/);
    if (sentEnd >= 24) return cut.slice(0, sentEnd + 1);
    const sp = cut.lastIndexOf(" ");
    return (sp >= 24 ? cut.slice(0, sp) : cut) + "…";
  }
  function noteTitle(n) {
    // Prefer the AI headline (Note.title) — a short topic line distinct from the
    // body, so the list is scannable instead of every row repeating its first
    // line. Falls back to a CLIPPED first line of the content until titled.
    if (n.title) return noteFirstLine(n.title);
    if (n.formatted) return clipHeadline(n.formatted);
    if (n.user_draft) return clipHeadline(n.user_draft);
    if (n.turns && n.turns.length) return clipHeadline(n.turns[0].content);
    if (n.anchors && n.anchors.length && n.anchors[0].source_path) return String(n.anchors[0].source_path).split("/").pop();
    return "Note";
  }
  function noteWhen(n) { const t = Date.parse(n.last_updated || n.timestamp || ""); return isFinite(t) ? age(t) : ""; }
  function buildNoteDetail(box, n) {
    if (n.anchors && n.anchors.length) {
      for (const a of n.anchors) {
        const name = a.source_path ? String(a.source_path).split("/").pop() : "source";
        const anchor = a.source_anchor ? " · " + a.source_anchor : "";
        const chip = el('<div class="nanchor"></div>'); chip.textContent = "↳ " + name + anchor; box.appendChild(chip);
        if (a.source_selection) { const q = el('<div class="nquote"></div>'); q.textContent = a.source_selection; box.appendChild(q); }
      }
    }
    if (n.user_draft) { const d = el('<div class="ndraft"></div>'); d.textContent = n.user_draft; box.appendChild(d); }
    if (n.turns && n.turns.length) {
      for (const t of n.turns) {
        const turn = el('<div class="nturn"><span class="nrole"></span><div class="ntext"></div></div>');
        turn.querySelector(".nrole").textContent = t.role === "user" ? "you" : "assistant";
        turn.querySelector(".ntext").textContent = t.content;
        box.appendChild(turn);
      }
    } else if (n.formatted) {
      const f = el('<div class="ntext"></div>'); f.textContent = n.formatted; box.appendChild(f);
    }
  }
  // Which notes are expanded — held OUTSIDE the cards so a list rebuild
  // (loadNotes after a save/status change) puts every card back in the state
  // you left it, instead of collapsing what you were reading (note ba0735c9).
  const expandedNotes = new Set();
  function noteCard(n) {
    const card = el('<div class="card"><div class="crow"><div class="ico">' + iconSvg("✦") + '</div><div class="cb"><div class="ct"><b></b><span class="t"></span></div><p class="cs"></p></div></div><div class="ndetail" style="display:none"></div></div>');
    card.querySelector("b").textContent = noteTitle(n);
    card.querySelector(".t").textContent = noteWhen(n);
    const cs = card.querySelector(".cs");
    cs.textContent = n.formatted || n.user_draft || (n.turns && n.turns.length ? n.turns[n.turns.length - 1].content : "") || "";
    const detail = card.querySelector(".ndetail");
    let built = false;
    const show = () => {
      if (!built) { buildNoteDetail(detail, n); built = true; }
      detail.style.display = ""; cs.style.display = "none";
    };
    if (expandedNotes.has(n.id)) show();
    card.addEventListener("click", () => {
      // A swipe fires a trailing click on mouseup — swallow that one so the
      // resolve gesture doesn't also toggle the detail open.
      if (card.dataset.swiped === "1") { card.dataset.swiped = ""; return; }
      const showing = detail.style.display !== "none";
      if (showing) { detail.style.display = "none"; cs.style.display = ""; expandedNotes.delete(n.id); return; }
      show(); expandedNotes.add(n.id);
    });
    // Swipe left to resolve an open note (or reopen a resolved one) — the same
    // acknowledge gesture as alerts. This now writes through to notes.jsonl on
    // the box, so resolving from the phone sticks across devices.
    // Swipe RIGHT to edit (note 002c8029): opens a sheet with the note's text
    // in a textarea; Save writes through /notes/edit (freshest-on-disk on the
    // box, headline regenerated).
    const resolved = n.status === "resolved";
    attachSwipeArchive(
      card,
      () =>
        api("/notes/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id, status: resolved ? "open" : "resolved" }) })
          .then((r) => { if (!r.ok) throw new Error(); toast(resolved ? "Reopened" : "Resolved"); })
          .catch(() => toast("Couldn't update note — try again")),
      loadNotes,
      () => openNoteEditSheet(n),
    );
    return card;
  }
  // The note edit sheet: the note's text, editable, with one Save action. Only
  // the user's own text (user_draft) is editable — captured turns/anchors are a
  // record, not a draft.
  function openNoteEditSheet(n) {
    openSheet({
      intent: "Note · edit", title: noteTitle(n), ico: "✦", cls: "",
      bodyHtml: '<textarea class="note-edit" id="noteEditTa"></textarea>'
        + '<div class="wbtns"><button class="wbtn" id="noteEditSave">Save</button></div>',
      wire: (body) => {
        const ta = body.querySelector("#noteEditTa");
        ta.value = n.user_draft || "";
        // Same keyboard contract as every other sheet input — without it the
        // full-height sheet got LIFTED by the keyboard transform and its top
        // flew out of the screen (note ba0735c9).
        ta.addEventListener("focus", () => sheetEditFocus(ta));
        ta.addEventListener("blur", sheetEditBlur);
        const save = body.querySelector("#noteEditSave");
        save.onclick = async () => {
          const t = ta.value.trim();
          if (!t) { toast("Note text can't be empty"); return; }
          save.disabled = true;
          try {
            const r = await api("/notes/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id, text: t }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || d.error) throw new Error(d.error || r.status);
            // Save COLLAPSES (note 122ec04d, superseding ba0735c9's stay-open):
            // the sheet closes and the inline card folds shut — the saved note
            // reads from the refreshed list, not a lingering editor.
            n.user_draft = t;
            toast("Saved.");
            expandedNotes.delete(n.id);
            closeSheet();
            void loadNotes();
            // The box re-headlines the edited note off the response path — refetch
            // once more so the new title lands without leaving the page.
            setTimeout(() => { if (page === "notes") void loadNotes(); }, 3500);
          } catch (e) { toast("Couldn't save: " + (e.message || e)); save.disabled = false; }
        };
      },
    });
  }
  async function loadNotes() {
    const box = $("notesScroll");
    try {
      const d = await (await api("/notes")).json();
      if (d.error) throw new Error(d.error);
      const list = d.notes || [];
      box.innerHTML = "";
      if (!list.length) { box.appendChild(el('<div class="empty">No notes yet. Jot one above, or capture them on the desktop — they all show up here.</div>')); return; }
      // "cleared" notes are terminal (emptied resolved pile) — the box already
      // drops them from /notes, but filter explicitly so open never catches them.
      const open = list.filter((n) => n.status === "open");
      const resolved = list.filter((n) => n.status === "resolved");
      if (open.length) box.appendChild(el('<div class="sec">Open · ' + open.length + "</div>"));
      for (const n of open) box.appendChild(noteCard(n));
      if (!open.length) box.appendChild(el('<div class="empty">Nothing open — every note is resolved.</div>'));
      if (resolved.length) {
        const holder = el('<div style="margin-top:8px"></div>'); holder.style.display = notesResolvedOpen ? "" : "none";
        // Clear-all empties the resolved pile durably (POST /notes/clear-resolved →
        // the box flips them to the terminal `cleared` status, union-merge-safe).
        // Two-tap confirm so a stray tap can't wipe the list.
        const clr = el('<button class="earlier clearall">Clear all resolved</button>');
        let armed = false, armTimer = 0;
        clr.onclick = async () => {
          if (!armed) { armed = true; clr.textContent = "Tap again to clear " + resolved.length; clr.classList.add("danger"); clearTimeout(armTimer); armTimer = setTimeout(() => { armed = false; clr.textContent = "Clear all resolved"; clr.classList.remove("danger"); }, 3000); markListBusy(3500); logEvent("clearall", { kind: "note", act: "arm", n: resolved.length }); return; }
          logEvent("clearall", { kind: "note", act: "fire", n: resolved.length });
          clr.disabled = true;
          try {
            const r = await api("/notes/clear-resolved", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
            if (!r.ok) throw new Error();
            toast("Cleared.");
            notesResolvedOpen = false;
            void loadNotes();
          } catch { toast("Couldn't clear — try again"); clr.disabled = false; clr.classList.remove("danger"); clr.textContent = "Clear all resolved"; armed = false; }
        };
        holder.appendChild(clr);
        for (const n of resolved) holder.appendChild(noteCard(n));
        const t = el('<button class="earlier"></button>');
        const label = () => { t.textContent = (notesResolvedOpen ? "Hide resolved · " : "Resolved · ") + resolved.length; };
        label();
        t.onclick = () => { notesResolvedOpen = !notesResolvedOpen; holder.style.display = notesResolvedOpen ? "" : "none"; label(); };
        box.appendChild(t); box.appendChild(holder);
      }
      box.appendChild(el('<div style="height:18px"></div>'));
    } catch (e) { box.innerHTML = '<div class="empty">Notes unavailable: ' + esc(String(e.message || e)) + "</div>"; }
  }
  // New-note composer (POST /notes → app buildNote/addNote). Save button submits;
  // Return inserts a newline (matches the per-device Enter preference).
  (() => {
    const ta = $("noteInput"), btn = $("noteAddBtn");
    if (!ta || !btn) return;
    const autosize = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; };
    ta.addEventListener("input", autosize);
    wireTap(btn, async () => {
      const text = ta.value.trim();
      if (!text) return;
      btn.disabled = true;
      try {
        const r = await api("/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) throw new Error(d.error || r.status);
        ta.value = ""; autosize();
        toast("Note saved.");
        void loadNotes();
        // The box generates the AI headline right after the note lands (a quick
        // model call), so refetch once more a few seconds later to swap the
        // clipped fallback header for the real short title — without making the
        // user leave and come back to see it (note 7e432831).
        setTimeout(() => { if (page === "notes") void loadNotes(); }, 3500);
      } catch (e) { toast("Couldn't save: " + (e.message || e)); }
      finally { btn.disabled = false; }
    });
  })();

  async function loadAlerts() {
    const box = $("alScroll");
    try {
      const d = await (await api("/notifications")).json();
      if (d.error) throw new Error(d.error);
      unreadN = d.unread || 0; setHeader();
      const list = d.notifications || [];
      // Some fixer-written notifications land with a NANOSECOND ts (the box's
      // `date +%s%3N` emits ns, not ms — 19 digits, ~1e18). The age() label
      // already guards against that, but the SORT below and the archive sort
      // read `ts` RAW, so those cards — actually hours old — pin themselves to
      // the TOP as if they were the newest alerts ("auto fixes always say now /
      // as if they're super recent", report 381be0e1→558c993a). Normalize the
      // stamp down to ms ONCE here so every consumer (sort, label, archive) agrees.
      for (const n of list) { if (typeof n.ts === "number") { while (n.ts >= 1e14) n.ts = Math.floor(n.ts / 1000); } }
      lastNotifList = list;
      box.innerHTML = "";
      if (!list.length) { box.appendChild(el('<div class="empty">Nothing yet. Questions, finished work and failures land here — with a push if notifications are on and the app isn’t already open.</div>')); return; }
      // Strictly chronological (note 56e57731): the server sorts by ts, but the
      // local "Updated to vX" card was unshifted ABOVE the list — an old unread
      // update pinned itself over today's alerts. Re-sort so nothing jumps line.
      list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      const unread = list.filter((n) => !n.read);
      // The Archive orders by WHEN YOU ARCHIVED (answered/read time — readAt is
      // the read-marker ts the server now folds in), not by when the alert
      // originally fired (note 56e57731): the pile reads as "what I put away,
      // most recently first".
      const archived = list.filter((n) => n.read)
        .sort((a, b) => (b.answeredAt || b.readAt || b.ts || 0) - (a.answeredAt || a.readAt || a.ts || 0));
      const actions = unread.filter((n) => n.kind === "ask");
      const infos = unread.filter((n) => n.kind !== "ask");
      // [experience-log] Snapshot the ask cards actually on screen, but only when
      // the set CHANGES — so the log shows "you saw these N ask cards" (and would
      // have caught the 4-duplicate-threads / two-sets-of-options case) without
      // flooding on every repaint.
      try {
        const asig = JSON.stringify(actions.map((n) => [n.id, ((n.deliberation && n.deliberation.options) || []).length]));
        if (asig !== __alertsSig) { __alertsSig = asig; logEvent("alerts", { asks: actions.map((n) => ({ id: n.id, conv: n.convId, title: (n.title || "").slice(0, 60), opts: ((n.deliberation && n.deliberation.options) || []).length })) }); }
      } catch {}
      if (actions.length) box.appendChild(el('<div class="sec">Needs a reply</div>'));
      for (const n of actions) box.appendChild(alertCard(n, true));
      if (infos.length) box.appendChild(el('<div class="sec">Heads-up</div>'));
      for (const n of infos) box.appendChild(alertCard(n, false));
      if (!unread.length) box.appendChild(el('<div class="empty">All caught up — swipe a card left to archive it.</div>'));
      if (archived.length) {
        const holder = el('<div style="margin-top:8px"></div>'); holder.style.display = alertArchiveOpen ? "" : "none";
        // Clear the whole read/archived pile in one shot (POST /notifications/clear
        // writes a single clear-before marker) instead of swiping each — the 80-item
        // cap means swiping never actually empties it. Two-tap confirm; pending
        // unread asks are kept.
        const clrN = el('<button class="earlier clearall">Clear archive · ' + archived.length + "</button>");
        let armedN = false, armNT = 0;
        clrN.onclick = async () => {
          if (!armedN) { armedN = true; clrN.textContent = "Tap again to clear " + archived.length; clrN.classList.add("danger"); clearTimeout(armNT); armNT = setTimeout(() => { armedN = false; clrN.textContent = "Clear archive · " + archived.length; clrN.classList.remove("danger"); }, 3000); markListBusy(3500); logEvent("clearall", { kind: "alert", act: "arm", n: archived.length }); return; }
          logEvent("clearall", { kind: "alert", act: "fire", n: archived.length });
          clrN.disabled = true;
          try {
            const r = await api("/notifications/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
            if (!r.ok) throw new Error();
            toast("Notifications cleared."); alertArchiveOpen = false; void loadAlerts();
          } catch { toast("Couldn't clear — try again"); clrN.disabled = false; clrN.classList.remove("danger"); clrN.textContent = "Clear archive · " + archived.length; armedN = false; }
        };
        holder.appendChild(clrN);
        for (const n of archived) holder.appendChild(alertCard(n, false));
        const t = el('<button class="earlier"></button>');
        const label = () => { t.textContent = (alertArchiveOpen ? "Hide archive · " : "Archive · ") + archived.length; };
        label();
        t.onclick = () => { alertArchiveOpen = !alertArchiveOpen; holder.style.display = alertArchiveOpen ? "" : "none"; label(); };
        box.appendChild(t); box.appendChild(holder);
      } else { alertArchiveOpen = false; }
      box.appendChild(el('<div style="height:18px"></div>'));
    } catch (e) { box.innerHTML = '<div class="empty">Alerts unavailable: ' + esc(String(e.message || e)) + "</div>"; }
  }
  const markRead = (id) => api("/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
  // The box's auto-update alert is now a single real notification pushed from
  // the box (UpdateBanner.notifyUpdated) that already carries the release notes
  // as its body — so there's no separate phone-local "what changed" card to
  // synthesize here. One update, one notification.
  // The feed as last fetched — so an action on one card (answering an ask) can
  // reason about its siblings (other pending asks on the same conversation).
  let lastNotifList = [];
  // ---- unified AskUser ----
  // EVERY kind:"ask" notification — a real AskUser fork AND the parked-mission
  // escalation — renders in the ONE "needs you" style: a neutral card with the
  // near-white status dot, the question, the agent's option buttons (when it gave
  // any), and ALWAYS a freeform answer + a top-right chat icon to dig in. There
  // is no separate "summary ask" card anymore. The structured `deliberation`
  // payload (from the AskUser tool's `options`) is optional — an ask without it
  // still renders here, just with no option buttons.
  function deliberationFromNotif(n) {
    const d = n.deliberation || {};
    const ask = d.ask || n.summary || n.body || "";
    return {
      mission: d.mission || n.title || "",
      ask,
      askLong: d.askLong || d.ask || n.body || n.summary || ask,
      // [ask-object] The declared fallback + stakes, so every ask surface can
      // show "if you don't answer, X" and the defer relay can feed X back.
      stakes: d.stakes || "",
      onDefer: d.onDefer || "",
      options: Array.isArray(d.options) ? d.options : [],
    };
  }
  // The card is a SUMMARY (icon + title + intention + 2-line summary) built from
  // the producer's structured deliverable, falling back to a derived category.
  // Tap opens the bottom sheet with the full report; swipe left archives.
  function alertCard(n, isAction) {
    // EVERY ask (a decision the agent needs from you) is the unified "needs you"
    // card — whether or not it carries structured options. isAction (unread ask)
    // and any kind:"ask" both route here. So does ANY alert that carries a
    // recorded decision (answeredWith) — e.g. an info alert whose follow-up
    // relayed your call to the mission: one visual language for every decision
    // you made, whatever surface it was made on (note ff31231e).
    if (isAction || n.kind === "ask" || n.answeredWith) return needsYouCard(n);
    const meta = alertMeta(n);
    const card = el('<div class="card' + (isAction ? " ask" : n.read ? "" : " unread") + '"><div class="crow"><div class="ico"></div><div class="cb"><div class="ct"><b></b><span class="t"></span></div><div class="metabar"></div><p class="cs"></p></div></div></div>');
    const ico = card.querySelector(".ico");
    const cls = n.cls || meta.cls;
    ico.innerHTML = iconSvg(n.icon || meta.icon); if (cls) ico.classList.add(cls);
    card.querySelector("b").textContent = n.title;
    card.querySelector(".t").textContent = age(n.ts);
    card.querySelector(".metabar").textContent = n.intention || meta.intention;
    card.querySelector(".cs").textContent = n.summary || n.body || "";
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("a")) return;
      if (card.dataset.swiped === "1") { card.dataset.swiped = ""; return; }
      openNotif(n);
    });
    attachSwipeArchive(card, n.read
      ? () => api("/notifications/hide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id }) }).catch(() => {})
      : () => markRead(n.id));
    return card;
  }
  // Tap -> the notification's conversation (marked read). One without a
  // conversation (an update notice) opens its text in the sheet.
  function openNotif(n) {
    if (!n.read) { n.read = true; void markRead(n.id); }
    if (n.convId) { void openThread(n.convId); return; }
    const meta = alertMeta(n);
    openSheet({ intent: n.intention || meta.intention, title: n.title, ico: n.icon || meta.icon, cls: n.cls || meta.cls, bodyHtml: '<div class="md">' + md(n.body || "*(no summary)*") + "</div>" });
  }
  // The feed card for an ask. A neutral card: a subtle near-white "Needs you" dot
  // + label, a top-right chat icon that opens the deliberation sheet ("dig in"),
  // the question, the agent's option buttons (only when it supplied options — one
  // may be the near-white primary), and ALWAYS a freeform answer field with the
  // send arrow inset. An option-tap or a committed freeform answer resolves the
  // ask via /answer; the chat icon (or tapping the body) opens the sheet.
  function needsYouCard(n) {
    const del = deliberationFromNotif(n);
    // A read/answered ask is DECIDED — its card shows the recorded decision, not
    // live buttons. (Archived asks used to re-render tappable options; tapping a
    // stale one fired /answer into a long-resolved thread.)
    const decided = !!n.answeredWith || !!n.read;
    const card = el('<div class="card needsyou' + (decided ? " decided" : "") + '"></div>');
    const lbl = el('<div class="needs-lbl"><span class="d"></span><span class="t"></span><span class="digin" title="Talk it through"></span></div>');
    lbl.querySelector(".t").textContent = decided ? "Your call · decided" : "Needs you";
    const digin = lbl.querySelector(".digin"); digin.innerHTML = iconSvg("chat");
    digin.onclick = (e) => { e.stopPropagation(); if (n.convId) void openThread(n.convId); };
    card.appendChild(lbl);
    const q = el('<div class="needs-q"></div>'); q.textContent = del.ask; card.appendChild(q);
    if (decided) {
      // The decision that settled it, on the card itself (note d4db3542) — or an
      // honest "no decision recorded" for an ask that was swiped away/superseded.
      card.appendChild(el('<div class="needs-decided">' + (n.answeredWith ? "✓ <b>" + esc(n.answeredWith) + "</b>" : "dismissed — no decision recorded") + "</div>"));
    } else if (del.options.length) {
      const qa = el('<div class="needs-qa"></div>');
      for (const opt of del.options) {
        const b = el('<button></button>');
        b.textContent = opt.answer;
        // Lock every option the instant one is tapped — an accidental double-tap
        // must not fire a second answer (note 6693e931). The backend collapses
        // repeats too (deterministic clientMsgId), this just makes it visible.
        b.onclick = (e) => { e.stopPropagation(); qa.querySelectorAll("button").forEach((x) => { x.disabled = true; }); resolveDeliberation(n, opt.answer); };
        qa.appendChild(b);
      }
      card.appendChild(qa);
    }
    // [ask-object] "Not now" — the formal defer terminal, on every live ask card.
    // It ends the ask AND resumes the parked mission (unlike swipe-archive, which
    // only hid the card and left the mission stranded AWAITING_USER).
    if (!decided) {
      if (del.onDefer) card.appendChild(el('<div class="supask-hint" style="margin-top:8px">If you don’t answer: ' + esc(del.onDefer) + (del.stakes === "high" ? " · high-stakes, so I’ll hold" : "") + "</div>"));
      const df = el('<button class="needs-defer">Not now</button>');
      df.onclick = (e) => { e.stopPropagation(); (df as HTMLButtonElement).disabled = true; deferAsk(n); };
      card.appendChild(df);
    }
    // Freeform answer lives in the dig-in sheet now, not inline on every feed card —
    // the always-present input made each card ~50px taller so only ~2 fit on screen
    // (user: cards spill over, can't see the recent needs-you). Tap the card / chat
    // icon to answer in your words; options stay tappable inline.
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button,input,.rsend,.digin")) return;
      if (card.dataset.swiped === "1") { card.dataset.swiped = ""; return; }
      if (n.convId) void openThread(n.convId);
    });
    attachSwipeArchive(card, n.read
      ? () => api("/notifications/hide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id }) }).catch(() => {})
      : () => markRead(n.id));
    return card;
  }
  const resolvingAsks = new Set();
  function resolveDeliberation(n, answer) {
    try { logEvent("decide", { ask: n.id, conv: n.convId, answer: (answer || "").slice(0, 120) }); } catch {}
    // One decision per (ask, answer), deterministically: repeat taps of the
    // SAME option are locked out here, and the clientMsgId is DERIVED from the
    // ask id + answer (not minted fresh per tap), so even a repeat that slips
    // through — a double-fired handler, a PWA retry — collapses to ONE answer
    // turn on the box (note 6693e931). Keyed per ANSWER, not per ask: a
    // decided-but-open conversation can send a REVISED call later.
    const rkey = n.id + "\u0000" + answer;
    if (resolvingAsks.has(rkey)) return;
    resolvingAsks.add(rkey);
    setTimeout(() => resolvingAsks.delete(rkey), 60_000);
    const clientMsgId = "answer-" + n.id + "-" + encodeURIComponent(answer).slice(0, 32);
    if (n.convId) {
      // notifId lets the box durably stamp WHICH answer settled this ask
      // (answeredWith), so the Archive shows the decision that was made.
      // askConvId pins the decision receipt into the ask's own thread (the
      // thread stays TALKABLE after — deciding records, it doesn't close).
      api("/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ convId: n.convId, text: answer, clientMsgId, notifId: n.id, ...(n.kind === "ask" && n.askConvId ? { askConvId: n.askConvId } : {}) }) }).catch(() => {});
    }
    // One answer settles the DECISION, not just this card: retire every live ask
    // card pointing at the same conversation. The deadlocked self-test stacked 3
    // cards for one fork; tapping the stale leftovers fed duplicate replies into
    // the thread ("Force-close it" landed twice as separate turns).
    for (const s of lastNotifList) {
      if (s.kind === "ask" && !s.read && s.id !== n.id && s.convId && n.convId && s.convId === n.convId) markRead(s.id);
    }
    markRead(n.id);
    // [unified ask] Deciding does NOT slam the sheet shut — the conversation
    // keeps going (keep-talking). Re-render the ask sheet in its decided-but-
    // live form; an info sheet just stays as it is (its tapped card is already
    // marked by the sheet's own wiring).
    n.answeredWith = answer; n.answeredAt = Date.now(); n.read = true;
    void loadAlerts();
  }
  // [ask-object] "Not now" — the ask's terminal that ends it WITHOUT choosing an
  // option and RESUMES the parked mission (the box injects the fallback
  // instruction and clears AWAITING_USER; a swiped-away card used to strand the
  // mission forever). Mirrors resolveDeliberation's /answer relay but tags
  // defer:true and records "Not now" as the decision on the card + archive.
  function deferAsk(n) {
    try { logEvent("defer", { ask: n.id, conv: n.convId }); } catch {}
    const rkey = n.id + " __defer__";
    if (resolvingAsks.has(rkey)) return;
    resolvingAsks.add(rkey);
    setTimeout(() => resolvingAsks.delete(rkey), 60_000);
    const del = deliberationFromNotif(n);
    if (n.convId) {
      api("/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ convId: n.convId, text: "Not now", clientMsgId: "defer-" + n.id, notifId: n.id, defer: true, ...(del.onDefer ? { onDefer: del.onDefer } : {}), ...(n.kind === "ask" && n.askConvId ? { askConvId: n.askConvId } : {}) }) }).catch(() => {});
    }
    // One terminal settles the DECISION: retire every live ask card for the same
    // conversation, same as answering (a mission has ONE open ask).
    for (const s of lastNotifList) {
      if (s.kind === "ask" && !s.read && s.id !== n.id && s.convId && n.convId && s.convId === n.convId) markRead(s.id);
    }
    markRead(n.id);
    n.answeredWith = "Not now"; n.answeredAt = Date.now(); n.read = true;
    void loadAlerts();
  }
  // [swipe-kind] Which list a swiped card lives in, for the experience-log — so a
  // replay says "note swipe cancelled" not just "a card moved". Derived from the
  // scroller it sits in; no call-site change needed.
  const SWIPE_KIND = { alScroll: "alert", notesScroll: "note" };
  function attachSwipeArchive(card: any, action: any, reload?: any, rightAction?: any) {
    reload = reload || loadAlerts;
    let x0 = 0, y0 = 0, dx = 0, mode = null, t0 = 0;
    const kindOf = () => { const s = card.closest("#alScroll,#notesScroll"); return (s && SWIPE_KIND[s.id]) || "card"; };
    const start = (x, y) => { x0 = x; y0 = y; dx = 0; mode = null; t0 = Date.now(); markListBusy(); card.style.transition = "none"; };
    const move = (x, y) => {
      if (mode === "v") return false;
      const ndx = x - x0, ndy = y - y0;
      if (mode === null) {
        if (Math.abs(ndx) < 9 && Math.abs(ndy) < 9) return false;
        mode = Math.abs(ndx) > Math.abs(ndy) ? "h" : "v";
        if (mode === "v") return false;
      }
      // Right-swipe only tracks when a rightAction exists (notes: swipe right to
      // edit, note 002c8029); everywhere else the card stays pinned at 0 so the
      // gesture keeps meaning exactly one thing (left = archive/resolve).
      dx = rightAction ? Math.max(-innerWidth, Math.min(ndx, 90)) : Math.min(0, ndx);
      card.style.transform = "translateX(" + dx + "px)";
      return true;
    };
    const end = async () => {
      if (mode !== "h") { mode = null; return; }
      // A mouse drag fires a click on mouseup — flag it so the card's
      // tap-for-summary handler swallows that one click. TIMED, not
      // consume-on-next-click: touch swipes fire no click at all, and a
      // lingering flag would eat the next real tap (the "tap does nothing"
      // bug).
      card.dataset.swiped = "1";
      setTimeout(() => { card.dataset.swiped = ""; }, 400);
      mode = null;
      // [experience-log] Record the OUTCOME of every committed horizontal
      // gesture — commit vs cancel, distance, duration — so a replay shows the
      // swipes that didn't take (dx never reached threshold) next to the ones
      // that did. This is the signal for "swiping was out of whack".
      const logSwipe = (act) => { try { logEvent("swipe", { kind: kindOf(), act, dx: Math.round(dx), ms: Date.now() - t0 }); } catch {} };
      card.style.transition = "transform .18s ease, opacity .18s ease";
      if (rightAction && dx > 60) {
        // Right-swipe: snap back and hand off (an edit opens a sheet — the card
        // itself stays in place).
        logSwipe("edit");
        card.style.transform = "";
        rightAction();
      } else if (dx < -70) {
        logSwipe("archive");
        // Remember WHERE in the list you were, so the reload below doesn't yank you
        // to the top. loadAlerts/loadNotes rebuild innerHTML (scrollTop
        // → 0), so swiping a card DOWN in the archive scrolled you back up to the
        // unread section — making it look like the swipe hit the wrong card and a
        // "normal" alert reappeared. It didn't; the view just jumped.
        const scroller = card.closest("#alScroll,#notesScroll");
        const prevTop = scroller ? scroller.scrollTop : 0;
        card.style.transform = "translateX(-110%)"; card.style.opacity = "0";
        // Collapse the card's vertical space as it leaves so the list closes the
        // gap smoothly. A translateX alone leaves the card's HEIGHT in the layout,
        // so a hole sat where it was until the reload landed (the swipe-gap /
        // orphaned-section-header jank in the recording). Animate height + margins
        // + padding to 0, then reload to reconcile the count and headers.
        const h = card.offsetHeight;
        card.style.height = h + "px"; card.style.overflow = "hidden"; card.style.boxSizing = "border-box";
        requestAnimationFrame(() => {
          card.style.transition = "transform .18s ease, opacity .18s ease, height .2s ease, margin .2s ease, padding .2s ease";
          card.style.height = "0px"; card.style.marginTop = "0px"; card.style.marginBottom = "0px"; card.style.paddingTop = "0px"; card.style.paddingBottom = "0px";
        });
        await action();
        setTimeout(async () => {
          await Promise.resolve(reload());
          // Put the scroll back where it was (clamped to the now-shorter list) so the
          // removed card just closes up in place instead of the view jumping to top.
          if (scroller) scroller.scrollTop = Math.min(prevTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
        }, 240);
      } else {
        // Started a horizontal drag but released short of the archive threshold
        // — snaps back. Logged so a run of these reads as "I kept trying to
        // swipe and nothing happened".
        logSwipe("cancel");
        card.style.transform = "";
      }
    };
    card.addEventListener("touchstart", (e) => start(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    // [axis-lock] touchmove is NON-passive so that once the gesture is locked
    // horizontal (move() returns true) we preventDefault and the list stops
    // scrolling underneath the finger. Without this the card followed the
    // finger while the scroller ALSO scrolled — the two fought, the swipe
    // distance never reached threshold, and archiving felt "state-dependent"
    // and "all over the place". Mirrors the drawer swipe-open handler, which
    // has always locked its axis this way.
    card.addEventListener("touchmove", (e) => { if (move(e.touches[0].clientX, e.touches[0].clientY)) e.preventDefault(); }, { passive: false });
    card.addEventListener("touchend", end);
    card.addEventListener("touchcancel", end);
    let mouseDown = false;
    card.addEventListener("mousedown", (e) => { if (e.target.closest(".rinp,.rsend")) return; mouseDown = true; start(e.clientX, e.clientY); });
    window.addEventListener("mousemove", (e) => { if (mouseDown) move(e.clientX, e.clientY); });
    window.addEventListener("mouseup", () => { if (mouseDown) { mouseDown = false; end(); } });
  }

  // ---------- settings drawer ----------
  // Box & settings: notifications on/off, a test push, the box's version.
  // (The Claude/feedback screen that shared this drawer is gone.)
  function openDrawer() {
    $("drawer").classList.add("open");
    refreshPushUi(); void pushAutoOn();
    void refreshState().then((d) => {
      $("boxVer").textContent = d && d.version ? "vault-chat v" + d.version : "";
    });
  }
  function closeDrawer() { $("drawer").classList.remove("open"); }
  $("drawerMenuBtn").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("on"); };
  // (Composer Enter-key toggle removed — the phone Return key always inserts a
  // newline; sending is via the send button. enterkeyhint="enter" is set in the
  // static markup and on the sheet reply input.)

  // ---------- push ----------
  const b64uToBytes = (s) => { const pad = "=".repeat((4 - (s.length % 4)) % 4); const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window;
  async function currentSub() { if (!pushSupported()) return null; const reg = await navigator.serviceWorker.getRegistration().catch(() => null); return reg ? await reg.pushManager.getSubscription().catch(() => null) : null; }
  // Notifications are DEFAULT ON: the gear just holds the off-switch. Once
  // permission is granted (one tap on the switch the first time — iOS requires a
  // gesture), the app keeps itself subscribed automatically from then on.
  async function refreshPushUi() {
    if (!pushSupported()) { $("pushState").textContent = navigator.standalone === false ? "Add to your Home Screen first — Safari tabs can't receive push." : "Push not supported here."; $("pushSw").classList.remove("on"); $("pushTestBtn").style.display = "none"; return; }
    const sub = await currentSub();
    $("pushSw").classList.toggle("on", !!sub);
    $("pushState").textContent = sub ? "On for this device." : (Notification.permission === "denied" ? "Blocked in iOS Settings for this app." : "Off — flip the switch once.");
    $("pushTestBtn").style.display = sub ? "" : "none";
  }
  async function pushSubscribe() {
    const perm = await Notification.requestPermission(); if (perm !== "granted") { toast("Notifications not allowed."); return false; }
    const reg = await navigator.serviceWorker.register("/phone-sw.js"); await navigator.serviceWorker.ready;
    const vd = await (await api("/push/vapid")).json(); if (!vd.key) throw new Error(vd.error || "no VAPID key from box");
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(vd.key) });
    const r = await api("/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subBody(sub)) });
    if (!r.ok) throw new Error("subscribe store failed");
    return true;
  }
  // A subscription carries the VAPID key it was made under: the box drops one made under another
  // key (the push service refuses it with a 400 on every push, server/commands/phone.ts).
  const bytesToB64u = (buf) => { const b = new Uint8Array(buf); let s = ""; for (const c of b) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const subKey = (sub) => { try { const k = sub.options && sub.options.applicationServerKey; return k ? bytesToB64u(k) : ""; } catch { return ""; } };
  const subBody = (sub) => { const k = subKey(sub); return k ? { ...sub.toJSON(), key: k } : sub.toJSON(); };
  // Default-ON keeper: whenever permission is already granted but the device has
  // no live subscription (fresh install, iOS evicted it), re-subscribe silently.
  async function pushAutoOn() {
    if (MOCK || !pushSupported()) return;
    try {
      if (Notification.permission !== "granted" || localStorage.getItem("vc_push_optout") === "1") return;
      let sub = await currentSub();
      // Made under a key the box no longer signs with: every push to it fails. Make a fresh one.
      if (sub && subKey(sub)) {
        const vd = await (await api("/push/vapid")).json().catch(() => ({}));
        if (vd.key && vd.key !== subKey(sub)) { await sub.unsubscribe().catch(() => {}); sub = null; }
      }
      if (sub) { api("/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subBody(sub)) }).catch(() => {}); }
      else { await pushSubscribe(); }
      refreshPushUi();
    } catch {}
  }
  $("pushSw").onclick = async () => {
    try {
      const sub = await currentSub();
      if (sub) {
        try { localStorage.setItem("vc_push_optout", "1"); } catch {}
        await api("/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
        toast("Notifications off.");
      } else {
        try { localStorage.removeItem("vc_push_optout"); } catch {}
        if (await pushSubscribe()) toast("Notifications on.");
      }
    } catch (e) { toast("Push setup failed: " + (e.message || e)); }
    refreshPushUi();
  };
  $("pushTestBtn").onclick = async () => { const r = await api("/push/test", { method: "POST" }).catch(() => null); const d = r ? await r.json().catch(() => ({})) : {}; toast(d.error ? "Test failed: " + d.error : "Test sent — should arrive in seconds."); };
  if (!MOCK) void pushAutoOn();

  // ---------- in-app keyboard (verbatim) ----------
  const KB_SYS_FLAG = "vc_kb_system";
  // In-app keyboard removed — always use the system keyboard. (Was a toggle;
  // the user moved to the system keyboard, so the custom one is retired.)
  const CUSTOM_KB = false;
  const kbEl = $("kb");
  let kbLayer = 0, kbShift = false, kbCaps = false, lastShiftAt = 0, lastSpaceAt = 0;
  const KB_LAYERS = [
    [[..."qwertyuiop"].map((c) => ({ k: "ch", t: c })), [..."asdfghjkl"].map((c) => ({ k: "ch", t: c })), [{ k: "shift", t: "⇧" }, ...[..."zxcvbnm"].map((c) => ({ k: "ch", t: c })), { k: "bksp", t: "⌫" }], [{ k: "layer1", t: "123" }, { k: "space", t: "space" }, { k: "ret", t: "⏎" }]],
    [[..."1234567890"].map((c) => ({ k: "ch", t: c })), [..."-/:;()$&@\""].map((c) => ({ k: "ch", t: c })), [{ k: "layer2", t: "#+=" }, ...[...".,?!'"].map((c) => ({ k: "ch", t: c })), { k: "bksp", t: "⌫" }], [{ k: "layer0", t: "ABC" }, { k: "space", t: "space" }, { k: "ret", t: "⏎" }]],
    [[..."[]{}#%^*+="].map((c) => ({ k: "ch", t: c })), [..."_\\|~<>€£¥•"].map((c) => ({ k: "ch", t: c })), [{ k: "layer1", t: "123" }, ...[...".,?!'"].map((c) => ({ k: "ch", t: c })), { k: "bksp", t: "⌫" }], [{ k: "layer0", t: "ABC" }, { k: "space", t: "space" }, { k: "ret", t: "⏎" }]],
  ];
  const kbLayerDivs = []; let kbShiftKeyEl = null;
  function kbBuild() {
    kbEl.innerHTML = "";
    KB_LAYERS.forEach((rows, li) => {
      const layer = document.createElement("div"); layer.className = "kblayer" + (li === 0 ? " active" : "");
      rows.forEach((row, ri) => {
        const r = document.createElement("div"); r.className = "kbrow" + (li === 0 && ri === 1 ? " indent" : "");
        for (const key of row) {
          const b = document.createElement("div"); const spec = key.k !== "ch"; b.className = "kbk" + (spec ? " spec" : "");
          if (key.k === "space") b.classList.add("space"); if (key.k === "ret") b.classList.add("ret");
          b.dataset.k = key.k; b.dataset.t = key.t; b.textContent = key.t;
          if (key.k === "ch" && /[a-z]/i.test(key.t)) b.classList.add("let");
          if (key.k === "shift") kbShiftKeyEl = b; r.appendChild(b);
        }
        layer.appendChild(r);
      });
      kbEl.appendChild(layer); kbLayerDivs.push(layer);
    });
  }
  // Shift flip is now a single class toggle (CSS uppercases .let keys) instead
  // of rewriting textContent on all 26 letter keys per keystroke.
  function kbApplyShift() { const up = kbShift || kbCaps; kbEl.classList.toggle("up", up); if (kbShiftKeyEl) { kbShiftKeyEl.classList.toggle("lit", up); kbShiftKeyEl.classList.toggle("caps", kbCaps); } }
  function kbSetLayer(i) { kbLayer = i; kbLayerDivs.forEach((d, li) => d.classList.toggle("active", li === i)); if (i === 0) kbAutoShift(); kbApplyShift(); }
  function kbSel() { const len = input.value.length; let s = input.selectionStart, e = input.selectionEnd; if (s == null || e == null) { s = len; e = len; } return [s, e]; }
  function kbAfterEdit() { scheduleAutosize(); kbAutoShift(); }
  function kbAutoShift() { if (kbCaps || kbLayer !== 0) return; const [s] = kbSel(); const tail = s >= 2 ? input.value.slice(s - 2, s) : input.value.slice(0, s); const want = s === 0 || /[.!?]\s$/.test(tail) || /\n$/.test(tail); if (want !== kbShift) { kbShift = want; kbApplyShift(); } }
  function kbInsert(str) { const [s, e] = kbSel(); input.setRangeText(str, s, e, "end"); kbAfterEdit(); }
  function kbBackspaceOnce() { let [s, e] = kbSel(); if (s === e) { if (s === 0) return; let n = 1; const code = input.value.charCodeAt(s - 1); if (code >= 0xdc00 && code <= 0xdfff && s > 1) n = 2; s -= n; } input.setRangeText("", s, e, "end"); kbAfterEdit(); }
  let bkspT1 = 0, bkspIv = 0;
  function kbStopRepeat() { clearTimeout(bkspT1); clearInterval(bkspIv); bkspT1 = bkspIv = 0; }
  function kbKeyDown(elk) {
    const k = elk.dataset.k, t = elk.dataset.t; elk.classList.add("down");
    if (k === "ch") { kbInsert(kbShift || kbCaps ? t.toUpperCase() : t); if (kbShift && !kbCaps && /[a-z]/i.test(t)) { kbShift = false; kbApplyShift(); } }
    else if (k === "bksp") { kbBackspaceOnce(); kbStopRepeat(); bkspT1 = setTimeout(() => { bkspIv = setInterval(kbBackspaceOnce, 55); }, 420); }
    else if (k === "shift") { const now = Date.now(); if (now - lastShiftAt < 350) { kbCaps = true; kbShift = true; } else if (kbCaps) { kbCaps = false; kbShift = false; } else { kbShift = !kbShift; } lastShiftAt = now; kbApplyShift(); }
    else if (k === "space") { const [caret] = kbSel(); const now = Date.now(); if (now - lastSpaceAt < 350 && caret >= 2 && input.value[caret - 1] === " " && /[\w)\]'"’”]/.test(input.value[caret - 2])) { input.setRangeText(". ", caret - 2, caret, "end"); kbAfterEdit(); } else kbInsert(" "); lastSpaceAt = now; }
    else if (k === "ret") kbInsert("\n");
    else if (k === "layer0") kbSetLayer(0); else if (k === "layer1") kbSetLayer(1); else if (k === "layer2") kbSetLayer(2);
  }
  function kbKeyUp(elk) { elk.classList.remove("down"); }
  function showKb() { if (!CUSTOM_KB || page !== "chat") return; if (!document.body.classList.contains("kbopen")) { document.body.classList.add("kbopen"); scrollDown(true); } if (document.activeElement !== input) { try { input.focus({ preventScroll: true }); } catch {} } kbApplyShift(); kbAutoShift(); }
  function hideKb() { if (!document.body.classList.contains("kbopen")) return; document.body.classList.remove("kbopen"); kbStopRepeat(); }
  if (CUSTOM_KB) {
    input.setAttribute("inputmode", "none"); input.setAttribute("autocapitalize", "off"); input.setAttribute("autocorrect", "off"); input.setAttribute("autocomplete", "off"); input.setAttribute("spellcheck", "false");
    kbBuild(); kbApplyShift();
    const hasTouch = "ontouchstart" in window; const downByKey = new Map();
    const keyFrom = (target) => (target && target.closest ? target.closest(".kbk") : null);
    if (hasTouch) {
      kbEl.addEventListener("touchstart", (e) => { e.preventDefault(); for (const t of e.changedTouches) { const key = keyFrom(t.target); if (!key) continue; downByKey.set(t.identifier, key); kbKeyDown(key); } }, { passive: false });
      const endTouch = (e) => { for (const t of e.changedTouches) { const key = downByKey.get(t.identifier); if (!key) continue; downByKey.delete(t.identifier); kbKeyUp(key); if (key.dataset.k === "bksp") kbStopRepeat(); } };
      kbEl.addEventListener("touchend", endTouch); kbEl.addEventListener("touchcancel", endTouch);
    } else {
      kbEl.addEventListener("mousedown", (e) => { e.preventDefault(); const key = keyFrom(e.target); if (!key) return; downByKey.set("mouse", key); kbKeyDown(key); });
      window.addEventListener("mouseup", () => { const key = downByKey.get("mouse"); if (!key) return; downByKey.delete("mouse"); kbKeyUp(key); if (key.dataset.k === "bksp") kbStopRepeat(); });
    }
    input.addEventListener("focus", showKb); input.addEventListener("click", showKb);
    msgsEl.addEventListener("touchstart", hideKb, { passive: true }); msgsEl.addEventListener("mousedown", hideKb);
  }

  // ---------- voice (verbatim iOS-hardened connect) ----------
  const NUM_BARS = 12, DECAY = 0.85;
  // The waiting line under the bars (and along the pill's foot): what the voice waits on, until it speaks.
  let vWaitAt = 0, vBoxCalib: WaitCalib = {}, vCalibAsked = false;
  const vWaitTracker = new WaitTracker();
  function vWaitLine(now: number) {
    if (now - vWaitAt < 250) return;
    vWaitAt = now;
    if (!vCalibAsked) {
      vCalibAsked = true;
      api("/api/v1/brain/expect").then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && j.calib) vBoxCalib = j.calib; }).catch(() => {});
    }
    const t = Date.now();
    const { works, plan, samples } = waitInputs({ running: vWaitTools.length > 0, tools: vWaitTools, startedAt: streamStartedAt, subagents: (convMeta && convMeta.subagents) || [], todos: (convMeta && convMeta.todos) || [], messages: vWaitMsgs, now: t });
    const calib = calibFrom(samples, vBoxCalib);
    const view = vWaitTracker.update({ works, plan, calib, now: t, speaking: vAgentSpeaking });
    const a = $("vwait"), b = $("vpwait");
    if (a) renderWaitLine(a, view);
    if (b) renderWaitLine(b, view);
  }
  const vizEl = $("viz"), verrEl = $("verr"); const vBars = [];
  for (let i = 0; i < NUM_BARS; i++) { const b = document.createElement("div"); b.className = "vbar"; vizEl.appendChild(b); vBars.push(b); }
  let vConv = null, vConnecting = false, vRafId = 0, vLive = false, vAutoRetried = false, vMuted = false;
  const vSmoothed = new Array(NUM_BARS).fill(0);
  // Agent speaking window + level, mirrored from voice.html: `vAgentSpeaking`
  // follows the SDK's mode (onModeChange, worklet-playback-driven — flips false
  // only when the output buffer DRAINS), and the level replays a per-50ms RMS
  // envelope of the real chunks at wall-clock rate. Chunk ARRIVAL must never
  // drive the bars — the SDK bursts a whole turn into the buffer seconds ahead
  // of the audio the user hears, which is what desynced the wave (note 852e435b).
  let vMicCtx = null, vMicAnalyser = null, vMicBuf = null, vAgentSpeaking = false;
  const V_SLICE_MS = 50, V_SLICE_BYTES = (16000 * 2 * V_SLICE_MS) / 1000; // 16kHz mono PCM16
  const vAgentEnv = []; let vAgentEnvPos = 0, vAgentEnvClock = 0;
  function vAgentEnvReset() { vAgentEnv.length = 0; vAgentEnvPos = 0; vAgentEnvClock = 0; }
  function vAgentEnvPush(b64) {
    const s = atob(b64);
    for (let off = 0; off + 1 < s.length; off += V_SLICE_BYTES) {
      const end = Math.min(s.length, off + V_SLICE_BYTES);
      let sum = 0, count = 0;
      for (let i = off; i + 1 < end; i += 4) { let v = s.charCodeAt(i) | (s.charCodeAt(i + 1) << 8); if (v >= 32768) v -= 65536; sum += v * v; count++; }
      const rms = count ? Math.sqrt(sum / count) / 32768 : 0;
      vAgentEnv.push(Math.min(1, rms * 4));
    }
    const consumed = Math.floor(vAgentEnvPos);
    if (consumed > 400) { vAgentEnv.splice(0, consumed); vAgentEnvPos -= consumed; }
  }
  function vAgentEnvLevel() {
    const now = performance.now();
    const dt = vAgentEnvClock ? Math.min(now - vAgentEnvClock, 200) : 0;
    vAgentEnvClock = now;
    vAgentEnvPos += dt / V_SLICE_MS;
    if (!vAgentEnv.length) return 0;
    return vAgentEnv[Math.min(vAgentEnv.length - 1, Math.floor(vAgentEnvPos))];
  }
  const setVErr = (e) => { verrEl.textContent = e || ""; };
  const micAvailable = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  function vTeardownAudio() { try { if (vMicCtx) vMicCtx.close(); } catch {} vMicCtx = null; vMicAnalyser = null; vMicBuf = null; }
  function vBin(data, n) { const out = new Array(n).fill(0); if (!data || !data.length) return out; const per = Math.max(1, Math.floor(data.length / n)); for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < per; j++) s += data[i * per + j] || 0; out[i] = s / per / 255; } return out; }
  function vMeter() {
    if (!vLive) return;
    const speaking = vAgentSpeaking; let raw;
    try { if (speaking) { const lvl = vTransport === "webrtc" ? Math.min(1, ((vConv && vConv.getOutputVolume && vConv.getOutputVolume()) || 0) * 2.5) : vAgentEnvLevel(); raw = []; for (let i = 0; i < NUM_BARS; i++) { const shape = 0.55 + 0.45 * Math.sin((i / (NUM_BARS - 1)) * Math.PI); raw.push(lvl * shape); } } else if (vMicAnalyser) { vMicAnalyser.getByteFrequencyData(vMicBuf); raw = vBin(vMicBuf, NUM_BARS); } else { raw = vBin(vConv && vConv.getInputByteFrequencyData && vConv.getInputByteFrequencyData(), NUM_BARS); } } catch { raw = new Array(NUM_BARS).fill(0); }
    // [truth] Muted + not the agent's turn → flat bars (the SDK's meter reads zero
    // muted too; this keeps the UI from ever saying "you're being heard" when you aren't).
    if (vMuted && !speaking) raw = new Array(NUM_BARS).fill(0);
    // Nothing audible can play, or the inbound audio stalled mid-reply: flat (the hint says why) — never waves over silence.
    if (vAudioWarn || (vPlayback && vPlayback.stalled)) raw = new Array(NUM_BARS).fill(0);
    for (let i = 0; i < NUM_BARS; i++) { const decayed = vSmoothed[i] * DECAY; vSmoothed[i] = raw[i] > decayed ? raw[i] : decayed; const h = 0.16 + Math.min(1, vSmoothed[i]) * 0.84; vBars[i].style.transform = `scaleY(${h.toFixed(3)})`; }
    vWaitLine(performance.now());
    vRafId = requestAnimationFrame(vMeter);
  }
  // Voice is the front of house of the open chat (D3, server/voice.ts): its one tool that acts, Ask, is a request
  // to that chat's agent, sent after the lines before it (so the agent reads Carl's words first). The phone has no
  // screen tools (the box's prompt says so).
  function vClientTools(toolNames) { const tools = {}; for (const name of toolNames || []) { tools[name] = async (params) => { try { await vLines; const r = await api("/api/v1/voice/tool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, args: params || {}, convId: vVoiceConv, device: "phone", ...(vSessionId ? { sessionId: vSessionId } : {}) }) }); const j = await r.json(); if (j && typeof j.convId === "string" && j.convId) vVoiceConv = j.convId; return typeof j.result === "string" ? j.result : "Error: " + (j.error || r.status) + ". Nothing was done."; } catch (e) { return "Error: the box did not take it (" + String(e) + "). Nothing was done."; } }; } return tools; }
  // The call's lines go into the open chat on the box (POST /api/v1/voice/transcript), in order, one at a time;
  // with no chat open, the first line makes one and the rest go on there.
  let vVoiceConv: string | null = null, vLines: Promise<unknown> = Promise.resolve();
  // This call's id on the box (one voice at a time: its lines, tools and polls carry it; the box says when another device took over).
  let vSessionId: string | null = null;
  function vSaveLine(role: string, text: string, end = false) {
    vLines = vLines.then(async () => {
      try {
        // `end`: the session is over — the box stops counting it as busy (its updater waits for that); no line is saved when nothing was said.
        const r = await api("/api/v1/voice/transcript", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ convId: vVoiceConv, role, text, device: "phone", ...(vSessionId ? { sessionId: vSessionId } : {}), ...(end ? { system: true, ended: true } : {}) }) });
        const j = await r.json();
        if (j && typeof j.convId === "string" && j.convId && !end) vVoiceConv = j.convId;
      } catch {}
    });
  }
  // The agent's answers and what Carl did elsewhere, into the live call, held while the voice speaks.
  const vGate = new QuietGate(() => vAgentSpeaking);
  const vPusher = new VoiceImagePusher();
  let vUpdates: VoiceUpdates | null = null;
  function vStartUpdates(conv, cursor) {
    if (vUpdates) vUpdates.stop();
    vUpdates = new VoiceUpdates({
      cursor,
      gate: vGate,
      conv: () => (vConv === conv ? conv : null),
      // An answer he is waiting for waits until he isn't mid-sentence.
      userSpeaking: () => { try { return !vMuted && (conv.getInputVolume?.() ?? 0) >= SPEECH_LEVEL; } catch { return false; } },
      fetch: async (cur) => {
        await vLines;
        if (!vVoiceConv) { await new Promise((res) => setTimeout(res, 1000)); return { updates: [], cursor: cur || "" }; }
        const r = await api("/api/v1/voice/updates?convId=" + encodeURIComponent(vVoiceConv) + "&wait=20000" + (cur ? "&cursor=" + encodeURIComponent(cur) : "") + (vSessionId ? "&session=" + encodeURIComponent(vSessionId) : ""));
        if (!r.ok) throw new Error("updates " + r.status);
        return r.json();
      },
      // Voice moved to another device (one voice at a time): this call ends now and says where it went.
      onMoved: (m) => { if (vConv === conv) vMovedAway(m.line); },
    }).start();
  }
  function vMovedAway(line: string) {
    // No end line: the box already said it in the thread ("Voice moved from the phone to the laptop.").
    vLive = false;
    const c = vConv;
    try { if (c) c.endSession(); } catch {}
    vTeardown();
    toast(line);
  }
  let vTransport: "webrtc" | "websocket" = "webrtc";
  // The call's mic and output, pinned to the physical devices behind a virtual "default" (Android Chrome lists
  // them; iOS Safari lists none, so there nothing is pinned): the system flipping its default mid-call no longer
  // moves or ends the call; unplugged, the best remaining one (src/voiceMic.ts). Every devicechange is logged with
  // both lists, the contexts and what the waves draw; the inbound audio's stats per reply and every dropout too
  // (src/voiceStats.ts), so "the voice is gone, then glitches back" is network or local in the log.
  // Every voice line to the box too (src/voiceShip.ts → <state>/logs/voice.jsonl), batched, on call end and page hide.
  const vShip = new VoiceLogShipper({ device: "phone" });
  vShip.post = async (body, keepalive) => { const r = await api("/api/v1/board/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive }); if (!r.ok) throw new Error("log " + r.status); };
  vShip.installPageHide();
  const vLog = (ev, d) => { logEvent(ev.replace(/ /g, "_"), d); vShip.add(ev, d); };
  const vMicPin = new MicPin({ list: listAudioDevices, log: vLog });
  const vOutPin = new MicPin({ list: listAudioDevices, log: vLog, kind: "audiooutput" });
  let vOutputLost = false, vAudioWarn = "", vPlayback = null, vUnwatch = [];
  function vParts(c) {
    const room = (c && c.connection && c.connection.getRoom && c.connection.getRoom()) || null;
    const contexts = [c && c.input && c.input.context, c && c.output && c.output.context, vMicCtx].filter((x) => x && typeof x.state === "string");
    return { room, contexts: [...new Set(contexts)] };
  }
  function vLocal(c) { return { contexts: vParts(c).contexts.map((x) => x.state), outputDevice: (vOutPin.pinned && vOutPin.pinned.label) || "system default", outputLost: vOutputLost }; }
  function vCheckAudio(c) {
    if (vConv !== c) return;
    const { room, contexts } = vParts(c);
    const why = audioBlocked({ speaking: vAgentSpeaking, contexts: contexts.map((x) => x.state), canPlay: room ? room.canPlaybackAudio : null, outputLost: vOutputLost }) || "";
    if (why === vAudioWarn) return;
    vLog(why ? "voice audio blocked" : "voice audio unblocked", { why: why || null, ...vLocal(c) });
    vAudioWarn = why;
    document.body.classList.toggle("vaudiowarn", !!why);
    const vh = $("vhint"); if (vh) vh.textContent = why ? AUDIO_WARN_LINE : vMuted ? "Muted — tap the mic to talk" : "";
  }
  async function vReconnectAudio() {
    const c = vConv; if (!c) return;
    const { room, contexts } = vParts(c);
    vLog("voice audio reconnect", vLocal(c));
    if (room && room.startAudio) await room.startAudio().catch(() => {});
    for (const x of contexts) if (x.state !== "running" && x.state !== "closed") await x.resume().catch(() => {});
    if (c.changeOutputDevice && (vOutPin.pinned || vOutputLost)) { try { await c.changeOutputDevice({ outputDeviceId: await vOutPin.target() }); vOutputLost = false; } catch {} }
    vCheckAudio(c);
  }
  { const vh = $("vhint"); if (vh) vh.addEventListener("click", () => { if (vAudioWarn) void vReconnectAudio(); }); }
  function vUnwatchAll() { for (const f of vUnwatch.splice(0)) { try { f(); } catch {} } if (vPlayback) { vPlayback.stop(); vPlayback = null; } }
  function vWatchDevices(c) {
    vUnwatchAll();
    const md = navigator.mediaDevices;
    if (md && md.addEventListener) {
      const on = async () => {
        if (vConv !== c) return;
        const listed = await vMicPin.devices(); const devs = listed || [];
        let lv = {}; try { lv = { inputLevel: +(c.getInputVolume() || 0).toFixed(3), outputLevel: +(c.getOutputVolume() || 0).toFixed(3) }; } catch {}
        vLog("voice devices changed", { ...deviceLists(devs), mic: (vMicPin.pinned && vMicPin.pinned.label) || null, micStillThere: vMicPin.pinned ? vMicPin.present(devs) : null, outputDevice: (vOutPin.pinned && vOutPin.pinned.label) || null, outputStillThere: vOutPin.pinned ? vOutPin.present(devs) : null, contexts: vLocal(c).contexts, waves: vAgentSpeaking ? "output" : "input", ...lv });
        if (!listed || vConv !== c) return;
        if (c.changeOutputDevice) { const o = await vOutPin.devicesChanged(devs, (id) => c.changeOutputDevice({ outputDeviceId: id })); vOutputLost = o === "lost" || o === "failed"; }
        if (c.changeInputDevice && vConv === c) await vMicPin.devicesChanged(devs, (id) => c.changeInputDevice({ inputDeviceId: id }));
      };
      const h = () => void on();
      md.addEventListener("devicechange", h);
      vUnwatch.push(() => md.removeEventListener("devicechange", h));
    }
    for (const ctx of vParts(c).contexts) { const on = () => vLog("voice audio context", { state: ctx.state, speaking: vAgentSpeaking }); ctx.addEventListener("statechange", on); vUnwatch.push(() => ctx.removeEventListener("statechange", on)); }
    const sess = (navigator as any).audioSession;
    if (sess) { vLog("voice audio session", { type: sess.type || null, state: sess.state || null }); const on = () => vLog("voice audio session", { type: sess.type || null, state: sess.state || null, speaking: vAgentSpeaking }); if (sess.addEventListener) { sess.addEventListener("statechange", on); vUnwatch.push(() => sess.removeEventListener("statechange", on)); } }
    // A suspended context comes back on the next touch (iOS resumes audio only in a gesture).
    const touch = () => { if (vConv !== c) return; const stuck = vParts(c).contexts.filter((x) => x.state === "suspended" || x.state === "interrupted"); if (!stuck.length) return; vLog("voice audio resume", { on: "touch", contexts: stuck.map((x) => x.state) }); for (const x of stuck) x.resume().catch(() => {}); const r = vParts(c).room; if (r && r.startAudio) r.startAudio().catch(() => {}); };
    document.addEventListener("pointerdown", touch, true);
    vUnwatch.push(() => document.removeEventListener("pointerdown", touch, true));
    vPlayback = new PlaybackMonitor({ stats: () => roomAudioStats(vParts(c).room), speaking: () => vConv === c && vAgentSpeaking, local: () => vLocal(c), log: vLog }).start();
    const chk = setInterval(() => vCheckAudio(c), 250);
    vUnwatch.push(() => clearInterval(chk));
  }
  async function vStart() {
    if (vConnecting || vConv) return;
    if (!micAvailable()) { setVErr("This page isn't HTTPS, so the browser blocks the mic. Open the https://…ts.net link from Settings → Phone."); return; }
    vConnecting = true; setVErr(""); document.body.classList.add("vconnecting");
    vVoiceConv = convId || null;
    try {
      // The mic permission, asked on the tap; then let go: the SDK opens the ONE
      // stream the call sends, and the waves read its meter (a second stream of
      // ours could leave iOS capturing one and muting the other).
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of micStream.getTracks()) t.stop();
      // Settings → Voice engine "New": the voice IS the conversation's agent (the box hears and speaks; pi answers).
      {
        const er = await api("/api/v1/brain/engine").catch(() => null);
        const eng = er && er.ok ? await er.json().catch(() => null) : null;
        if (eng && eng.engine === "new") { await vStartBrain(); return; }
      }
      let cfg = null;
      let sessErr = "";
      for (let a = 0; a < 6; a++) {
        try { const r = await api("/api/v1/voice/session?device=phone" + (vVoiceConv ? "&convId=" + encodeURIComponent(vVoiceConv) : "")); if (r.ok) { cfg = await r.json(); break; } sessErr = `session ${r.status}: ${(await r.text()).slice(0, 200)}`; }
        catch (e) { sessErr = String((e && e.message) || e); }
        // Retry ANY failure (502 transient mint, network blip, 503 not-ready), not
        // just 503 — a single stray error used to kill the whole start. Backoff.
        if (a < 5) { await new Promise((res) => setTimeout(res, 700 * (a + 1))); continue; }
        throw new Error(sessErr || "session not ready");
      }
      if (!cfg) throw new Error("session not ready");
      vSessionId = cfg.sessionId || null;
      if (cfg.convId) vVoiceConv = cfg.convId;
      // @ts-ignore — URL import; the browser resolves it at runtime
      const sdk = (await sdkPromise) || (await import("@elevenlabs/client")); const { Conversation } = sdk;
      let timedOut = false, watchdog = 0;
      // The mic was allowed in this tap: device ids are readable, the call opens on the pinned one.
      const vListed = await vMicPin.devices();
      let vMicId = await vMicPin.atStart(vListed);
      let vOutId = canPickOutput() ? await vOutPin.atStart(vListed) : (vOutPin.reset(), undefined);
      // WebRTC (ElevenLabs' recommended transport: echo cancellation, jitter buffer) with
      // the box's conversation token; WebSocket with the signed URL when there's no token
      // or WebRTC can't connect.
      vTransport = cfg.conversationToken ? "webrtc" : "websocket";
      const openOnce = () => Conversation.startSession({
        ...(vTransport === "webrtc" ? { conversationToken: cfg.conversationToken, connectionType: "webrtc" } : { signedUrl: cfg.signedUrl, connectionType: "websocket" }),
        ...(vMicId ? { inputDeviceId: vMicId } : {}),
        ...(vOutId ? { outputDeviceId: vOutId } : {}),
        overrides: { agent: { prompt: { prompt: cfg.systemPrompt || "" }, language: "en", firstMessage: "" }, tts: { voiceId: cfg.voiceId } },
        dynamicVariables: cfg.dynamicVariables || {}, clientTools: vClientTools(cfg.toolNames),
        onConnect: () => { if (timedOut) return; vConnecting = false; vAutoRetried = false; vLive = true; document.body.classList.remove("vconnecting"); vMeter(); },
        onDisconnect: (d) => { vLog("voice closed", { transport: vTransport, reason: d && d.reason, message: d && d.message, closeCode: d && (d.closeCode ?? (d.context && d.context.code)), closeReason: d && (d.closeReason ?? (d.context && d.context.reason)) }); if (d && d.reason !== "user") console.warn("[voice] closed", vTransport, JSON.stringify({ reason: d.reason, message: d.message, code: d.closeCode ?? (d.context && d.context.code), why: d.closeReason ?? (d.context && d.context.reason) })); if (!timedOut) vTeardown(); },
        onError: (m) => setVErr(typeof m === "string" ? m : (m && m.message) || "voice error"),
        onAudio: (b64) => { if (vTransport === "websocket") try { vAgentEnvPush(b64); } catch {} },
        onMessage: ({ message, role }) => { const raw = (message || "").trim(); if (role === "user" && isControlLine(raw)) return; /* the box's own [vc:result] updates: not Carl's */ const text = role === "user" ? raw : stripAudioTags(raw); if (role !== "user" && isFillerLine(text)) return; /* spoken, never written */ if (text) vSaveLine(role === "user" ? "user" : "assistant", text); },
        // Mode leaving "speaking" = the playback buffer drained (or barge-in) —
        // everything that arrived was heard, so drop the queued envelope tail.
        onModeChange: ({ mode }) => { vAgentSpeaking = mode === "speaking"; if (!vAgentSpeaking) vAgentEnvReset(); vGate.modeChanged(); },
      });
      // The pinned device refused (gone since the listing): the system default.
      const open = () => openOnce().catch((e) => {
        if (!vMicId || timedOut || !/NotFound|NotReadable|Overconstrained/i.test(String(e && e.name) + " " + String(e && e.message))) throw e;
        logEvent("voice_mic_pin_failed", { error: String((e && e.message) || e).slice(0, 300) });
        vMicPin.reset(); vOutPin.reset(); vMicId = undefined; vOutId = undefined;
        return openOnce();
      });
      const sessionPromise = open().catch((e) => {
        if (vTransport !== "webrtc" || !cfg.signedUrl || timedOut || /NotAllowed|NotFound|NotReadable|Permission/i.test(String(e && e.name) + String(e && e.message))) throw e;
        console.warn("[voice] WebRTC failed, retrying over WebSocket:", String((e && e.message) || e));
        vTransport = "websocket";
        return open();
      });
      sessionPromise.then((c) => { clearTimeout(watchdog); if (timedOut && c) { try { c.endSession(); } catch {} } }).catch(() => clearTimeout(watchdog));
      vConv = await Promise.race([sessionPromise, new Promise((_, rej) => { watchdog = setTimeout(() => { timedOut = true; rej(new Error("connect timed out after 15s")); }, 15000); })]);
      clearTimeout(watchdog);
      if (cfg.convId) vVoiceConv = cfg.convId;
      vWatchDevices(vConv);
      // The chat's newest images (the box sends them with the session): this call has never seen them.
      { const c = vConv; vPusher.reset(); void pushStartImages(c, vPusher, cfg.images, () => vConv === c).catch(() => {}); vStartUpdates(c, cfg.cursor || null); }
    } catch (e) {
      vConnecting = false; vTeardownAudio(); document.body.classList.remove("vconnecting");
      if (!vAutoRetried) { vAutoRetried = true; setTimeout(() => { try { if (vMicCtx && vMicCtx.state === "suspended") vMicCtx.resume().catch(() => {}); } catch {} vStart(); }, 800); return; }
      setVErr(String((e && e.message) || e));
    }
  }
  /** The New voice's call: the phone is the mic and the speaker; its lines are the conversation's turns on the box. */
  async function vStartBrain() {
    const cid = vVoiceConv || MAIN_ID; // no chat open: the one main conversation
    vVoiceConv = cid;
    vSessionId = null;
    const post = async (path: string, body: Record<string, unknown>) => {
      const r = await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      return j;
    };
    const vListed = await vMicPin.devices();
    const vMicId = await vMicPin.atStart(vListed);
    const vOutId = canPickOutput() ? await vOutPin.atStart(vListed) : (vOutPin.reset(), undefined);
    vTransport = "webrtc";
    vConv = await BrainConversation.start({
      post,
      convId: cid,
      device: "phone",
      ...(vMicId ? { inputDeviceId: vMicId } : {}),
      ...(vOutId ? { outputDeviceId: vOutId } : {}),
      log: (ev, d) => vLog(ev, d),
      onConnect: () => { vConnecting = false; vAutoRetried = false; vLive = true; document.body.classList.remove("vconnecting"); vMeter(); },
      onMode: (m) => { vAgentSpeaking = m === "speaking"; },
      onDisconnect: (d) => { vLog("voice closed", { transport: "brain", reason: d.reason, message: d.message }); vTeardown(); },
    });
  }
  function vTeardown() { vUnwatchAll(); void vShip.flush(); vMicPin.reset(); vOutPin.reset(); vOutputLost = false; vAudioWarn = ""; document.body.classList.remove("vaudiowarn"); if (vLive && !(vConv instanceof BrainConversation)) vSaveLine("assistant", "Voice session ended.", true); if (vUpdates) { vUpdates.stop(); vUpdates = null; } vGate.reset(); vLive = false; cancelAnimationFrame(vRafId); vRafId = 0; vTeardownAudio(); vAutoRetried = false; vAgentSpeaking = false; vAgentEnvReset(); vSmoothed.fill(0); for (const b of vBars) b.style.transform = "scaleY(.16)"; document.body.classList.remove("voice", "voicemin", "vconnecting", "vmicmuted"); vMuted = false; { const vh = $("vhint"); if (vh) vh.textContent = ""; } vConv = null; vConnecting = false; }
  async function vStop() { try { if (vConv) await vConv.endSession(); } catch {} vTeardown(); }
  $("voiceRow").onclick = () => {
    closeMenu();
    if (vLive || vConnecting) { document.body.classList.add("voice"); document.body.classList.remove("voicemin"); return; }
    try { vMicCtx = vMicCtx || new (window.AudioContext || window.webkitAudioContext!)(); if (vMicCtx.state === "suspended") vMicCtx.resume().catch(() => {}); const b = vMicCtx.createBuffer(1, 1, 22050); const s = vMicCtx.createBufferSource(); s.buffer = b; s.connect(vMicCtx.destination); s.start(0); } catch {}
    hideKb(); document.body.classList.add("voice"); document.body.classList.remove("voicemin"); vStart();
  };
  // Mute is the SDK's own (no audio leaves the phone; the voice can still speak a result), and plain to see.
  function vSetMute(m) { vMuted = m; document.body.classList.toggle("vmicmuted", m); const vh = $("vhint"); if (vh) vh.textContent = m ? "Muted — tap the mic to talk" : ""; const mb = $("vMuteBtn"); if (mb) { mb.setAttribute("aria-pressed", String(m)); mb.setAttribute("aria-label", m ? "unmute mic" : "mute mic"); } if (vConv) try { vConv.setMicMuted(m); } catch {} }
  $("vMuteBtn").onclick = () => vSetMute(!vMuted);
  $("vEndBtn").onclick = vStop;
  $("vMinBtn").onclick = () => { if (vLive || vConnecting) { document.body.classList.add("voicemin"); document.body.classList.remove("voice"); } else vStop(); };
  $("vpill").onclick = () => { document.body.classList.add("voice"); document.body.classList.remove("voicemin"); };

  // ---------- lifecycle ----------
  // A visit ends when the app has been out of sight this long (a quick look at another app is the
  // same visit). Coming back starts a new one, on Main — unless a push he tapped is taking him to
  // its thread, or a voice call is running in the thread he is in.
  const VISIT_GAP_MS = 60_000;
  let hiddenAt = 0, deepLinkAt = 0;
  function backToMain() {
    if (convId === MAIN_ID || vLive || vConnecting) return;
    if (Date.now() - deepLinkAt < 5000) return; // a tapped push is opening its own thread
    logEvent("visit_main", { from: convId });
    closeMenu();
    void openThread(MAIN_ID, MAIN_TITLE);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt >= VISIT_GAP_MS) setTimeout(backToMain, 400);
    hiddenAt = 0;
    void pollLoop(); void refreshState(); void refreshBadge(); void refreshConvMeta(); if (page === "alerts") softReload(loadAlerts);
  });
  // Whether Carl is looking at the phone (the app on screen): the box keeps the phone quiet meanwhile (server/pushGate.ts).
  attention = startAttentionBeat({ device: "phone", convId: () => convId, post: (b) => (MOCK ? undefined : api("/api/v1/attention", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), keepalive: true })) });
  // Touching a list at all marks it briefly busy, so a background tick can't
  // rebuild it (scroll → top) while you're reading or reaching for a card.
  ["alScroll", "notesScroll"].forEach((id) => { const s = $(id); if (s) s.addEventListener("touchstart", () => markListBusy(2500), { passive: true }); });
  if (window.visualViewport) {
    const vv = window.visualViewport;
    // Keyboard handling. --kb is the height the composer must rise to sit on top of
    // the keyboard; the composer's padding-bottom and the .sheet transform consume
    // it. Re-applied on scroll too because iOS shifts the viewport as the keyboard
    // animates. The shell height itself is CSS-only (100lvh in standalone) — never
    // JS-controlled — so nothing here can strand the old dead strip.
    const applyKb = () => {
      // kbRaw: keyboard height measured against documentElement.clientHeight, the
      // stable layout viewport that equals vv.height at rest — so this reads ~0 with
      // no keyboard and is the reliable "is the keyboard up?" signal.
      const kbRaw = Math.max(0, document.documentElement.clientHeight - vv.height - vv.offsetTop);
      const up = kbRaw > 60;
      // Keyboard up: collapse the composer's home-indicator inset so the textbox
      // sits flush on the keyboard (the keyboard already covers that strip).
      document.body.classList.toggle("kbup", up);
      // The body is sized to the FULL screen (100lvh in standalone), which is taller
      // than clientHeight's layout viewport by the safe-area-top band iOS excludes
      // (measured: 874 vs 812 = 62px on a Dynamic Island phone). kbRaw is computed in
      // the shorter clientHeight space, so the composer landed ~62px BEHIND the
      // keyboard. Add that band back. It is 0 in a browser tab (body == 100dvh ==
      // clientHeight), so Safari is unaffected.
      const safeBand = Math.max(0, document.body.offsetHeight - document.documentElement.clientHeight);
      document.documentElement.style.setProperty("--kb", (up ? kbRaw + safeBand : 0) + "px");
      // The sheet is NOT resized or lifted on keyboard-open — `.sheet.editing`
      // reserves --kb as inside padding, so its top stays fixed while only the
      // pinned composer rides above the keyboard (see sheetEditFocus). Nothing to
      // do here but keep --kb current, which the line above already did.
    };
    const fit = () => { applyKb(); window.scrollTo(0, 0); scrollDown(false); };
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", () => { window.scrollTo(0, 0); applyKb(); });
    fit(); // reconcile the initial geometry so a short launch viewport can't strand a strip
  }

  // A push tapped while the app is already OPEN (iOS keeps the PWA backgrounded,
  // not closed — the common case) can't be navigated from the service worker, so
  // the SW postMessages the deep-link and we route in place to the asking thread.
  // Without this a "Needs you" tap just re-focuses whatever chat you had open
  // last — the wrong-conversation bug. Mirrors the ?conv= boot path below.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      const d = (e && e.data) || {};
      if (d.type !== "deeplink" || !d.url) return;
      deepLinkAt = Date.now();
      try {
        const p = new URLSearchParams(String(d.url).split("?")[1] || "");
        // [ask redesign] An ask push deep-links to the ask surface (?ask=), not
        // to the mission thread — the main composer must never get silently
        // re-bound to a mission by a notification tap (spillover vector B3).
        const aid = p.get("ask");
        if (aid) { void openAskById(aid); return; }
        const cid = p.get("conv");
        // A push from another of the box's vaults: open the page on that vault.
        if (cid && (p.get("vault") || "") !== VAULT && !(VAULT && !p.get("vault") && vaultIsMain)) { location.replace(String(d.url)); return; }
        if (cid) void openThread(cid);
      } catch {}
    });
  }

  // An older ask push (?ask=<notification id>) opens the asking conversation.
  async function openAskById(nid) {
    try {
      const d = await (await api("/notifications")).json();
      lastNotifList = d.notifications || [];
      const n = lastNotifList.find((x) => x.id === nid);
      if (n && n.convId) void openThread(n.convId);
      else { setPage("alerts"); void loadAlerts(); }
    } catch {}
  }

  // The scroll fade is a scrolling AFFORDANCE — per edge, and only when content
  // is actually cut off on that edge. At rest (scrollTop 0) the first line is
  // fully readable; the top fade appears only once you scroll down.
  const fadeWatch = () => {
    document.querySelectorAll("#msgs,.scroll,.clist,.sheet-body").forEach((sc) => {
      const can = sc.scrollHeight > sc.clientHeight + 4;
      sc.classList.toggle("fade-top", can && sc.scrollTop > 4);
      sc.classList.toggle("fade-bot", can && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 4);
    });
  };
  new MutationObserver(fadeWatch).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", fadeWatch);
  // scroll doesn't bubble — capture phase catches every scrollable surface.
  document.addEventListener("scroll", fadeWatch, true);
  setInterval(fadeWatch, 1200);
  fadeWatch();

  showHint();
  setHeader();
  void loadProjects();
  // A tapped push notification deep-links to the ASKING thread via ?conv=<id>
  // (from the push url, when the app was launched cold). It MUST win over the
  // sticky last-thread restore below — otherwise the tap lands you on whatever
  // chat you had open last, not the one waiting on your call.
  const bootAsk = qs.get("ask");
  const bootConv = qs.get("conv");
  if (bootAsk) {
    // [ask redesign] Cold-launch from an ask push: open the ask surface, never
    // a thread — the main composer keeps whatever chat it had.
    void openAskById(bootAsk);
  } else if (bootConv) {
    void openThread(bootConv);
  } else {
    // Main, every surface's default (src/threads.ts) — and the phone's on every open.
    void openThread(MAIN_ID, MAIN_TITLE);
  }
  // A push's deep link is for this open only: a reload (an update) must not land on that thread again.
  if (bootConv || bootAsk) { try { const u = new URL(location.href); u.searchParams.delete("conv"); u.searchParams.delete("ask"); history.replaceState(history.state, "", u.pathname + u.search + u.hash); } catch {} }
  void refreshState();
  void refreshBadge();
  void pollLoop();
  setInterval(() => { void refreshState(); }, 45000);
}
